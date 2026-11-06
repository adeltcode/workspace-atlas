use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::thread;

use tauri::Emitter;
use crate::error::{AtlasError, ErrorKind};
use crate::shell::hidden;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct DockerStatus {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    /// "running" | "stopped" | "not_installed"
    pub state: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DiskStats {
    /// Total bytes on the drive that contains `path`.
    pub total_bytes: u64,
    /// Free bytes available on that drive.
    pub free_bytes: u64,
    /// Drive label shown in the UI (e.g. "C:").
    pub drive_label: String,
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
    /// Days since the container was stopped. -1 means it is currently running.
    /// Parsed from the human-readable Status field ("Exited (0) 3 weeks ago").
    pub stopped_days: i64,
    /// Docker Compose project name from com.docker.compose.project label, if any.
    pub compose_project: Option<String>,
    /// Docker Compose service name from com.docker.compose.service label, if any.
    pub compose_service: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub in_use: bool,
    /// Container names currently using this volume.
    pub containers: Vec<String>,
    /// Docker Compose project that created this volume, if any.
    pub compose_project: Option<String>,
    /// Disk space used by this volume's data (0 = unknown).
    pub size_bytes: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DockerNetwork {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub internal: bool,
    pub ipv6: bool,
    /// Shortened creation timestamp e.g. "2024-01-15 10:30".
    pub created: String,
}

// ── Compose / Backup types ────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone, Debug)]
pub struct ContainerStats {
    pub name: String,
    /// CPU usage percent (0 to 100+, because multi-core can exceed 100).
    pub cpu_pct: f64,
    /// Memory used by the container, in bytes.
    pub mem_used_bytes: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct ComposeProject {
    pub name: String,
    pub status: String,
    /// Absolute paths to each config file (comma-separated in docker output).
    pub config_files: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct VolumeBackupEntry {
    pub filename: String,
    pub volume: String,
    pub path: String,
    pub size_bytes: u64,
    /// Unix timestamp (seconds) when this backup was created.
    pub created_at: i64,
}

/// Persisted to `{backup_dir}/backup_manifest.json`.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct BackupManifest {
    backups: Vec<VolumeBackupEntry>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ComposeBackupEntry {
    pub filename: String,
    pub project: String,
    /// Original source path of the config file.
    pub original_path: String,
    /// Full path to the saved backup file.
    pub path: String,
    pub size_bytes: u64,
    pub created_at: i64,
}

/// Persisted to `{root}/docker/compose/manifest.json`.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ComposeBackupManifest {
    backups: Vec<ComposeBackupEntry>,
}

#[derive(serde::Serialize, Clone)]
struct BackupProgress {
    /// Which volume this event belongs to (None for general messages).
    volume: Option<String>,
    step: String,
    /// 0-100 completion estimate for this volume.
    progress: u8,
    done: bool,
    error: Option<String>,
    filename: Option<String>,
    /// The raw Docker command being executed, if applicable. Shown in terminal.
    cmd: Option<String>,
}

/// Emit a backup-progress event for a specific volume.
fn emit_bp(
    app: &tauri::AppHandle,
    volume: &str,
    step: &str,
    progress: u8,
    done: bool,
    error: Option<String>,
    filename: Option<String>,
    cmd: Option<String>,
) {
    use tauri::Emitter;
    app.emit("backup-progress", BackupProgress {
        volume:   Some(volume.to_string()),
        step:     step.to_string(),
        progress,
        done,
        error,
        filename,
        cmd,
    }).ok();
}

#[derive(serde::Serialize, Clone)]
pub struct TransferResult {
    pub moved: u32,
    pub old_dir_removed: bool,
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
// Helpers - path routing (Windows / WSL mount / pure WSL)
// ─────────────────────────────────────────────────────────────────────────────

/// True for paths like `C:\...` or `C:/...`
fn is_windows_absolute(path: &str) -> bool {
    path.len() >= 2
        && path.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
        && path.chars().nth(1) == Some(':')
}

/// Converts `/mnt/c/Users/foo` → `C:\Users\foo`. Returns `None` for other paths.
fn wsl_mount_to_windows(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/mnt/")?;
    let mut chars = rest.chars();
    let drive = chars.next()?;
    let after = chars.as_str();
    // Must be end of string or start with '/'
    if !after.is_empty() && !after.starts_with('/') {
        return None;
    }
    let win_rest = after.trim_start_matches('/').replace('/', "\\");
    Some(format!("{}:\\{}", drive.to_ascii_uppercase(), win_rest))
}

/// A command in the default distro, run without its shell, so `;` or `$(...)` in a path stays plain text.
fn wsl_exec() -> Command {
    let mut cmd = hidden("wsl");
    cmd.arg("-e");
    cmd
}

/// Resolve any path to a Windows-openable form: native Windows paths pass
/// through, `/mnt/<drive>` maps directly, and a pure-WSL path (e.g.
/// `/home/me/proj`) is converted to its `\\wsl.localhost\<distro>\…` UNC form
/// via `wslpath -w` (default distro). Returns the input unchanged on failure.
fn to_windows_path(path: &str) -> String {
    if is_windows_absolute(path) {
        return path.to_string();
    }
    if let Some(win) = wsl_mount_to_windows(path) {
        return win;
    }
    if path.starts_with('/') {
        if let Ok(out) = wsl_exec().args(["wslpath", "-w", path]).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    path.to_string()
}

/// Build a `docker compose -f <path> …` base command, routing by path style:
/// native Windows and `/mnt/<drive>` paths go to the Windows Docker CLI, pure
/// WSL paths run docker inside WSL. The second value is the resolved Windows
/// path when a `/mnt/` mount was translated (for "# resolved to" logging).
fn compose_base(config_file: &str) -> (Command, Option<String>) {
    if is_windows_absolute(config_file) {
        let mut cmd = hidden("docker");
        cmd.args(["compose", "-f", config_file]);
        (cmd, None)
    } else if let Some(win_path) = wsl_mount_to_windows(config_file) {
        let mut cmd = hidden("docker");
        cmd.args(["compose", "-f", &win_path]);
        (cmd, Some(win_path))
    } else {
        let mut cmd = wsl_exec();
        cmd.args(["docker", "compose", "-f", config_file]);
        (cmd, None)
    }
}

/// Read a file that lives inside WSL via `wsl -e cat`. Capped at `max_bytes`.
fn read_via_wsl(path: &str, max_bytes: usize) -> Result<Vec<u8>, AtlasError> {
    let output = wsl_exec()
        .args(["cat", path])
        .output()
        .map_err(|e| format!(
            "WSL is not available, so '{}' could not be read: {}",
            path, e
        ))?;

    if !output.status.success() {
        return Err(format!(
            "Cannot read WSL file '{}': {}",
            path,
            String::from_utf8_lossy(&output.stderr).trim()
        ).into());
    }

    if output.stdout.len() > max_bytes {
        return Err(format!(
            "This file is too large to show ({} KB). The limit is {} KB.",
            output.stdout.len() / 1024,
            max_bytes / 1024
        ).into());
    }

    Ok(output.stdout)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers - backup / pause
// ─────────────────────────────────────────────────────────────────────────────

/// Returns IDs of containers that are currently **running** and have `volume_name`
/// mounted. Uses `docker ps` (running-only by default, no `-a` flag).
fn get_running_containers_for_volume(volume_name: &str) -> Vec<String> {
    hidden("docker")
        .args([
            "ps",
            "--filter", &format!("volume={}", volume_name),
            "--format", "{{.ID}}",
        ])
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


// ─────────────────────────────────────────────────────────────────────────────
// Helpers - parsing
// ─────────────────────────────────────────────────────────────────────────────

/// Extract a single label value from a comma-separated `key=value,...` label string.
fn parse_label(label_str: &str, key: &str) -> Option<String> {
    label_str.split(',').find_map(|kv| {
        let (k, val) = kv.split_once('=')?;
        if k.trim() == key { Some(val.trim().to_string()) } else { None }
    })
}

/// Returns the number of days since a container stopped, based on its Status
/// string (e.g. "Exited (0) 3 weeks ago", "Exited (1) About a minute ago").
/// Returns -1 for running/paused/created containers.
fn parse_stopped_days(state: &str, status: &str) -> i64 {
    if state != "exited" && state != "dead" {
        return -1;
    }
    if state == "dead" {
        return 999; // definitely stale
    }
    // Walk backwards from the word "ago" to find "N unit"
    let lower = status.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    if let Some(ago_pos) = words.iter().position(|&w| w == "ago") {
        if ago_pos >= 2 {
            let n = words[ago_pos - 2].parse::<i64>().unwrap_or(1);
            let unit = words[ago_pos - 1];
            return match unit {
                u if u.starts_with("second") || u.starts_with("minute") || u.starts_with("hour") => 0,
                u if u.starts_with("day")   => n,
                u if u.starts_with("week")  => n * 7,
                u if u.starts_with("month") => n * 30,
                u if u.starts_with("year")  => n * 365,
                _ => 0,
            };
        }
    }
    0
}

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

fn parse_system_df(output: &str) -> Result<DockerSystemDf, AtlasError> {
    let lines: Vec<&str> = output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();

    if lines.len() < 5 {
        return Err(format!(
            "Unexpected docker system df output ({} lines):\n{}",
            lines.len(),
            output
        ).into());
    }

    let parse_row = |line: &str| -> Result<DiskUsageRow, AtlasError> {
        let cols = split_df_line(line);
        if cols.len() < 5 {
            return Err(format!("Could not read a row of the docker system df output: {:?}", line).into());
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

pub(crate) fn bytes_to_human(bytes: u64) -> String {
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
// Helpers - data fetching (sync, called from async commands via spawn_blocking)
// ─────────────────────────────────────────────────────────────────────────────

fn get_all_images_sync() -> Result<Vec<DockerImage>, AtlasError> {
    let output = hidden("docker")
        .args(["images", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into());
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
            serde_json::from_str(line).map_err(|e| format!("Could not read the image list from Docker: {}", e))?;

        let id = v["ID"].as_str().unwrap_or("").to_string();
        let repository = v["Repository"].as_str().unwrap_or("<none>").to_string();
        let tag = v["Tag"].as_str().unwrap_or("<none>").to_string();
        let size = v["Size"].as_str().unwrap_or("0B").to_string();
        let size_bytes = parse_iec_bytes(&size);
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
    hidden("docker")
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
    hidden("docker")
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
    hidden("docker")
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

/// Run `docker system df -v` and return a map of volume name → size in bytes.
/// Returns an empty map on any error so it degrades gracefully.
fn get_volume_sizes_sync() -> std::collections::HashMap<String, u64> {
    let output = match hidden("docker")
        .args(["system", "df", "-v", "--format", "{{json .}}"])
        .output()
    {
        // Some older Docker versions don't support --format with -v; fall back to plain text
        Ok(o) if o.status.success() => o,
        _ => {
            // Fallback: plain text
            match hidden("docker").args(["system", "df", "-v"]).output() {
                Ok(o) if o.status.success() => return parse_volume_sizes_text(&String::from_utf8_lossy(&o.stdout)),
                _ => return std::collections::HashMap::new(),
            }
        }
    };

    // `--format` is unreliable with `-v` across Docker versions, so the output is
    // parsed as plain text in both the primary and fallback paths.
    let text = String::from_utf8_lossy(&output.stdout);
    parse_volume_sizes_text(&text)
}

fn parse_volume_sizes_text(text: &str) -> std::collections::HashMap<String, u64> {
    let mut in_volumes = false;
    let mut past_header = false;
    let mut sizes = std::collections::HashMap::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.contains("Local Volumes space usage") {
            in_volumes = true;
            past_header = false;
            continue;
        }
        if !in_volumes { continue; }
        if trimmed.is_empty() { continue; }
        if trimmed.starts_with("VOLUME NAME") {
            past_header = true;
            continue;
        }
        if past_header {
            if trimmed.starts_with("Build cache") || trimmed.starts_with("CACHE") {
                break;
            }
            // Split on 2+ consecutive spaces: NAME  LINKS  SIZE
            let cols = split_df_line(trimmed);
            if cols.len() >= 3 {
                sizes.insert(cols[0].clone(), parse_iec_bytes(&cols[2]));
            }
        }
    }

    sizes
}

fn get_networks_sync() -> Result<Vec<DockerNetwork>, AtlasError> {
    let output = hidden("docker")
        .args(["network", "ls", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker network ls: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut networks = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let v: serde_json::Value = serde_json::from_str(line)
            .map_err(|e| format!("Could not read the network list from Docker: {}", e))?;

        let internal = v["Internal"].as_str().unwrap_or("false")
            .eq_ignore_ascii_case("true");
        let ipv6 = v["IPv6"].as_str().unwrap_or("false")
            .eq_ignore_ascii_case("true");

        // "2024-01-15 10:30:00.123 +0000 UTC" → "2024-01-15 10:30"
        let created_raw = v["CreatedAt"].as_str().unwrap_or("").to_string();
        let created = created_raw.get(..16).unwrap_or(&created_raw).to_string();

        networks.push(DockerNetwork {
            id:       v["ID"].as_str().unwrap_or("").to_string(),
            name:     v["Name"].as_str().unwrap_or("").to_string(),
            driver:   v["Driver"].as_str().unwrap_or("").to_string(),
            scope:    v["Scope"].as_str().unwrap_or("").to_string(),
            internal,
            ipv6,
            created,
        });
    }

    Ok(networks)
}

/// Run a command and stream each stdout/stderr line as a "docker-log" event.
/// With `tag_stderr`, stderr lines are prefixed "[err] " so the frontend can
/// colour them red. Pass `false` for `docker compose`, which writes all its
/// informational progress output to stderr by design.
fn run_streaming(app: &tauri::AppHandle, mut cmd: Command, tag_stderr: bool) -> Result<(), AtlasError> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the Docker command: {}", e))?;

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
            let mut last_line = String::new();
            BufReader::new(err).lines().flatten().for_each(|line| {
                if !line.trim().is_empty() {
                    last_line = line.clone();
                    let payload = if tag_stderr {
                        format!("[err] {}", line)
                    } else {
                        line
                    };
                    stderr_app.emit("docker-log", payload).ok();
                }
            });
            last_line
        })
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    if let Some(h) = stdout_handle { h.join().ok(); }
    let last_stderr = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    streaming_result(status, &last_stderr)
}

/// The last stderr line usually names the cause, such as a port that is already allocated.
fn streaming_result(status: std::process::ExitStatus, last_stderr: &str) -> Result<(), AtlasError> {
    if status.success() {
        Ok(())
    } else if last_stderr.trim().is_empty() {
        Err(format!("The Docker command failed ({}).", status).into())
    } else {
        Err(last_stderr.trim().into())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands - Phase 1
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn docker_check(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<DockerStatus, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let result = hidden("docker")
            .args(["version", "--format", "{{.Server.Version}}"])
            .output();

        Ok(match result {
            Ok(o) if o.status.success() => {
                let version = String::from_utf8_lossy(&o.stdout).trim().to_string();
                DockerStatus {
                    available: true,
                    version: if version.is_empty() { None } else { Some(version) },
                    error: None,
                    state: "running".to_string(),
                }
            }
            Ok(o) => {
                // CLI found but daemon not responding
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                DockerStatus {
                    available: false,
                    version: None,
                    error: Some(if err.is_empty() {
                        "The Docker engine is not running.".to_string()
                    } else {
                        err
                    }),
                    state: "stopped".to_string(),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // `docker` binary not in PATH - check common install paths before
                // declaring it truly absent (Docker Desktop may not update PATH yet)
                let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
                let candidates = [
                    r"C:\Program Files\Docker\Docker\resources\bin\docker.exe".to_string(),
                    format!(r"{}\Programs\Docker\Docker\resources\bin\docker.exe", local_app_data),
                ];
                let found_elsewhere = candidates.iter().any(|p| std::path::Path::new(p).exists());
                DockerStatus {
                    available: false,
                    version: None,
                    error: Some(format!("The docker command was not found: {}", e)),
                    state: if found_elsewhere { "stopped" } else { "not_installed" }.to_string(),
                }
            }
            Err(e) => DockerStatus {
                available: false,
                version: None,
                error: Some(format!("Could not run the docker command: {}", e)),
                state: "stopped".to_string(),
            },
        })
    }).await
}

/// Try to launch Docker Desktop on Windows. Returns an error string if the
/// executable cannot be located or spawned.
#[tauri::command]
pub async fn launch_docker_desktop(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let candidates = [
            r"C:\Program Files\Docker\Docker\Docker Desktop.exe".to_string(),
            format!(r"{}\Programs\Docker\Docker\Docker Desktop.exe", local_app_data),
        ];

        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return Ok(std::process::Command::new(path)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Failed to start Docker Desktop: {}", e))?);
            }
        }

        Err(AtlasError::new(ErrorKind::DockerDown, "Docker Desktop was not found in its usual install folders.")
            .hint("Start it from the Start menu. Atlas only needs the Docker engine running."))
    }).await
}

#[tauri::command]
pub async fn docker_system_df(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<DockerSystemDf, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let output = hidden("docker")
            .args(["system", "df"])
            .output()
            .map_err(|e| format!("Failed to run docker: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into());
        }

        parse_system_df(&String::from_utf8_lossy(&output.stdout))
    }).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands - Phase 2
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn docker_images(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<Vec<DockerImage>, AtlasError> {
    migration.inner().clone().run_operation(get_all_images_sync).await
}

#[tauri::command]
pub async fn docker_prune_preview(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    level: u8,
    keep_list: Vec<String>,
) -> Result<PrunePreview, AtlasError> {
    migration.inner().clone().run_operation(move || {
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

            _ => Err(AtlasError::invalid(format!("Prune level {} does not exist. Levels are 1, 2 and 3.", level))),
        }
    }).await
}

#[tauri::command]
pub async fn docker_prune_run(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    level: u8,
    image_ids: Vec<String>,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let emit = |line: &str| {
            app.emit("docker-log", line).ok();
        };

        match level {
            1 => {
                emit("$ docker image prune -f");
                let mut cmd = hidden("docker");
                cmd.args(["image", "prune", "-f"]);
                run_streaming(&app, cmd, true)?;
            }

            2 => {
                if image_ids.is_empty() {
                    emit("# Nothing to remove.");
                } else {
                    emit(&format!("$ docker rmi {}", image_ids.join(" ")));
                    let mut cmd = hidden("docker");
                    cmd.arg("rmi");
                    for id in &image_ids {
                        cmd.arg(id);
                    }
                    run_streaming(&app, cmd, true)?;
                }
            }

            3 => {
                // One failed step does not stop the rest, because each one frees space on its own.
                let mut first_failure = None;
                let mut step = |args: &[&str]| {
                    emit(&format!("$ docker {}", args.join(" ")));
                    let mut cmd = hidden("docker");
                    cmd.args(args);
                    if let Err(e) = run_streaming(&app, cmd, true) {
                        first_failure.get_or_insert(e);
                    }
                };

                step(&["container", "prune", "-f"]);
                if !image_ids.is_empty() {
                    let mut rmi = vec!["rmi"];
                    rmi.extend(image_ids.iter().map(String::as_str));
                    step(&rmi);
                }
                step(&["volume", "prune", "-f"]);
                step(&["builder", "prune", "-a", "-f"]);

                if let Some(e) = first_failure {
                    return Err(e);
                }
            }

            _ => return Err(AtlasError::invalid(format!("Prune level {} does not exist. Levels are 1, 2 and 3.", level))),
        }

        app.emit("docker-done", true).ok();
        Ok(())
    }).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands - Phase 3: Containers & Volumes
// ─────────────────────────────────────────────────────────────────────────────

fn get_containers_sync() -> Result<Vec<DockerContainer>, AtlasError> {
    let output = hidden("docker")
        .args(["ps", "-a", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut containers = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("Could not read the container list from Docker: {}", e))?;

        // Names can be comma-separated; take the first and strip any leading slash
        let raw_name = v["Names"].as_str().unwrap_or("").to_string();
        let name = raw_name
            .split(',')
            .next()
            .unwrap_or("")
            .trim_start_matches('/')
            .to_string();

        let state  = v["State"].as_str().unwrap_or("").to_string();
        let status = v["Status"].as_str().unwrap_or("").to_string();
        let stopped_days = parse_stopped_days(&state, &status);

        let label_str = v["Labels"].as_str().unwrap_or("");
        let compose_project = parse_label(label_str, "com.docker.compose.project");
        let compose_service = parse_label(label_str, "com.docker.compose.service");

        containers.push(DockerContainer {
            id: v["ID"].as_str().unwrap_or("").to_string(),
            name,
            image: v["Image"].as_str().unwrap_or("").to_string(),
            state,
            status,
            ports: v["Ports"].as_str().unwrap_or("").to_string(),
            created_since: v["RunningFor"].as_str().unwrap_or("").to_string(),
            stopped_days,
            compose_project,
            compose_service,
        });
    }

    Ok(containers)
}

fn get_volumes_sync() -> Result<Vec<DockerVolume>, AtlasError> {
    let output = hidden("docker")
        .args(["volume", "ls", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into());
    }

    // Docker's own reference-counting filter - the only reliable source of truth
    // for whether a volume is referenced by at least one container.
    // `dangling=true` means "not referenced by any container (running or stopped)".
    let dangling: HashSet<String> = hidden("docker")
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
        if line.is_empty() { continue; }
        let v: serde_json::Value =
            serde_json::from_str(line).map_err(|e| format!("Could not read the volume list from Docker: {}", e))?;

        let name = v["Name"].as_str().unwrap_or("").to_string();

        // `in_use` = referenced by any container (running or stopped).
        // Determined via Docker's dangling filter - the authoritative source.
        let in_use = !dangling.contains(&name);

        // `containers` = names of RUNNING containers that mount this volume.
        // Only queried for in-use volumes; these are the containers that will be
        // paused during backup (shown as a warning in the UI).
        let containers: Vec<String> = if in_use {
            hidden("docker")
                .args([
                    "ps",                                 // running-only (no -a)
                    "--filter", &format!("volume={}", name),
                    "--format", "{{.Names}}",
                ])
                .output()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .map(|s| s.trim().trim_start_matches('/').to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let label_str = v["Labels"].as_str().unwrap_or("");
        let compose_project = parse_label(label_str, "com.docker.compose.project");

        volumes.push(DockerVolume {
            in_use,
            name,
            driver:     v["Driver"].as_str().unwrap_or("local").to_string(),
            containers,
            compose_project,
            size_bytes: 0, // filled in by docker_volumes() in parallel
        });
    }

    Ok(volumes)
}

#[tauri::command]
pub async fn docker_containers(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<Vec<DockerContainer>, AtlasError> {
    migration.inner().clone().run_operation(get_containers_sync).await
}

#[tauri::command]
pub async fn docker_volumes(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<Vec<DockerVolume>, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let (mut volumes, sizes) = std::thread::scope(|scope| {
            let volumes = scope.spawn(get_volumes_sync);
            let sizes = scope.spawn(get_volume_sizes_sync);
            let volumes = volumes.join().map_err(|_| AtlasError::invalid("Could not list volumes."))??;
            let sizes = sizes.join().map_err(|_| AtlasError::invalid("Could not measure volume sizes."))?;
            Ok::<_, AtlasError>((volumes, sizes))
        })?;
        for vol in &mut volumes {
            if let Some(&size) = sizes.get(&vol.name) {
                vol.size_bytes = size;
            }
        }
        Ok(volumes)
    }).await
}

/// Run a one-shot `docker <args>` command: Ok on success, trimmed stderr on failure.
fn docker_run_ok(args: &[&str]) -> Result<(), AtlasError> {
    let output = hidden("docker")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run docker: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into())
    }
}

#[tauri::command]
pub async fn docker_container_action(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    id: String,
    action: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let sub = match action.as_str() {
            "start"  => "start",
            "stop"   => "stop",
            "remove" => "rm",
            _ => return Err(AtlasError::invalid(format!("Unknown container action: \"{}\".", action))),
        };
        docker_run_ok(&[sub, &id])
    }).await
}

#[tauri::command]
pub async fn docker_desktop_stop(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(|| docker_run_ok(&["desktop", "stop"])).await
}

#[tauri::command]
pub async fn docker_volume_remove(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    name: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        docker_run_ok(&["volume", "rm", &name])
    }).await
}

#[tauri::command]
pub async fn docker_volumes_prune(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        docker_run_ok(&["volume", "prune", "-f"])
    }).await
}

/// Stream the last `tail` log lines from a container.
/// `--timestamps` adds RFC3339 prefixes so both stdout+stderr sort correctly.
#[tauri::command]
pub async fn docker_container_logs(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    id: String,
    tail: u32,
) -> Result<Vec<String>, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let tail_str = tail.to_string();
        let output = hidden("docker")
            .args(["logs", "--tail", &tail_str, "--timestamps", &id])
            .output()
            .map_err(|e| format!("Failed to run docker logs: {}", e))?;

        let stdout_str = String::from_utf8_lossy(&output.stdout);
        let stderr_str = String::from_utf8_lossy(&output.stderr);

        let mut all: Vec<String> = stdout_str.lines()
            .chain(stderr_str.lines())
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();

        // Timestamps are RFC3339 so lexicographic sort = chronological order,
        // correctly interleaving container stdout and stderr.
        all.sort_unstable();
        Ok(all)
    }).await
}

#[tauri::command]
pub async fn docker_networks(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<Vec<DockerNetwork>, AtlasError> {
    migration.inner().clone().run_operation(get_networks_sync).await
}

#[tauri::command]
pub async fn docker_network_remove(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    id: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        docker_run_ok(&["network", "rm", &id])
    }).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands - Phase 4: Compose viewer & Volume backup
// ─────────────────────────────────────────────────────────────────────────────

// ── Manifest helpers ──────────────────────────────────────────────────────────
//
// Directory layout (root = user-chosen backup root, e.g. ~/atlas-backups):
//   {root}/docker/volumes/{volume}_{ts}.tar.gz
//   {root}/docker/compose/{compose-stem}_{ts}.yml
//   {root}/docker/manifest.json
//
// The old flat layout ({root}/backup_manifest.json + archives at root) is
// still readable for migration; writes always use the new layout.

fn docker_volumes_dir(root: &str) -> String { format!("{}/docker/volumes", root) }
fn docker_compose_dir(root: &str) -> String { format!("{}/docker/compose", root) }

fn read_manifest(root: &str) -> BackupManifest {
    // Try new path first, fall back to legacy flat path for migration.
    let new_path = format!("{}/docker/manifest.json", root);
    if let Ok(s) = std::fs::read_to_string(&new_path) {
        if let Ok(m) = serde_json::from_str(&s) {
            return m;
        }
    }
    let old_path = format!("{}/backup_manifest.json", root);
    std::fs::read_to_string(&old_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(root: &str, manifest: &BackupManifest) -> Result<(), AtlasError> {
    let dir = format!("{}/docker", root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = format!("{}/manifest.json", dir);
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    Ok(std::fs::write(path, json).map_err(|e| e.to_string())?)
}

fn read_compose_manifest(root: &str) -> ComposeBackupManifest {
    let path = format!("{}/docker/compose/manifest.json", root);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_compose_manifest(root: &str, manifest: &ComposeBackupManifest) -> Result<(), AtlasError> {
    let dir = format!("{}/docker/compose", root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = format!("{}/manifest.json", dir);
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    Ok(std::fs::write(path, json).map_err(|e| e.to_string())?)
}

/// Read a source file as a UTF-8 string, handling Windows / WSL-mount / pure-WSL paths.
fn read_source_as_string(src: &str) -> Result<String, AtlasError> {
    if is_windows_absolute(src) {
        Ok(std::fs::read_to_string(src)
            .map_err(|e| format!("Cannot read '{}': {}", src, e))?)
    } else if let Some(win) = wsl_mount_to_windows(src) {
        Ok(std::fs::read_to_string(&win)
            .map_err(|e| format!("Cannot read '{}': {}", win, e))?)
    } else {
        read_via_wsl(src, 512_000).and_then(|bytes| {
            Ok(String::from_utf8(bytes)
                .map_err(|_| "File contains non-UTF-8 characters".to_string())?)
        })
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// List Docker Compose projects via `docker compose ls --all --format json`.
#[tauri::command]
pub async fn docker_compose_ls(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<Vec<ComposeProject>, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let output = hidden("docker")
            .args(["compose", "ls", "--all", "--format", "json"])
            .output()
            .map_err(|e| format!("Failed to run docker compose: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.trim();
        if trimmed.is_empty() || trimmed == "null" || trimmed == "[]" {
            return Ok(Vec::new());
        }

        let raw: Vec<serde_json::Value> = serde_json::from_str(trimmed)
            .map_err(|e| format!("Could not read the Compose project list from Docker: {}", e))?;

        Ok(raw
            .iter()
            .map(|v| {
                let config_str = v["ConfigFiles"].as_str().unwrap_or("");
                let config_files: Vec<String> = config_str
                    .split(',')
                    .map(|s| s.trim().trim_end_matches('/').trim_end_matches('\\').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                ComposeProject {
                    name: v["Name"].as_str().unwrap_or("").to_string(),
                    status: v["Status"].as_str().unwrap_or("").to_string(),
                    config_files,
                }
            })
            .collect())
    }).await
}

/// Run a docker compose lifecycle action against a specific config file,
/// streaming output via `docker-log` events.
///
/// Handles three path origins:
///   - Windows absolute (`C:\...`)  → `docker compose -f <path> <action>`
///   - WSL mount (`/mnt/c/...`)     → convert to Windows path, then same
///   - Pure WSL (`/home/...` etc.)  → `wsl -e docker compose -f <path> <action>`
#[tauri::command]
pub async fn docker_compose_action(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    config_file: String,
    action: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let extra_args: &[&str] = match action.as_str() {
            "up"           => &["up", "-d"],
            "down"         => &["down"],
            "down-volumes" => &["down", "-v"],
            "restart"      => &["restart"],
            "rebuild"      => &["up", "-d", "--build"],
            other          => return Err(AtlasError::invalid(format!("Unknown Compose action: \"{}\".", other))),
        };

        // Display the command as it will actually run
        app.emit("docker-log",
            format!("$ docker compose -f \"{}\" {}", &config_file, extra_args.join(" "))
        ).ok();

        let (mut cmd, resolved) = compose_base(&config_file);
        if let Some(win) = &resolved {
            app.emit("docker-log", format!("# resolved to {}", win)).ok();
        }
        cmd.args(extra_args);
        run_streaming(&app, cmd, false)?;

        app.emit("docker-done", true).ok();
        Ok(())
    }).await
}

/// Run a docker compose action against a single service, streaming via docker-log.
/// Actions: "up" (up -d SERVICE), "stop", "restart".
#[tauri::command]
pub async fn docker_compose_service_action(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    config_file: String,
    action: String,
    service: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let base: &[&str] = match action.as_str() {
            "up"      => &["up", "-d"],
            "stop"    => &["stop"],
            "restart" => &["restart"],
            other     => return Err(AtlasError::invalid(format!("Unknown service action: \"{}\".", other))),
        };

        // Build final arg list: base_args + [service]
        let mut extra: Vec<String> = base.iter().map(|s| s.to_string()).collect();
        extra.push(service.clone());

        app.emit("docker-log",
            format!("$ docker compose -f \"{}\" {} {}", &config_file, base.join(" "), &service)
        ).ok();

        let (mut cmd, resolved) = compose_base(&config_file);
        if let Some(win) = &resolved {
            app.emit("docker-log", format!("# resolved to {}", win)).ok();
        }
        cmd.args(extra.iter().map(|s| s.as_str()).collect::<Vec<_>>());
        run_streaming(&app, cmd, false)?;

        app.emit("docker-done", true).ok();
        Ok(())
    }).await
}

/// Docker limits object names to `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. Check that here: these
/// names reach a PowerShell command line and `--volume` specs, where a path mounts a host folder.
fn validate_docker_name(name: &str) -> Result<(), AtlasError> {
    let mut chars = name.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if valid {
        Ok(())
    } else {
        Err(AtlasError::invalid(format!("\"{}\" is not a valid Docker name.", name)))
    }
}

/// Open an interactive shell inside a running container in a new system terminal window.
/// Tries `sh`; the user can switch shells manually if needed.
#[tauri::command]
pub async fn open_container_shell(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    container_name: String,
) -> Result<(), AtlasError> {
    validate_docker_name(&container_name)?;
    migration.inner().clone().run_operation(move || {
        let docker_cmd = format!("docker exec -it {} sh", container_name);

        // Try Windows Terminal first; fall back to a plain PowerShell window.
        let wt = Command::new("wt")
            .args(["--", "powershell.exe", "-NoExit", "-Command", &docker_cmd])
            .spawn();

        if wt.is_err() {
            Command::new("cmd")
                .args(["/c", "start", "powershell.exe", "-NoExit", "-Command", &docker_cmd])
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        }
        Ok(())
    }).await
}

/// Write text content to a file. Handles Windows, WSL-mount, and pure WSL paths.
#[tauri::command]
pub async fn write_file_content(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    path: String,
    content: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        if is_windows_absolute(&path) {
            Ok(std::fs::write(&path, content.as_bytes())
                .map_err(|e| format!("Could not write '{}': {}", path, e))?)

        } else if let Some(win_path) = wsl_mount_to_windows(&path) {
            Ok(std::fs::write(&win_path, content.as_bytes())
                .map_err(|e| format!("Could not write '{}': {}", win_path, e))?)

        } else {
            // Pure WSL path - pipe content through `wsl -e tee`
            use std::io::Write as _;
            let mut child = wsl_exec()
                .args(["tee", &path])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Could not start WSL to write '{}': {}", path, e))?;

            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(content.as_bytes())
                    .map_err(|e| format!("Could not write '{}': {}", path, e))?;
            }

            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(format!("Could not write '{}' in WSL ({}).", path, status).into());
            }
            Ok(())
        }
    }).await
}

/// Parse "12.34%" or "--" → f64. Returns 0.0 for dashes / parse failures.
fn parse_pct(s: &str) -> f64 {
    let s = s.trim().trim_end_matches('%');
    if s == "--" || s == "N/A" { return 0.0; }
    s.parse::<f64>().unwrap_or(0.0)
}

/// Parse IEC byte strings produced by `docker stats`:
/// "23.5MiB", "512KiB", "15.55GiB", "1.2TiB", "128B"
/// Also handles the SI variants Docker occasionally emits (MB, GB, kB).
fn parse_iec_bytes(s: &str) -> u64 {
    let s = s.trim();
    let table: &[(&str, f64)] = &[
        ("TiB", 1024.0_f64.powi(4)),
        ("GiB", 1024.0_f64.powi(3)),
        ("MiB", 1024.0_f64.powi(2)),
        ("KiB", 1024.0),
        ("TB",  1_000_000_000_000.0),
        ("GB",  1_000_000_000.0),
        ("MB",  1_000_000.0),
        ("kB",  1_000.0),
        ("KB",  1_000.0),
        ("B",   1.0),
    ];
    for &(suffix, factor) in table {
        if let Some(n) = s.strip_suffix(suffix) {
            return (n.trim().parse::<f64>().unwrap_or(0.0) * factor) as u64;
        }
    }
    0
}

/// Parse `docker stats` MemUsage like "23.5MiB / 15.55GiB" → used bytes.
fn parse_mem_used(s: &str) -> u64 {
    parse_iec_bytes(s.splitn(2, '/').next().unwrap_or("").trim())
}

fn get_stats_sync() -> Result<Vec<ContainerStats>, AtlasError> {
    let output = hidden("docker")
        .args(["stats", "--no-stream", "--format", "{{json .}}"])
        .output()
        .map_err(|e| format!("Failed to run docker stats: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker stats: {}", err.trim()).into());
    }

    let mut stats = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let name = v["Name"].as_str().unwrap_or("")
            .trim_start_matches('/')
            .to_string();
        if name.is_empty() { continue; }
        let cpu_pct = parse_pct(v["CPUPerc"].as_str().unwrap_or("0%"));
        let mem_used_bytes = parse_mem_used(v["MemUsage"].as_str().unwrap_or("0B / 0B"));
        stats.push(ContainerStats { name, cpu_pct, mem_used_bytes });
    }
    Ok(stats)
}

/// Run `docker stats --no-stream` and return resource usage for all running containers.
#[tauri::command]
pub async fn docker_stats(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<Vec<ContainerStats>, AtlasError> {
    migration.inner().clone().run_operation(get_stats_sync).await
}

/// Query total and free bytes for the drive that contains `path` (Windows only).
/// Uses PowerShell's `[System.IO.DriveInfo]` - no extra crates needed.
#[tauri::command]
pub async fn get_disk_stats(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    path: String,
) -> Result<DiskStats, AtlasError> {
    migration.inner().clone().run_operation(move || {
        // Extract drive letter from a Windows path (e.g. "C:\Users\..." → 'C').
        // Fall back to %SYSTEMDRIVE% if the path is empty or has no letter.
        let drive = path
            .chars()
            .next()
            .filter(|c| c.is_ascii_alphabetic())
            .map(|c| c.to_ascii_uppercase().to_string())
            .unwrap_or_else(|| {
                std::env::var("SYSTEMDRIVE")
                    .unwrap_or_else(|_| "C:".to_string())
                    .trim_end_matches(':')
                    .to_uppercase()
            });

        let script = format!(
            r#"$d=[System.IO.DriveInfo]::new('{}'); "$($d.TotalSize) $($d.AvailableFreeSpace)""#,
            drive
        );

        let output = hidden("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("Could not run PowerShell to read disk space: {}", e))?;

        let out = String::from_utf8_lossy(&output.stdout);
        let parts: Vec<u64> = out
            .trim()
            .trim_matches('"')
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();

        if parts.len() < 2 {
            return Err(format!("Could not read the drive's size from PowerShell: {:?}", out.trim()).into());
        }

        Ok(DiskStats {
            total_bytes:  parts[0],
            free_bytes:   parts[1],
            drive_label:  format!("{}:", drive),
        })
    }).await
}

/// Recursively sum the sizes of all files under a directory.
fn dir_size_recursive(path: &std::path::Path) -> u64 {
    let Ok(dir) = std::fs::read_dir(path) else { return 0 };
    dir.flatten().map(|e| {
        let Ok(meta) = e.metadata() else { return 0 };
        if meta.is_dir() { dir_size_recursive(&e.path()) } else { meta.len() }
    }).sum()
}

/// Recursively sum the sizes of all files under `{backup_dir}/docker/`.
/// Only the Docker-specific subfolder is counted - the Atlas backup root may
/// contain unrelated categories (e.g. WSL, other tools) in the future.
/// Returns 0 if the directory does not exist or is not set.
#[tauri::command]
pub async fn get_backup_size(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    backup_dir: String,
) -> Result<u64, AtlasError> {
    migration.inner().clone().run_operation(move || {
        if backup_dir.is_empty() { return Ok(0); }
        let docker_dir = std::path::Path::new(&backup_dir).join("docker");
        Ok(dir_size_recursive(&docker_dir))
    }).await
}

/// Read a text file from the filesystem. Handles three path types:
///   - Windows absolute (`C:\...`)    → direct `fs::read`
///   - WSL mount (`/mnt/c/...`)       → convert to Windows path, then `fs::read`
///   - Pure WSL (`/home/...` etc.)    → `wsl cat <path>`
/// All variants are capped at 512 KB.
#[tauri::command]
pub async fn read_file_content(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    path: String,
) -> Result<String, AtlasError> {
    migration.inner().clone().run_operation(move || {
        const MAX_BYTES: usize = 512_000;

        let bytes: Vec<u8> = if is_windows_absolute(&path) {
            // ── Native Windows path ──────────────────────────────────────────
            let meta = std::fs::metadata(&path)
                .map_err(|e| format!("Cannot access '{}': {}", path, e))?;
            if meta.len() > MAX_BYTES as u64 {
                return Err(format!(
                    "This file is too large to show ({} KB). The limit is 512 KB.",
                    meta.len() / 1024
                ).into());
            }
            std::fs::read(&path).map_err(|e| format!("Could not read '{}': {}", path, e))?

        } else if let Some(win_path) = wsl_mount_to_windows(&path) {
            // ── /mnt/c/ → C:\ ───────────────────────────────────────────────
            let meta = std::fs::metadata(&win_path)
                .map_err(|e| format!("Cannot access '{}': {}", win_path, e))?;
            if meta.len() > MAX_BYTES as u64 {
                return Err(format!(
                    "This file is too large to show ({} KB). The limit is 512 KB.",
                    meta.len() / 1024
                ).into());
            }
            std::fs::read(&win_path).map_err(|e| format!("Could not read '{}': {}", win_path, e))?

        } else {
            // ── Pure WSL path (/home/…, /root/…, etc.) ──────────────────────
            read_via_wsl(&path, MAX_BYTES)?
        };

        Ok(String::from_utf8(bytes)
            .map_err(|_| "This file is not UTF-8 text, so it cannot be displayed.".to_string())?)
    }).await
}

/// Returns the OS-appropriate default backup root directory.
/// Subcategories are created automatically inside it (e.g. docker/volumes/).
#[tauri::command]
pub async fn get_default_backup_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/Atlas Backup", home.replace('\\', "/"))
}

/// List all volume backups tracked in the manifest under `{root}/docker/manifest.json`.
/// Entries whose archive files no longer exist on disk are silently filtered out.
#[tauri::command]
pub async fn docker_list_backups(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    backup_dir: String,
) -> Result<Vec<VolumeBackupEntry>, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let manifest = read_manifest(&backup_dir);
        Ok(manifest
            .backups
            .into_iter()
            .filter(|e| std::path::Path::new(&e.path).exists())
            .collect())
    }).await
}

/// Backup a named volume to `{root}/docker/volumes/{volume}_{ts}.tar.gz`.
/// Progress is emitted as `backup-progress` Tauri events.
#[tauri::command]
pub async fn docker_volume_backup(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    volume_name: String,
    backup_dir: String,
) -> Result<String, AtlasError> {
    validate_docker_name(&volume_name)?;
    migration.inner().clone().run_operation(move || {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let volumes_dir = docker_volumes_dir(&backup_dir);
        fs::create_dir_all(&volumes_dir)
            .map_err(|e| format!("Could not create the backup folder: {}", e))?;

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let filename       = format!("{}_{}.tar.gz", volume_name, ts);
        let backup_path    = format!("{}/{}", volumes_dir, filename);
        let docker_vol_dir = volumes_dir.replace('\\', "/");

        let vol = &volume_name;

        emit_bp(&app, vol, "Checking for the alpine image…", 5, false, None, None,
            Some("docker image inspect alpine --format {{.Id}}".to_string()));

        let alpine_ok = hidden("docker")
            .args(["image", "inspect", "alpine", "--format", "{{.Id}}"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !alpine_ok {
            emit_bp(&app, vol, "Pulling the alpine image…", 10, false, None, None,
                Some("docker pull alpine".to_string()));
            let pull = hidden("docker")
                .args(["pull", "alpine"])
                .output()
                .map_err(|e| format!("Failed to pull alpine: {}", e))?;
            if !pull.status.success() {
                let err = String::from_utf8_lossy(&pull.stderr).trim().to_string();
                emit_bp(&app, vol, "Failed to pull alpine", 10, true, Some(err.clone()), None, None);
                return Err(err.into());
            }
        }

        // ── Pause running containers that use this volume ────────────────────────
        let running = get_running_containers_for_volume(vol);
        let mut paused: Vec<String> = Vec::new();

        if !running.is_empty() {
            let pause_cmd = format!("docker pause {}", running.join(" "));
            emit_bp(&app, vol,
                &format!("Pausing {} container{} for a consistent backup…", running.len(), if running.len() == 1 { "" } else { "s" }),
                30, false, None, None, Some(pause_cmd));

            for id in &running {
                let ok = hidden("docker")
                    .args(["pause", id])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if ok { paused.push(id.clone()); }
            }
            let skipped = running.len() - paused.len();
            if skipped > 0 {
                emit_bp(&app, vol,
                    &format!("Could not pause {} container{}. The backup will continue.", skipped, if skipped == 1 { "" } else { "s" }),
                    35, false, None, None, None);
            }
        }

        // ── Run the archive ──────────────────────────────────────────────────────
        let archive_cmd = format!(
            "docker run --rm --volume {}:/source:ro --volume {}:/backup alpine tar czf /backup/{} -C /source .",
            vol, docker_vol_dir, filename
        );
        emit_bp(&app, vol, "Creating archive…", 50, false, None, None, Some(archive_cmd));

        let archive_result = hidden("docker")
            .args([
                "run", "--rm",
                "--volume", &format!("{}:/source:ro", vol),
                "--volume", &format!("{}:/backup", docker_vol_dir),
                "alpine",
                "tar", "czf", &format!("/backup/{}", filename),
                "-C", "/source", ".",
            ])
            .output()
            .map_err(|e| format!("Failed to run docker: {}", e));

        // ── Always unpause, even on failure ─────────────────────────────────────
        if !paused.is_empty() {
            let unpause_cmd = format!("docker unpause {}", paused.join(" "));
            emit_bp(&app, vol, "Resuming containers…", 88, false, None, None, Some(unpause_cmd));
            for id in &paused {
                hidden("docker").args(["unpause", id]).output().ok();
            }
        }

        let output = archive_result?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            emit_bp(&app, vol, "Backup failed", 50, true, Some(err.clone()), None, None);
            return Err(err.into());
        }

        let size_bytes = fs::metadata(&backup_path).map(|m| m.len()).unwrap_or(0);

        emit_bp(&app, vol, "Saving backup record…", 95, false, None, None, None);
        let mut manifest = read_manifest(&backup_dir);
        manifest.backups.push(VolumeBackupEntry {
            filename: filename.clone(),
            volume: volume_name.clone(),
            path: backup_path,
            size_bytes,
            created_at: ts as i64,
        });
        write_manifest(&backup_dir, &manifest).ok();

        emit_bp(&app, vol, &format!("Saved as '{}'", filename), 100, true, None, Some(filename.clone()), None);
        Ok(filename)
    }).await
}

// `tar tzf` reads the whole archive first, so a damaged backup fails before anything is deleted.
// `find -mindepth 1 -delete` empties the volume but keeps its directory, including hidden
// files and nested folders. The filename arrives as `$1`, never as script text, so a file
// named `a;touch b.tar.gz` cannot run anything.
const RESTORE_SCRIPT: &str = "tar tzf \"/backup/$1\" > /dev/null && find /target -mindepth 1 -delete && tar xzf \"/backup/$1\" -C /target";

fn restore_args(volume: &str, backup_dir: &str, filename: &str) -> Vec<String> {
    [
        "run", "--rm",
        "--volume", &format!("{}:/target", volume),
        "--volume", &format!("{}:/backup:ro", backup_dir),
        "alpine",
        "sh", "-c", RESTORE_SCRIPT, "sh", filename,
    ]
    .map(String::from)
    .to_vec()
}

/// Restore a volume from a previously created `.tar.gz` archive.
/// Clears existing volume data before extracting.
#[tauri::command]
pub async fn docker_volume_restore(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    volume_name: String,
    backup_file: String,
) -> Result<(), AtlasError> {
    validate_docker_name(&volume_name)?;
    migration.inner().clone().run_operation(move || {
        let vol = &volume_name;

        let src_path = std::path::Path::new(&backup_file);
        if !src_path.exists() {
            return Err(AtlasError::new(ErrorKind::NotFound, format!("The backup file no longer exists: {}", backup_file))
                .hint("Refresh the backup list. The file may have been moved or deleted outside the app."));
        }

        let backup_dir = src_path
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or(".")
            .replace('\\', "/");

        let filename = src_path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("")
            .to_string();

        emit_bp(&app, vol, &format!("Restoring '{}' from '{}'…", vol, filename), 5, false, None, None, None);

        // ── Stop running containers that use the volume ──────────────────────────
        // Unlike backup (where pause is safe for a consistent snapshot), restore
        // replaces volume data entirely - containers must be fully stopped first.
        let running = get_running_containers_for_volume(vol);
        let mut stopped: Vec<String> = Vec::new();

        if !running.is_empty() {
            let stop_cmd = format!("docker stop {}", running.join(" "));
            emit_bp(&app, vol,
                &format!("Stopping {} container{} before restore…", running.len(), if running.len() == 1 { "" } else { "s" }),
                15, false, None, None, Some(stop_cmd));

            for id in &running {
                let ok = hidden("docker")
                    .args(["stop", id])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if ok {
                    stopped.push(id.clone());
                } else {
                    emit_bp(&app, vol,
                        &format!("Could not stop '{}'. The restore will continue.", id),
                        18, false, None, None, None);
                }
            }
        }

        // Ensure the target volume exists
        emit_bp(&app, vol, "Preparing volume…", 25, false, None, None,
            Some(format!("docker volume create {}", vol)));
        let create = hidden("docker")
            .args(["volume", "create", vol])
            .output()
            .map_err(|e| format!("Cannot create volume: {}", e))?;
        if !create.status.success() {
            let err = String::from_utf8_lossy(&create.stderr).trim().to_string();
            // Restart containers even on failure
            for id in &stopped {
                hidden("docker").args(["start", id]).output().ok();
            }
            emit_bp(&app, vol, "Failed to prepare volume", 25, true, Some(err.clone()), None, None);
            return Err(err.into());
        }

        // Windows PowerShell drops bare `"` when it calls a native program, so the
        // shown command escapes them.
        let docker_cmd = format!(
            "docker run --rm --volume {}:/target --volume {}:/backup:ro alpine sh -c '{}' sh '{}'",
            vol, backup_dir, RESTORE_SCRIPT.replace('"', "\\\""), filename.replace('\'', "''")
        );
        emit_bp(&app, vol, "Restoring data…", 45, false, None, None, Some(docker_cmd));

        let output = hidden("docker")
            .args(restore_args(vol, &backup_dir, &filename))
            .output()
            .map_err(|e| format!("Failed to run docker: {}", e))?;

        // ── Always restart stopped containers ────────────────────────────────────
        if !stopped.is_empty() {
            let start_cmd = format!("docker start {}", stopped.join(" "));
            emit_bp(&app, vol, "Restarting containers…", 92, false, None, None, Some(start_cmd));
            for id in &stopped {
                hidden("docker").args(["start", id]).output().ok();
            }
        }

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            emit_bp(&app, vol, "Restore failed", 45, true, Some(err.clone()), None, None);
            return Err(err.into());
        }

        emit_bp(&app, vol, &format!("Restore complete. '{}' is ready.", vol), 100, true, None, None, None);
        Ok(())
    }).await
}

use crate::shell::ShellOut;

/// Backup compose config files for a project.
/// - Skips files whose content is unchanged since the last backup (deduplication).
/// - Keeps at most 10 backups per (project, original_path), pruning the oldest.
/// - Tracks everything in `{root}/docker/compose/manifest.json`.
/// Returns only the entries that were actually saved (empty = no changes).
#[tauri::command]
pub async fn docker_backup_compose(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    project: String,
    config_files: Vec<String>,
    backup_dir: String,
) -> Result<Vec<ComposeBackupEntry>, AtlasError> {
    migration.inner().clone().run_operation(move || {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let compose_dir = docker_compose_dir(&backup_dir);
        fs::create_dir_all(&compose_dir)
            .map_err(|e| format!("Could not create the Compose backup folder: {}", e))?;

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut manifest = read_compose_manifest(&backup_dir);
        let mut saved: Vec<ComposeBackupEntry> = Vec::new();

        for src_str in &config_files {
            // Read the current file content
            let content = match read_source_as_string(src_str) {
                Ok(c)  => c,
                Err(e) => { eprintln!("Warning: cannot read '{}': {}", src_str, e); continue; }
            };

            // Deduplication: skip if content is identical to the most recent backup
            let last = manifest.backups.iter()
                .filter(|e| e.project == project && e.original_path == *src_str)
                .max_by_key(|e| e.created_at);

            if let Some(prev) = last {
                if std::path::Path::new(&prev.path).exists() {
                    if fs::read_to_string(&prev.path).ok().as_deref() == Some(&content) {
                        continue; // unchanged - skip
                    }
                }
            }

            let src_path = std::path::Path::new(src_str);
            let stem = src_path.file_stem().and_then(|s| s.to_str()).unwrap_or("compose");
            let ext  = src_path.extension().and_then(|e| e.to_str()).unwrap_or("yml");
            // ponytail: raw epoch-seconds filename, matching what volume backups use
            let filename  = format!("{}_{}__{}.{}", project, stem, ts, ext);
            let dest_path = format!("{}/{}", compose_dir.replace('\\', "/"), filename);

            // Emit the real PowerShell command the user could run themselves
            let display_src = if is_windows_absolute(src_str) {
                src_str.replace('/', "\\")
            } else {
                wsl_mount_to_windows(src_str)
                    .map(|p| p.replace('/', "\\"))
                    .unwrap_or_else(|| src_str.to_string())
            };
            let display_dest = dest_path.replace('/', "\\");
            app.emit("shell-out", ShellOut {
                text: format!("Copy-Item -Path \"{}\" -Destination \"{}\"", display_src, display_dest),
                stderr: false,
            }).ok();

            fs::write(&dest_path, &content)
                .map_err(|e| format!("Failed to write '{}': {}", dest_path, e))?;

            app.emit("shell-out", ShellOut {
                text: format!("  \u{2713} saved {}", filename),
                stderr: false,
            }).ok();

            let size_bytes = fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);

            let entry = ComposeBackupEntry {
                filename,
                project: project.clone(),
                original_path: src_str.clone(),
                path: dest_path,
                size_bytes,
                created_at: ts as i64,
            };
            manifest.backups.push(entry.clone());
            saved.push(entry);

            // Prune: keep only the 10 most recent backups for this (project, file)
            let mut for_file: Vec<_> = manifest.backups.iter()
                .filter(|e| e.project == project && e.original_path == *src_str)
                .cloned()
                .collect();
            for_file.sort_by(|a, b| b.created_at.cmp(&a.created_at));

            if for_file.len() > 10 {
                let stale_names: std::collections::HashSet<_> = for_file[10..]
                    .iter().map(|e| e.filename.clone()).collect();
                for old in &for_file[10..] { fs::remove_file(&old.path).ok(); }
                manifest.backups.retain(|e| !stale_names.contains(&e.filename));
            }
        }

        write_compose_manifest(&backup_dir, &manifest)?;
        Ok(saved)
    }).await
}

/// List all compose backups for a given project, most-recent first.
/// Entries whose archive files no longer exist are filtered out.
#[tauri::command]
pub async fn docker_list_compose_backups(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    backup_dir: String,
    project: String,
) -> Result<Vec<ComposeBackupEntry>, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let mut entries: Vec<_> = read_compose_manifest(&backup_dir)
            .backups
            .into_iter()
            .filter(|e| e.project == project && std::path::Path::new(&e.path).exists())
            .collect();
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(entries)
    }).await
}

/// Delete a single compose backup archive and remove it from the manifest.
#[tauri::command]
pub async fn docker_delete_compose_backup(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    backup_dir: String,
    filename: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let mut manifest = read_compose_manifest(&backup_dir);

        let path = manifest.backups.iter()
            .find(|e| e.filename == filename)
            .map(|e| e.path.clone())
            .unwrap_or_else(|| format!("{}/docker/compose/{}", backup_dir, filename));

        app.emit("shell-out", ShellOut {
            text:   format!("Remove-Item \"{}\"", path.replace('/', "\\")),
            stderr: false,
        }).ok();

        if std::path::Path::new(&path).exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete '{}': {}", path, e))?;
        }
        manifest.backups.retain(|e| e.filename != filename);
        write_compose_manifest(&backup_dir, &manifest)?;

        app.emit("shell-out", ShellOut {
            text:   format!("  \u{2713} deleted {}", filename),
            stderr: false,
        }).ok();
        Ok(())
    }).await
}

/// Returns true if `path` contains no files anywhere in its tree.
fn is_effectively_empty(path: &std::path::Path) -> bool {
    match std::fs::read_dir(path) {
        Ok(entries) => entries.flatten().all(|e| {
            let p = e.path();
            p.is_dir() && is_effectively_empty(&p)
        }),
        Err(_) => false,
    }
}

/// Move all volume backups (and compose files) from `from_root` to `to_root`.
/// Tries atomic rename first; falls back to copy+delete for cross-filesystem moves.
/// After transfer, removes the old directory tree if it is entirely empty.
#[tauri::command]
pub async fn transfer_backups(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    from_dir: String,
    to_dir: String,
) -> Result<TransferResult, AtlasError> {
    migration.inner().clone().run_operation(move || {
        use std::fs;

        if from_dir == to_dir {
            return Ok(TransferResult { moved: 0, old_dir_removed: false });
        }

        let dest_vols = docker_volumes_dir(&to_dir);
        fs::create_dir_all(&dest_vols)
            .map_err(|e| format!("Cannot create '{}': {}", dest_vols, e))?;

        let mut manifest = read_manifest(&from_dir);
        let mut transferred = 0u32;

        for entry in &mut manifest.backups {
            let src = std::path::Path::new(&entry.path);
            if !src.exists() {
                continue;
            }
            let fname = src
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(&entry.filename)
                .to_string();
            let dest = format!("{}/{}", dest_vols.replace('\\', "/"), fname);

            let ok = fs::rename(&entry.path, &dest).is_ok()
                || fs::copy(&entry.path, &dest).map(|_| { fs::remove_file(&entry.path).ok(); }).is_ok();

            if ok {
                entry.path = dest;
                transferred += 1;
            }
        }

        // Write updated manifest to new root, remove old manifests
        write_manifest(&to_dir, &manifest)?;
        fs::remove_file(format!("{}/backup_manifest.json", from_dir)).ok();
        fs::remove_file(format!("{}/docker/manifest.json", from_dir)).ok();

        // Transfer compose subdirectory (old flat or new docker/compose/)
        for src_compose in [
            format!("{}/docker/compose", from_dir.replace('\\', "/")),
            format!("{}/compose",        from_dir.replace('\\', "/")),
        ] {
            if !std::path::Path::new(&src_compose).exists() {
                continue;
            }
            let dst_compose = docker_compose_dir(&to_dir);
            if fs::create_dir_all(&dst_compose).is_ok() {
                if let Ok(entries) = fs::read_dir(&src_compose) {
                    for dir_entry in entries.flatten() {
                        let sf = dir_entry.path();
                        if let Some(name) = sf.file_name().and_then(|n| n.to_str()) {
                            let df = format!("{}/{}", dst_compose, name);
                            if fs::rename(&sf, &df).is_err() {
                                if fs::copy(&sf, &df).is_ok() {
                                    fs::remove_file(&sf).ok();
                                }
                            }
                        }
                    }
                }
            }
            break; // only migrate one source compose dir
        }

        // Remove the old root if nothing remains in it.
        let old_dir_removed = is_effectively_empty(std::path::Path::new(&from_dir))
            && std::fs::remove_dir_all(&from_dir).is_ok();

        Ok(TransferResult { moved: transferred, old_dir_removed })
    }).await
}

/// Delete a backup archive and remove its entry from the manifest.
#[tauri::command]
pub async fn docker_delete_backup(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    backup_dir: String,
    filename: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let mut manifest = read_manifest(&backup_dir);

        // Find the stored path from the manifest so we delete the right file.
        let path = manifest
            .backups
            .iter()
            .find(|e| e.filename == filename)
            .map(|e| e.path.clone())
            .unwrap_or_else(|| format!("{}/docker/volumes/{}", backup_dir, filename));

        app.emit("shell-out", ShellOut {
            text:   format!("Remove-Item \"{}\"", path.replace('/', "\\")),
            stderr: false,
        }).ok();

        if std::path::Path::new(&path).exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete '{}': {}", path, e))?;
        }

        manifest.backups.retain(|e| e.filename != filename);
        write_manifest(&backup_dir, &manifest)?;

        app.emit("shell-out", ShellOut {
            text:   format!("  \u{2713} deleted {}", filename),
            stderr: false,
        }).ok();
        Ok(())
    }).await
}

/// Open a native folder-picker dialog and return the selected path.
/// Returns `null` if the user cancels.
#[tauri::command]
pub async fn pick_backup_folder() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .pick_folder()
            .and_then(|p| p.to_str().map(|s| s.replace('\\', "/")))
    })
    .await
    .ok()
    .flatten()
}

// ─────────────────────────────────────────────────────────────────────────────
// App Metadata System - per-project metadata (favorites, tags, notes, etc.)
// Stored as JSON in the Tauri app-data directory.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct AppProjectMeta {
    #[serde(default)] pub favorite: bool,
    #[serde(default)] pub tags: Vec<String>,
    #[serde(default)] pub note: String,
    #[serde(default)] pub recent_opened: Option<String>,
    #[serde(default)] pub startup_times: Vec<u64>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AppMetadataStore {
    #[serde(default)]
    projects: std::collections::HashMap<String, AppProjectMeta>,
}

fn metadata_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AtlasError> {
    use tauri::Manager;
    let mut path = app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not find the app data folder: {}", e))?;
    path.push("compose_metadata.json");
    Ok(path)
}

fn read_metadata(app: &tauri::AppHandle) -> AppMetadataStore {
    metadata_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_metadata(app: &tauri::AppHandle, store: &AppMetadataStore) -> Result<(), AtlasError> {
    let path = metadata_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    Ok(std::fs::write(&path, json).map_err(|e| e.to_string())?)
}

/// Load all project metadata as a map keyed by project name.
#[tauri::command]
pub async fn metadata_load(
    app: tauri::AppHandle,
) -> Result<std::collections::HashMap<String, AppProjectMeta>, AtlasError> {
    let store = tauri::async_runtime::spawn_blocking(move || read_metadata(&app))
        .await
        .map_err(|e| e.to_string())?;
    Ok(store.projects)
}

/// Persist one project's metadata entry.
#[tauri::command]
pub async fn metadata_save_project(
    app: tauri::AppHandle,
    name: String,
    meta: AppProjectMeta,
) -> Result<(), AtlasError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AtlasError> {
        let mut store = read_metadata(&app);
        store.projects.insert(name, meta);
        write_metadata(&app, &store)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// Project file detection - Dockerfiles and .env files in a compose project dir
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct DetectedFile {
    pub path: String,
    pub kind: String, // "dockerfile" | "env"
}

// Directories never worth scanning for project Dockerfiles.
fn is_noise_dir(name: &str) -> bool {
    matches!(name,
        "node_modules" | ".git" | ".svn" | ".hg" | "vendor" | "dist" | "build"
        | "target" | "__pycache__" | ".next" | ".nuxt" | ".cache" | ".venv"
        | "venv" | "coverage" | ".idea" | ".vscode" | "bin" | "obj"
    )
}

fn is_dockerfile_name(name: &str) -> bool {
    name == "Dockerfile" || name.starts_with("Dockerfile.") || name.ends_with(".dockerfile")
}

fn is_env_name(name: &str) -> bool {
    name == ".env"
        || (name.starts_with(".env.") && !name.ends_with(".example") && !name.ends_with(".sample"))
}

// Recursively collect Dockerfiles under `dir` (depth-limited, skipping noise dirs)
// for Windows-accessible paths.
fn scan_dockerfiles_win(dir: &std::path::Path, depth: usize, max_depth: usize, out: &mut Vec<DetectedFile>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if depth < max_depth && !is_noise_dir(&name) {
                scan_dockerfiles_win(&entry.path(), depth + 1, max_depth, out);
            }
        } else if is_dockerfile_name(&name) {
            out.push(DetectedFile { path: entry.path().to_string_lossy().to_string(), kind: "dockerfile".into() });
        }
    }
}

/// Scan the directory containing `config_file` for Dockerfiles and .env files.
/// Dockerfiles are found recursively (depth-limited) so files referenced from
/// subdirectories - e.g. ./nginx/Dockerfile, ./php/Dockerfile - are detected,
/// not only ones sitting next to the compose file. .env is matched at the root
/// only. Handles Windows, WSL-mount, and pure-WSL paths.
fn wsl_project_files(dir: &str, max_depth: usize) -> Vec<DetectedFile> {
    let mut results = Vec::new();
    let depth = max_depth.to_string();
    let found = wsl_exec()
        .args([
            "find", dir, "-maxdepth", &depth,
            "(", "-name", "node_modules", "-o", "-name", ".git", "-o", "-name", "vendor",
            "-o", "-name", "target", "-o", "-name", "dist", "-o", "-name", "build", ")", "-prune",
            "-o", "-type", "f", "(", "-name", "Dockerfile", "-o", "-name", "Dockerfile.*", "-o", "-name", "*.dockerfile", ")", "-print",
        ])
        .output();
    if let Ok(out) = found {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let p = line.trim();
            if !p.is_empty() {
                results.push(DetectedFile { path: p.to_string(), kind: "dockerfile".into() });
            }
        }
    }
    // .env at the project root
    if let Ok(out) = wsl_exec().args(["ls", "-1", dir]).output() {
        for name in String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim()) {
            if is_env_name(name) {
                results.push(DetectedFile { path: format!("{}/{}", dir, name), kind: "env".into() });
            }
        }
    }
    results
}

#[tauri::command]
pub async fn detect_compose_project_files(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    config_file: String,
) -> Result<Vec<DetectedFile>, AtlasError> {
    migration.inner().clone().run_operation(move || {
        const MAX_DEPTH: usize = 3;

        // Derive project dir from config_file path
        let dir = if is_windows_absolute(&config_file) {
            let p = std::path::Path::new(&config_file);
            p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default()
        } else if let Some(win) = wsl_mount_to_windows(&config_file) {
            let p = std::path::Path::new(&win);
            p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default()
        } else {
            // Pure WSL: use parent by splitting on '/'
            let p = std::path::Path::new(&config_file);
            p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default()
        };

        let mut results: Vec<DetectedFile> = Vec::new();

        if is_windows_absolute(&config_file) || wsl_mount_to_windows(&config_file).is_some() {
            // Windows-accessible path - recurse for Dockerfiles, root-only for .env
            let base = std::path::Path::new(&dir);
            scan_dockerfiles_win(base, 0, MAX_DEPTH, &mut results);
            if let Ok(entries) = std::fs::read_dir(base) {
                let sep = if dir.contains('\\') { '\\' } else { '/' };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if is_env_name(&name) {
                        results.push(DetectedFile { path: format!("{}{}{}", dir, sep, name), kind: "env".into() });
                    }
                }
            }
        } else {
            // Pure WSL - recursive `find` for Dockerfiles, root `ls` for .env
            results.extend(wsl_project_files(&dir, MAX_DEPTH));
        }

        // De-dupe by path, then order Dockerfiles before .env (and by path within each)
        results.sort_by(|a, b| a.path.cmp(&b.path));
        results.dedup_by(|a, b| a.path == b.path);
        results.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.path.cmp(&b.path)));

        Ok(results)
    }).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor detection - find code editors available in PATH
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct EditorInfo {
    pub name:    String,
    pub command: String,
}

pub(crate) fn is_in_path(cmd: &str) -> bool {
    hidden("where.exe")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

const EDITORS: [(&str, &str); 5] = [
    ("VS Code",     "code"),
    ("Cursor",      "cursor"),
    ("Sublime Text","subl"),
    ("Notepad++",   "notepad++"),
    ("Notepad",     "notepad"),
];

/// Detect code editors available in PATH on Windows.
#[tauri::command]
pub async fn detect_editors() -> Vec<EditorInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        EDITORS.iter()
            .filter(|(_, cmd)| is_in_path(cmd))
            .map(|(name, cmd)| EditorInfo { name: name.to_string(), command: cmd.to_string() })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// `cmd /C` reads `&` in an unquoted argument as a second command, and Rust only quotes
/// arguments with spaces. Windows file names cannot hold `"`, but WSL file names can.
fn quoted_for_cmd(path: &str) -> Result<String, AtlasError> {
    if path.contains('"') {
        return Err(AtlasError::invalid(format!("'{}' cannot be opened in an editor because its path contains a double quote.", path)));
    }
    Ok(format!("\"{}\"", path))
}

/// Only the known editors run, because an imported configuration file can set any command here.
fn editor_command(editor_cmd: &str, path: &str) -> Result<Command, AtlasError> {
    if !EDITORS.iter().any(|(_, cmd)| *cmd == editor_cmd) {
        return Err(AtlasError::invalid(format!("\"{}\" is not a supported editor.", editor_cmd)));
    }
    let quoted = quoted_for_cmd(path)?;
    let mut cmd = hidden("cmd");
    cmd.args(["/C", editor_cmd]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(quoted);
    }
    Ok(cmd)
}

/// Open a file in an external editor, detached from the app process.
///
/// Two Windows pitfalls handled here:
///  1. Editor CLIs like VS Code's `code` are `.cmd` shims - `Command::new("code")`
///     fails with "is not a valid Win32 application" because the loader only
///     auto-appends `.exe`. Going through `cmd /C` lets PATHEXT resolve the shim.
///  2. A pure-WSL path (`/home/…`) means nothing to a Windows editor, so it is
///     first converted to its `\\wsl.localhost\…` UNC form.
#[tauri::command]
pub async fn open_in_editor(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    path: String,
    editor_cmd: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let win_path = to_windows_path(&path);
        let mut c = editor_command(&editor_cmd, &win_path)?;
        Ok(c.spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open '{}' with '{}': {}", win_path, editor_cmd, e))?)
    }).await
}

/// Reveal a file in Windows Explorer (selecting it), converting WSL paths to
/// their UNC form first so `/home/…` files open correctly.
#[tauri::command]
pub async fn reveal_path(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    path: String,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || {
        let win = to_windows_path(&path);
        let mut c = Command::new("explorer");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.raw_arg(format!("/select,\"{}\"", win));
        }
        #[cfg(not(windows))]
        {
            c.arg(format!("/select,{}", win));
        }
        // explorer.exe returns a non-zero exit code even on success, so we only
        // surface a spawn failure.
        Ok(c.spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not show '{}' in File Explorer: {}", win, e))?)
    }).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose config validator - docker compose config
// ─────────────────────────────────────────────────────────────────────────────

/// Run `docker compose config` and return the resolved YAML string.
/// On error, returns the stderr as the Err string.
#[tauri::command]
pub async fn docker_compose_config(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    config_file: String,
) -> Result<String, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let (mut cmd, _) = compose_base(&config_file);
        let output = cmd.arg("config").output()
            .map_err(|e| format!("Failed to run docker compose config: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8(output.stdout)
                .map_err(|_| "docker compose config returned text that is not valid UTF-8.".to_string())?)
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into())
        }
    }).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Log multiplexer - stream compose logs with Rust-side batching (75 ms)
// ─────────────────────────────────────────────────────────────────────────────

/// Managed state holding the currently-running log stream process.
pub struct ComposeLogState(pub std::sync::Arc<std::sync::Mutex<Option<std::process::Child>>>);

/// Start streaming `docker compose logs -f [services...]` to the frontend via
/// `compose-log-batch` events. Lines are buffered for 75 ms before emitting
/// to prevent event channel saturation. Any previous stream is killed first.
#[tauri::command]
pub async fn compose_logs_watch(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app:         tauri::AppHandle,
    state:       tauri::State<'_, ComposeLogState>,
    config_file: String,
    services:    Vec<String>,
) -> Result<(), AtlasError> {
    // Kill any previous stream
    {
        // A poisoned lock still holds a usable handle, and one panic must not break logs for good.
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut child) = *guard { child.kill().ok(); }
        *guard = None;
    }

    let child_arc = state.0.clone();
    migration.inner().clone().run_operation(move || {
        let svc_refs: Vec<&str> = services.iter().map(|s| s.as_str()).collect();

        let (mut cmd, _) = compose_base(&config_file);
        cmd.args(["logs", "--tail=200", "-f"]);
        cmd.args(&svc_refs);
        let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
            .map_err(|e| format!("Failed to start log stream: {}", e))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Store child so compose_logs_stop can kill it
        *child_arc.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

        // Merge stdout + stderr into one channel via a shared sender
        let (tx, rx) = std::sync::mpsc::channel::<String>();

        let tx2 = tx.clone();
        if let Some(out) = stdout {
            thread::spawn(move || {
                BufReader::new(out).lines().flatten().for_each(|l| { tx.send(l).ok(); });
            });
        }
        if let Some(err) = stderr {
            thread::spawn(move || {
                BufReader::new(err).lines().flatten().for_each(|l| { tx2.send(l).ok(); });
            });
        }

        // Batch reader: collect for 75 ms then emit
        let mut buf: Vec<String> = Vec::new();
        let mut last = std::time::Instant::now();

        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(75)) {
                Ok(line) => {
                    buf.push(line);
                    if buf.len() >= 100 || last.elapsed().as_millis() >= 75 {
                        if !buf.is_empty() {
                            app.emit("compose-log-batch", buf.clone()).ok();
                            buf.clear();
                        }
                        last = std::time::Instant::now();
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if !buf.is_empty() {
                        app.emit("compose-log-batch", buf.clone()).ok();
                        buf.clear();
                    }
                    last = std::time::Instant::now();
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // Both reader threads exited - process ended
                    if !buf.is_empty() {
                        app.emit("compose-log-batch", buf.clone()).ok();
                    }
                    break;
                }
            }
        }

        app.emit("compose-log-done", true).ok();
        Ok(())
    }).await
}

/// Stop the currently-running compose log stream.
#[tauri::command]
pub async fn compose_logs_stop(
    state: tauri::State<'_, ComposeLogState>,
) -> Result<(), AtlasError> {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut child) = *guard { child.kill().ok(); }
    *guard = None;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests - pure parsers only (no Docker, WSL, or filesystem access)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_names_reject_anything_docker_would_not_allow() {
        for good in ["a", "web", "my_app-db.1", "9f3c2a"] {
            assert!(validate_docker_name(good).is_ok(), "{good}");
        }
        for bad in ["", "-x", ".x", "_x", "a b", "a;calc", "$(calc)", "C:/Users", "/etc", "..", "a:b", "a\nb", "é"] {
            assert!(validate_docker_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_ampersand_in_a_path_cannot_start_a_second_command() {
        use std::os::windows::process::CommandExt;
        let path = "C:\\x\\Dockerfile.&hostname";
        let lines_from = |mut cmd: Command| {
            let out = cmd.output().unwrap();
            String::from_utf8_lossy(&out.stdout).lines().count()
        };

        let mut unquoted = hidden("cmd");
        unquoted.args(["/C", "echo", path]);
        assert_eq!(lines_from(unquoted), 2, "cmd runs the second command without quotes");

        let mut quoted = hidden("cmd");
        quoted.args(["/C", "echo"]);
        quoted.raw_arg(quoted_for_cmd(path).unwrap());
        assert_eq!(lines_from(quoted), 1);
    }

    #[test]
    fn only_known_editors_run_and_quotes_in_paths_are_refused() {
        assert!(editor_command("code", "C:\\x\\a.yml").is_ok());
        assert!(editor_command("calc & code", "C:\\x\\a.yml").is_err());
        assert!(editor_command("calc", "C:\\x\\a.yml").is_err());
        assert!(editor_command("code", "\\\\wsl.localhost\\d\\a\"&calc&\".yml").is_err());
    }

    #[test]
    fn wsl_commands_skip_the_linux_shell() {
        let args: Vec<_> = wsl_exec().args(["cat", "/x"]).get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["-e", "cat", "/x"]);
        let (cmd, _) = compose_base("/home/me/a;b/compose.yml");
        assert_eq!(cmd.get_args().next().unwrap(), "-e");
    }

    // Writes only under /tmp in the default distro, which this starts if it is stopped.
    #[test]
    #[ignore = "needs WSL"]
    fn wsl_paths_stay_plain_text_for_real() {
        use std::io::Write as _;
        let dir = format!("/tmp/atlas-wsl-test-{}", std::process::id());
        let run = |args: &[&str]| assert!(wsl_exec().args(args).status().unwrap().success(), "{args:?}");
        run(&["mkdir", "-p", &format!("{dir}/app/node_modules"), &format!("{dir}/app/sub")]);

        let name = format!("{dir}/app/a b;echo x;$(echo EXPANDED)&.env");
        let mut tee = wsl_exec()
            .args(["tee", &name])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        tee.stdin.take().unwrap().write_all(b"KEY=1\n").unwrap();
        assert!(tee.wait().unwrap().success());
        assert_eq!(read_via_wsl(&name, 1000).unwrap(), b"KEY=1\n");

        run(&["touch", &format!("{dir}/app/Dockerfile"), &format!("{dir}/app/sub/api.dockerfile"), &format!("{dir}/app/node_modules/Dockerfile")]);
        let found: Vec<String> = wsl_project_files(&format!("{dir}/app"), 3)
            .into_iter()
            .filter(|f| f.kind == "dockerfile")
            .map(|f| f.path)
            .collect();
        run(&["rm", "-rf", &dir]);

        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found.iter().all(|p| !p.contains("node_modules")), "{found:?}");
    }

    #[test]
    fn a_failed_command_reports_its_last_error_line() {
        use std::os::windows::process::ExitStatusExt;
        let ok = std::process::ExitStatus::from_raw(0);
        let failed = std::process::ExitStatus::from_raw(1);

        assert!(streaming_result(ok, "a warning on stderr").is_ok());
        let named = streaming_result(failed, "  port is already allocated\n").unwrap_err();
        assert_eq!(named.message, "port is already allocated");
        let unnamed = streaming_result(failed, "").unwrap_err();
        assert!(unnamed.message.contains("exit code: 1"), "{}", unnamed.message);
    }

    #[test]
    fn restore_checks_the_archive_before_it_deletes_anything() {
        let check = RESTORE_SCRIPT.find("tar tzf").unwrap();
        let delete = RESTORE_SCRIPT.find("-delete").unwrap();
        assert!(check < delete);
    }

    #[test]
    fn restore_keeps_the_filename_out_of_the_script() {
        let filename = "a;touch pwned;$(calc).tar.gz";
        let args = restore_args("data", "C:/backups", filename);
        assert_eq!(args.last().unwrap(), filename);
        let script = &args[args.iter().position(|a| a == "-c").unwrap() + 1];
        assert_eq!(script, RESTORE_SCRIPT);
        assert!(!script.contains("pwned"));
    }

    #[test]
    fn bytes_to_human_picks_the_right_scale() {
        assert_eq!(bytes_to_human(2_540_000_000), "2.54 GB");
        assert_eq!(bytes_to_human(187_000_000), "187.0 MB");
        assert_eq!(bytes_to_human(145_300), "145 kB");
        assert_eq!(bytes_to_human(512), "512 B");
    }

    #[test]
    fn split_df_line_keeps_multiword_columns_and_percentages() {
        let cols = split_df_line("Local Volumes   3    2    1.5GB   500MB (33%)");
        assert_eq!(cols, vec!["Local Volumes", "3", "2", "1.5GB", "500MB (33%)"]);
    }

    #[test]
    fn parse_stopped_days_reads_status_string() {
        assert_eq!(parse_stopped_days("running", "Up 2 days"), -1);
        assert_eq!(parse_stopped_days("dead", ""), 999);
        assert_eq!(parse_stopped_days("exited", "Exited (0) 3 weeks ago"), 21);
        assert_eq!(parse_stopped_days("exited", "Exited (1) 2 months ago"), 60);
        assert_eq!(parse_stopped_days("exited", "Exited (0) 5 minutes ago"), 0);
    }

    #[test]
    fn parse_age_days_approximates_units() {
        assert_eq!(parse_age_days("3 weeks ago"), 21);
        assert_eq!(parse_age_days("2 months ago"), 60);
        assert_eq!(parse_age_days("5 hours ago"), 0);
        assert_eq!(parse_age_days("1 year ago"), 365);
        assert_eq!(parse_age_days(""), 0);
    }

    #[test]
    fn parse_iec_bytes_handles_binary_and_si_suffixes() {
        assert_eq!(parse_iec_bytes("512KiB"), 524_288);
        assert_eq!(parse_iec_bytes("1MiB"), 1_048_576);
        assert_eq!(parse_iec_bytes("23.5MiB"), 24_641_536);
        assert_eq!(parse_iec_bytes("128B"), 128);
        assert_eq!(parse_iec_bytes("1.5GB"), 1_500_000_000);
    }

    #[test]
    fn parse_mem_used_takes_the_used_side() {
        assert_eq!(parse_mem_used("100MiB / 2GiB"), 104_857_600);
    }

    #[test]
    fn is_windows_absolute_detects_drive_letters() {
        assert!(is_windows_absolute("C:\\Users"));
        assert!(is_windows_absolute("C:/Users"));
        assert!(!is_windows_absolute("/home/me"));
        assert!(!is_windows_absolute("relative"));
        assert!(!is_windows_absolute("1:/x"));
    }

    #[test]
    fn wsl_mount_to_windows_maps_only_mnt_paths() {
        assert_eq!(wsl_mount_to_windows("/mnt/c/Users/foo").as_deref(), Some("C:\\Users\\foo"));
        assert_eq!(wsl_mount_to_windows("/mnt/d/data").as_deref(), Some("D:\\data"));
        assert_eq!(wsl_mount_to_windows("/mnt/c").as_deref(), Some("C:\\"));
        assert_eq!(wsl_mount_to_windows("/home/me"), None);
        assert_eq!(wsl_mount_to_windows("C:\\x"), None);
    }

    #[test]
    fn parse_label_extracts_value_by_key() {
        let labels = "com.docker.compose.project=myapp,com.docker.compose.service=web";
        assert_eq!(parse_label(labels, "com.docker.compose.project").as_deref(), Some("myapp"));
        assert_eq!(parse_label(labels, "com.docker.compose.service").as_deref(), Some("web"));
        assert_eq!(parse_label(labels, "missing"), None);
    }

    #[test]
    fn parse_pct_handles_dashes_and_values() {
        assert!((parse_pct("12.34%") - 12.34).abs() < 1e-9);
        assert_eq!(parse_pct("--"), 0.0);
        assert_eq!(parse_pct("N/A"), 0.0);
        assert_eq!(parse_pct("0%"), 0.0);
    }
}
