use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::thread;

use tauri::Emitter;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct DockerStatus {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct DiskUsageRow {
    pub r#type: String,
    pub total: u32,
    pub active: u32,
    pub size: String,
    pub reclaimable: String,
}

#[derive(serde::Serialize, Clone)]
pub struct DockerSystemDf {
    pub images: DiskUsageRow,
    pub containers: DiskUsageRow,
    pub volumes: DiskUsageRow,
    pub build_cache: DiskUsageRow,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub size_bytes: u64,
    pub created_since: String,
    pub age_days: i64,
    pub in_use: bool,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created_since: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub in_use: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct PrunePreview {
    pub level: u8,
    pub command: String,
    pub image_ids: Vec<String>,
    pub image_names: Vec<String>,
    pub reclaim_bytes: u64,
    pub reclaim_size: String,
    pub container_count: u32,
    pub volume_count: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — parsing
// ─────────────────────────────────────────────────────────────────────────────

/// Split a `docker system df` row on 2+ consecutive spaces so multi-word
/// type names ("Local Volumes", "Build Cache") and "1.23GB (72%)" stay intact.
fn split_df_line(line: &str) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    let mut col = String::new();
    let mut run: usize = 0;

    for ch in line.chars() {
        if ch == ' ' {
            run += 1;
            if run == 1 {
                col.push(ch);
            }
        } else {
            if run >= 2 {
                let s = col.trim().to_string();
                if !s.is_empty() {
                    cols.push(s);
                }
                col = String::new();
            }
            run = 0;
            col.push(ch);
        }
    }
    let s = col.trim().to_string();
    if !s.is_empty() {
        cols.push(s);
    }
    cols
}

fn parse_system_df(output: &str) -> Result<DockerSystemDf, String> {
    let lines: Vec<&str> = output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();

    if lines.len() < 5 {
        return Err(format!(
            "Unexpected docker system df output ({} lines):\n{}",
            lines.len(),
            output
        ));
    }

    let parse_row = |line: &str| -> Result<DiskUsageRow, String> {
        let cols = split_df_line(line);
        if cols.len() < 5 {
            return Err(format!("Cannot parse row: {:?}", line));
        }
        Ok(DiskUsageRow {
            r#type: cols[0].clone(),
            total: cols[1].parse().unwrap_or(0),
            active: cols[2].parse().unwrap_or(0),
            size: cols[3].clone(),
            reclaimable: cols[4].clone(),
        })
    };

    Ok(DockerSystemDf {
        images: parse_row(lines[1])?,
        containers: parse_row(lines[2])?,
        volumes: parse_row(lines[3])?,
        build_cache: parse_row(lines[4])?,
    })
}

/// Parse Docker size strings like "2.54GB", "187MB", "145.3kB", "0B" → bytes.
fn parse_size_bytes(size: &str) -> u64 {
    let s = size.trim();
    if let Some(n) = s.strip_suffix("GB") {
        (n.trim().parse::<f64>().unwrap_or(0.0) * 1_000_000_000.0) as u64
    } else if let Some(n) = s.strip_suffix("MB") {
        (n.trim().parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as u64
    } else if let Some(n) = s.strip_suffix("kB") {
        (n.trim().parse::<f64>().unwrap_or(0.0) * 1_000.0) as u64
    } else if let Some(n) = s.strip_suffix('B') {
        n.trim().parse::<u64>().unwrap_or(0)
    } else {
        0
    }
}

fn bytes_to_human(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        format!("{:.2} GB", bytes as f64 / 1_000_000_000.0)
    } else if bytes >= 1_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    } else if bytes >= 1_000 {
        format!("{:.0} kB", bytes as f64 / 1_000.0)
    } else {
        format!("{} B", bytes)
    }
}

/// Approximate days from Docker's human-readable "CreatedSince" field
/// e.g. "3 weeks ago" → 21, "2 months ago" → 60.
fn parse_age_days(created_since: &str) -> i64 {
    let s = created_since.to_lowercase();
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.len() < 2 {
        return 0;
    }
    let n = words[0].parse::<i64>().unwrap_or(1);
    match words[1] {
        u if u.starts_with("second") || u.starts_with("minute") || u.starts_with("hour") => 0,
        u if u.starts_with("day") => n,
        u if u.starts_with("week") => n * 7,
        u if u.starts_with("month") => n * 30,
        u if u.starts_with("year") => n * 365,
        _ => 0,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — data fetching (sync, called from async commands via spawn_blocking)
// ─────────────────────────────────────────────────────────────────────────────

fn get_all_images_sync() -> Result<Vec<DockerImage>, String> {
    let output = Command::new("docker")
        .args(["images", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let used_names = get_container_image_names_sync();
    let mut images = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("JSON parse error: {}", e))?;

        let id = v["ID"].as_str().unwrap_or("").to_string();
        let repository = v["Repository"].as_str().unwrap_or("<none>").to_string();
        let tag = v["Tag"].as_str().unwrap_or("<none>").to_string();
        let size = v["Size"].as_str().unwrap_or("0B").to_string();
        let size_bytes = parse_size_bytes(&size);
        let created_since = v["CreatedSince"].as_str().unwrap_or("").to_string();
        let age_days = parse_age_days(&created_since);

        let name_tag = format!("{}:{}", repository, tag);
        let in_use = used_names.contains(&name_tag) || used_names.contains(&repository);

        images.push(DockerImage {
            id,
            repository,
            tag,
            size,
            size_bytes,
            created_since,
            age_days,
            in_use,
        });
    }

    Ok(images)
}

fn get_container_image_names_sync() -> HashSet<String> {
    Command::new("docker")
        .args(["ps", "-a", "--format", "{{.Image}}"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn count_stopped_containers_sync() -> u32 {
    Command::new("docker")
        .args(["ps", "-aq", "-f", "status=exited"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        })
        .unwrap_or(0)
}

fn count_unused_volumes_sync() -> u32 {
    Command::new("docker")
        .args(["volume", "ls", "-qf", "dangling=true"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        })
        .unwrap_or(0)
}

/// Run a command and stream each stdout/stderr line as a "docker-log" event.
fn run_streaming_sync(app: &tauri::AppHandle, mut cmd: Command) -> Result<(), String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start: {}", e))?;

    let stdout_app = app.clone();
    let stdout_handle = child.stdout.take().map(|out| {
        thread::spawn(move || {
            BufReader::new(out).lines().flatten().for_each(|line| {
                stdout_app.emit("docker-log", &line).ok();
            });
        })
    });

    let stderr_app = app.clone();
    let stderr_handle = child.stderr.take().map(|err| {
        thread::spawn(move || {
            BufReader::new(err).lines().flatten().for_each(|line| {
                if !line.trim().is_empty() {
                    stderr_app.emit("docker-log", format!("[err] {}", line)).ok();
                }
            });
        })
    });

    child.wait().map_err(|e| e.to_string())?;
    if let Some(h) = stdout_handle {
        h.join().ok();
    }
    if let Some(h) = stderr_handle {
        h.join().ok();
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands — Phase 1
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn docker_check() -> DockerStatus {
    let result = Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output();

    match result {
        Ok(o) if o.status.success() => {
            let version = String::from_utf8_lossy(&o.stdout).trim().to_string();
            DockerStatus {
                available: true,
                version: if version.is_empty() { None } else { Some(version) },
                error: None,
            }
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            DockerStatus {
                available: false,
                version: None,
                error: Some(if err.is_empty() {
                    "Docker daemon is not running".to_string()
                } else {
                    err
                }),
            }
        }
        Err(e) => DockerStatus {
            available: false,
            version: None,
            error: Some(format!("docker not found: {}", e)),
        },
    }
}

#[tauri::command]
pub async fn docker_system_df() -> Result<DockerSystemDf, String> {
    let output = Command::new("docker")
        .args(["system", "df"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    parse_system_df(&String::from_utf8_lossy(&output.stdout))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands — Phase 2
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn docker_images() -> Result<Vec<DockerImage>, String> {
    tauri::async_runtime::spawn_blocking(get_all_images_sync)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_prune_preview(
    level: u8,
    keep_list: Vec<String>,
) -> Result<PrunePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let images = get_all_images_sync()?;

        let unused_not_kept: Vec<&DockerImage> = images
            .iter()
            .filter(|img| !img.in_use && !keep_list.contains(&img.id))
            .collect();

        match level {
            1 => {
                // Dangling (untagged) images only
                let dangling: Vec<&DockerImage> = unused_not_kept
                    .iter()
                    .copied()
                    .filter(|img| img.repository == "<none>" && img.tag == "<none>")
                    .collect();

                let reclaim_bytes: u64 = dangling.iter().map(|i| i.size_bytes).sum();
                let ids: Vec<String> = dangling.iter().map(|i| i.id.clone()).collect();
                let names: Vec<String> = dangling
                    .iter()
                    .map(|i| format!("{}:{}", i.repository, i.tag))
                    .collect();

                Ok(PrunePreview {
                    level: 1,
                    command: "docker image prune -f".to_string(),
                    image_ids: ids,
                    image_names: names,
                    reclaim_bytes,
                    reclaim_size: bytes_to_human(reclaim_bytes),
                    container_count: 0,
                    volume_count: 0,
                })
            }

            2 => {
                // All unused images not in keep-list
                let reclaim_bytes: u64 = unused_not_kept.iter().map(|i| i.size_bytes).sum();
                let ids: Vec<String> = unused_not_kept.iter().map(|i| i.id.clone()).collect();
                let names: Vec<String> = unused_not_kept
                    .iter()
                    .map(|i| format!("{}:{}", i.repository, i.tag))
                    .collect();

                let command = if ids.is_empty() {
                    "# Nothing to remove".to_string()
                } else {
                    format!("docker rmi {}", ids.join(" "))
                };

                Ok(PrunePreview {
                    level: 2,
                    command,
                    image_ids: ids,
                    image_names: names,
                    reclaim_bytes,
                    reclaim_size: bytes_to_human(reclaim_bytes),
                    container_count: 0,
                    volume_count: 0,
                })
            }

            3 => {
                // Level 2 + stopped containers + unused volumes + build cache
                let reclaim_bytes: u64 = unused_not_kept.iter().map(|i| i.size_bytes).sum();
                let ids: Vec<String> = unused_not_kept.iter().map(|i| i.id.clone()).collect();
                let names: Vec<String> = unused_not_kept
                    .iter()
                    .map(|i| format!("{}:{}", i.repository, i.tag))
                    .collect();

                let container_count = count_stopped_containers_sync();
                let volume_count = count_unused_volumes_sync();

                let img_part = if ids.is_empty() {
                    String::new()
                } else {
                    format!(" && docker rmi {}", ids.join(" "))
                };
                let command = format!(
                    "docker container prune -f{}  && docker volume prune -f && docker builder prune -a -f",
                    img_part
                );

                Ok(PrunePreview {
                    level: 3,
                    command,
                    image_ids: ids,
                    image_names: names,
                    reclaim_bytes,
                    reclaim_size: bytes_to_human(reclaim_bytes),
                    container_count,
                    volume_count,
                })
            }

            _ => Err(format!("Invalid prune level: {}", level)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_prune_run(
    app: tauri::AppHandle,
    level: u8,
    image_ids: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |line: &str| {
            app.emit("docker-log", line).ok();
        };

        match level {
            1 => {
                emit("$ docker image prune -f");
                let mut cmd = Command::new("docker");
                cmd.args(["image", "prune", "-f"]);
                run_streaming_sync(&app, cmd)?;
            }

            2 => {
                if image_ids.is_empty() {
                    emit("# Nothing to remove.");
                } else {
                    emit(&format!("$ docker rmi {}", image_ids.join(" ")));
                    let mut cmd = Command::new("docker");
                    cmd.arg("rmi");
                    for id in &image_ids {
                        cmd.arg(id);
                    }
                    run_streaming_sync(&app, cmd)?;
                }
            }

            3 => {
                emit("$ docker container prune -f");
                let mut cmd = Command::new("docker");
                cmd.args(["container", "prune", "-f"]);
                run_streaming_sync(&app, cmd)?;

                if !image_ids.is_empty() {
                    emit(&format!("$ docker rmi {}", image_ids.join(" ")));
                    let mut cmd = Command::new("docker");
                    cmd.arg("rmi");
                    for id in &image_ids {
                        cmd.arg(id);
                    }
                    run_streaming_sync(&app, cmd)?;
                }

                emit("$ docker volume prune -f");
                let mut cmd = Command::new("docker");
                cmd.args(["volume", "prune", "-f"]);
                run_streaming_sync(&app, cmd)?;

                emit("$ docker builder prune -a -f");
                let mut cmd = Command::new("docker");
                cmd.args(["builder", "prune", "-a", "-f"]);
                run_streaming_sync(&app, cmd)?;
            }

            _ => return Err(format!("Invalid level: {}", level)),
        }

        app.emit("docker-done", true).ok();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands — Phase 3: Containers & Volumes
// ─────────────────────────────────────────────────────────────────────────────

fn get_containers_sync() -> Result<Vec<DockerContainer>, String> {
    let output = Command::new("docker")
        .args(["ps", "-a", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut containers = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("JSON parse error: {}", e))?;

        // Names can be comma-separated; take the first and strip any leading slash
        let raw_name = v["Names"].as_str().unwrap_or("").to_string();
        let name = raw_name
            .split(',')
            .next()
            .unwrap_or("")
            .trim_start_matches('/')
            .to_string();

        containers.push(DockerContainer {
            id: v["ID"].as_str().unwrap_or("").to_string(),
            name,
            image: v["Image"].as_str().unwrap_or("").to_string(),
            state: v["State"].as_str().unwrap_or("").to_string(),
            status: v["Status"].as_str().unwrap_or("").to_string(),
            ports: v["Ports"].as_str().unwrap_or("").to_string(),
            created_since: v["RunningFor"].as_str().unwrap_or("").to_string(),
        });
    }

    Ok(containers)
}

fn get_volumes_sync() -> Result<Vec<DockerVolume>, String> {
    let output = Command::new("docker")
        .args(["volume", "ls", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    // Volumes that are dangling (not referenced by any container) are "unused"
    let dangling: HashSet<String> = Command::new("docker")
        .args(["volume", "ls", "-qf", "dangling=true"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut volumes = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("JSON parse error: {}", e))?;

        let name = v["Name"].as_str().unwrap_or("").to_string();
        let in_use = !dangling.contains(&name);

        volumes.push(DockerVolume {
            in_use,
            name,
            driver: v["Driver"].as_str().unwrap_or("local").to_string(),
            mountpoint: v["Mountpoint"].as_str().unwrap_or("").to_string(),
        });
    }

    Ok(volumes)
}

#[tauri::command]
pub async fn docker_containers() -> Result<Vec<DockerContainer>, String> {
    tauri::async_runtime::spawn_blocking(get_containers_sync)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_volumes() -> Result<Vec<DockerVolume>, String> {
    tauri::async_runtime::spawn_blocking(get_volumes_sync)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_container_action(id: String, action: String) -> Result<(), String> {
    let sub = match action.as_str() {
        "start"  => "start",
        "stop"   => "stop",
        "remove" => "rm",
        _ => return Err(format!("Unknown action: {}", action)),
    };
    let output = Command::new("docker")
        .args([sub, &id])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn docker_volume_remove(name: String) -> Result<(), String> {
    let output = Command::new("docker")
        .args(["volume", "rm", &name])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn docker_volumes_prune() -> Result<(), String> {
    let output = Command::new("docker")
        .args(["volume", "prune", "-f"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
