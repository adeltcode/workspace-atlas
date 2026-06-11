use std::process::{Command, Stdio};

use tauri::Emitter;

/// Emitted as a `shell-out` event so the bottom terminal shows the real commands.
#[derive(serde::Serialize, Clone)]
struct ShellOut {
    text: String,
    stderr: bool,
}

fn emit_line(app: &tauri::AppHandle, text: impl Into<String>, stderr: bool) {
    app.emit("shell-out", ShellOut { text: text.into(), stderr }).ok();
}

/// Emit a copy-pasteable file write as a here-string block, line by line:
///   $ <head>
///   <content…>
///   <tail>
fn emit_write_block(app: &tauri::AppHandle, head: String, content: &str, tail: String) {
    emit_line(app, format!("$ {}", head), false);
    for line in content.lines() {
        emit_line(app, line.to_string(), false);
    }
    emit_line(app, tail, false);
}

/// File name component of a path, for terse result lines.
fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct WslStatus {
    /// True when the `wsl.exe` binary is present on the system.
    pub available: bool,
    pub error: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct WslDistro {
    pub name: String,
    /// WSL version: 1 (folder-based) or 2 (ext4.vhdx). 0 = unknown.
    pub version: u32,
    pub running: bool,
    pub is_default: bool,
    /// Distro install directory (Windows path), with the `\\?\` prefix stripped.
    pub base_path: String,
    /// Full path to `ext4.vhdx`. Empty for WSL1 distros or if the file is missing.
    pub vhd_path: String,
    /// On-disk size of the VHD file in bytes (0 = unknown / WSL1).
    pub vhd_size_bytes: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct WslConfig {
    /// Full path to %USERPROFILE%\.wslconfig.
    pub path: String,
    pub content: String,
    /// False when the file does not exist yet (content is then empty).
    pub exists: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

fn wslconfig_path() -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE is not set".to_string())?;
    Ok(format!("{}\\.wslconfig", home))
}

/// Read %USERPROFILE%\.wslconfig. A missing file is not an error — it returns
/// `exists: false` with empty content so the UI can offer a template.
#[tauri::command]
pub async fn read_wslconfig(app: tauri::AppHandle) -> Result<WslConfig, String> {
    let path = wslconfig_path()?;
    let win = path.replace('/', "\\");
    emit_line(&app, format!("$ Get-Content \"{}\"", win), false);
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            emit_line(&app, format!("  ✓ loaded {}", win), false);
            Ok(WslConfig { path, content, exists: true })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            emit_line(&app, "  # .wslconfig does not exist yet", false);
            Ok(WslConfig { path, content: String::new(), exists: false })
        }
        Err(e) => Err(format!("Cannot read .wslconfig: {}", e)),
    }
}

/// Write %USERPROFILE%\.wslconfig. Changes take effect after `wsl --shutdown`.
#[tauri::command]
pub async fn write_wslconfig(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let path = wslconfig_path()?;
    let win = path.replace('/', "\\");
    emit_write_block(&app, format!("Set-Content -Path \"{}\" -Value @'", win), &content, "'@".to_string());
    match std::fs::write(&path, &content) {
        Ok(_) => {
            emit_line(&app, format!("  ✓ saved {}", win), false);
            Ok(())
        }
        Err(e) => {
            let msg = format!("Cannot write .wslconfig: {}", e);
            emit_line(&app, format!("  ✗ {}", msg), true);
            Err(msg)
        }
    }
}

// ── .wslconfig backup / restore ────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct WslConfigBackup {
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    /// Unix timestamp (seconds), parsed from the filename.
    pub created_at: i64,
}

fn wslconfig_backup_dir(root: &str) -> String {
    format!("{}/wsl/wslconfig", root.replace('\\', "/"))
}

/// List `.wslconfig` backups under `{root}/wsl/wslconfig`, most-recent first.
fn list_wslconfig_backups_sync(root: &str) -> Vec<WslConfigBackup> {
    let dir = wslconfig_backup_dir(root);
    let mut out: Vec<WslConfigBackup> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let ts = name.strip_prefix("wslconfig_")?.strip_suffix(".conf")?;
                let created_at = ts.parse::<i64>().ok()?;
                let size_bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
                Some(WslConfigBackup {
                    filename: name,
                    path: e.path().to_string_lossy().to_string(),
                    size_bytes,
                    created_at,
                })
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Snapshot the current `.wslconfig` to `{root}/wsl/wslconfig/wslconfig_{ts}.conf`.
/// Skips writing a duplicate if the newest backup is byte-identical. Keeps the 20
/// most recent. Errors if `.wslconfig` does not exist yet.
#[tauri::command]
pub async fn wslconfig_backup(app: tauri::AppHandle, backup_dir: String) -> Result<WslConfigBackup, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let src = wslconfig_path()?;
    let content = std::fs::read_to_string(&src)
        .map_err(|e| format!("Cannot read .wslconfig: {}", e))?;

    // De-dup against the most recent backup.
    let existing = list_wslconfig_backups_sync(&backup_dir);
    if let Some(latest) = existing.first() {
        if std::fs::read_to_string(&latest.path).ok().as_deref() == Some(content.as_str()) {
            emit_line(&app, format!("# .wslconfig unchanged — keeping {}", latest.filename), false);
            return Ok(latest.clone());
        }
    }

    let dir = wslconfig_backup_dir(&backup_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create backup dir: {}", e))?;

    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let filename = format!("wslconfig_{}.conf", ts);
    let path = format!("{}/{}", dir, filename);

    emit_line(&app, format!("$ Copy-Item -Path \"{}\" -Destination \"{}\"", src.replace('/', "\\"), path.replace('/', "\\")), false);
    std::fs::write(&path, &content).map_err(|e| format!("Cannot write backup: {}", e))?;
    emit_line(&app, format!("  ✓ backed up {}", filename), false);

    // Prune to the 20 most recent.
    for stale in list_wslconfig_backups_sync(&backup_dir).into_iter().skip(20) {
        std::fs::remove_file(&stale.path).ok();
    }

    Ok(WslConfigBackup {
        filename,
        path,
        size_bytes: content.len() as u64,
        created_at: ts as i64,
    })
}

/// List all `.wslconfig` backups, most-recent first.
#[tauri::command]
pub async fn wslconfig_list_backups(backup_dir: String) -> Result<Vec<WslConfigBackup>, String> {
    Ok(list_wslconfig_backups_sync(&backup_dir))
}

/// Restore a backup over `.wslconfig`, returning the restored content so the UI
/// can refresh. Changes take effect after `wsl --shutdown`.
#[tauri::command]
pub async fn wslconfig_restore(app: tauri::AppHandle, backup_path: String) -> Result<String, String> {
    let dest = wslconfig_path()?;
    let content = std::fs::read_to_string(&backup_path)
        .map_err(|e| format!("Cannot read backup: {}", e))?;
    emit_line(&app, format!("$ Copy-Item -Path \"{}\" -Destination \"{}\"", backup_path.replace('/', "\\"), dest.replace('/', "\\")), false);
    std::fs::write(&dest, &content).map_err(|e| format!("Cannot write .wslconfig: {}", e))?;
    emit_line(&app, format!("  ✓ restored {}", dest.replace('/', "\\")), false);
    Ok(content)
}

/// Delete a single `.wslconfig` backup.
#[tauri::command]
pub async fn wslconfig_delete_backup(app: tauri::AppHandle, backup_path: String) -> Result<(), String> {
    emit_line(&app, format!("$ Remove-Item \"{}\"", backup_path.replace('/', "\\")), false);
    if std::path::Path::new(&backup_path).exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|e| format!("Cannot delete backup: {}", e))?;
    }
    emit_line(&app, format!("  ✓ deleted {}", file_name_of(&backup_path)), false);
    Ok(())
}

// ── /etc/wsl.conf (per-distro) read / write / backup / restore ──────────────────
//
// wsl.conf lives inside the distro's Linux filesystem. Reading boots the distro;
// writing needs root inside it (`wsl -u root tee`) — no Windows UAC. WSL_UTF8
// keeps output readable.

/// Read a distro's `/etc/wsl.conf` (no event emission). Returns (content, exists).
fn cat_wsl_conf(distro: &str) -> (String, bool) {
    match Command::new("wsl")
        .env("WSL_UTF8", "1")
        .args(["-d", distro, "-u", "root", "cat", "/etc/wsl.conf"])
        .output()
    {
        Ok(o) if o.status.success() => (String::from_utf8_lossy(&o.stdout).to_string(), true),
        _ => (String::new(), false),
    }
}

/// Write a distro's `/etc/wsl.conf` as root via `tee` (no event emission).
fn tee_wsl_conf(distro: &str, content: &str) -> Result<(), String> {
    use std::io::Write as _;
    let mut child = Command::new("wsl")
        .env("WSL_UTF8", "1")
        .args(["-d", distro, "-u", "root", "tee", "/etc/wsl.conf"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to write wsl.conf: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(content.as_bytes()).map_err(|e| format!("Write error: {}", e))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Read `/etc/wsl.conf` from a distro. A missing file is reported, not an error.
#[tauri::command]
pub async fn read_wsl_conf(app: tauri::AppHandle, distro: String) -> Result<WslConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let display_path = format!("\\\\wsl.localhost\\{}\\etc\\wsl.conf", distro);
        emit_line(&app, format!("$ wsl -d {} -u root cat /etc/wsl.conf", distro), false);
        let (content, exists) = cat_wsl_conf(&distro);
        emit_line(&app, if exists {
            format!("  ✓ loaded {}", display_path)
        } else {
            "  # wsl.conf does not exist yet".to_string()
        }, false);
        Ok(WslConfig { path: display_path, content, exists })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write `/etc/wsl.conf` inside a distro as root. Takes effect after `wsl --shutdown`.
#[tauri::command]
pub async fn write_wsl_conf(app: tauri::AppHandle, distro: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_write_block(&app, "@'".to_string(), &content, format!("'@ | wsl -d {} -u root tee /etc/wsl.conf", distro));
        match tee_wsl_conf(&distro, &content) {
            Ok(()) => {
                emit_line(&app, format!("  ✓ saved \\\\wsl.localhost\\{}\\etc\\wsl.conf", distro), false);
                Ok(())
            }
            Err(e) => {
                emit_line(&app, format!("  ✗ {}", e), true);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Filesystem-safe form of a distro name for use in a backup filename.
fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_') { c } else { '_' })
        .collect()
}

fn wslconf_backup_dir(root: &str) -> String {
    format!("{}/wsl/wslconf", root.replace('\\', "/"))
}

fn list_wslconf_backups_sync(root: &str, distro: &str) -> Vec<WslConfigBackup> {
    let dir = wslconf_backup_dir(root);
    let prefix = format!("{}_", safe_name(distro));
    let mut out: Vec<WslConfigBackup> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let ts = name.strip_prefix(&prefix)?.strip_suffix(".conf")?;
                let created_at = ts.parse::<i64>().ok()?;
                let size_bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
                Some(WslConfigBackup { filename: name, path: e.path().to_string_lossy().to_string(), size_bytes, created_at })
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Snapshot a distro's `/etc/wsl.conf` to `{root}/wsl/wslconf/{distro}_{ts}.conf`.
/// De-dups against the newest backup; keeps the 20 most recent per distro.
#[tauri::command]
pub async fn wsl_conf_backup(app: tauri::AppHandle, distro: String, backup_dir: String) -> Result<WslConfigBackup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::time::{SystemTime, UNIX_EPOCH};

        let (content, exists) = cat_wsl_conf(&distro);
        if !exists {
            return Err("No wsl.conf to back up yet.".to_string());
        }

        let existing = list_wslconf_backups_sync(&backup_dir, &distro);
        if let Some(latest) = existing.first() {
            if std::fs::read_to_string(&latest.path).ok().as_deref() == Some(content.as_str()) {
                emit_line(&app, format!("# wsl.conf unchanged — keeping {}", latest.filename), false);
                return Ok(latest.clone());
            }
        }

        let dir = wslconf_backup_dir(&backup_dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create backup dir: {}", e))?;
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let filename = format!("{}_{}.conf", safe_name(&distro), ts);
        let path = format!("{}/{}", dir, filename);

        emit_line(&app, format!("$ wsl -d {} -u root cat /etc/wsl.conf | Out-File -Encoding utf8 \"{}\"", distro, path.replace('/', "\\")), false);
        std::fs::write(&path, &content).map_err(|e| format!("Cannot write backup: {}", e))?;
        emit_line(&app, format!("  ✓ backed up {}", filename), false);

        for stale in list_wslconf_backups_sync(&backup_dir, &distro).into_iter().skip(20) {
            std::fs::remove_file(&stale.path).ok();
        }

        Ok(WslConfigBackup { filename, path, size_bytes: content.len() as u64, created_at: ts as i64 })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List a distro's wsl.conf backups, most-recent first.
#[tauri::command]
pub async fn wsl_conf_list_backups(distro: String, backup_dir: String) -> Result<Vec<WslConfigBackup>, String> {
    Ok(list_wslconf_backups_sync(&backup_dir, &distro))
}

/// Restore a backup into a distro's `/etc/wsl.conf`, returning the restored content.
#[tauri::command]
pub async fn wsl_conf_restore(app: tauri::AppHandle, distro: String, backup_path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&backup_path)
        .map_err(|e| format!("Cannot read backup: {}", e))?;
    let returned = content.clone();
    tauri::async_runtime::spawn_blocking(move || {
        emit_line(&app, format!("$ Get-Content \"{}\" | wsl -d {} -u root tee /etc/wsl.conf", backup_path.replace('/', "\\"), distro), false);
        match tee_wsl_conf(&distro, &content) {
            Ok(()) => {
                emit_line(&app, format!("  ✓ restored \\\\wsl.localhost\\{}\\etc\\wsl.conf", distro), false);
                Ok(())
            }
            Err(e) => {
                emit_line(&app, format!("  ✗ {}", e), true);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(returned)
}

/// Delete a single wsl.conf backup.
#[tauri::command]
pub async fn wsl_conf_delete_backup(app: tauri::AppHandle, backup_path: String) -> Result<(), String> {
    emit_line(&app, format!("$ Remove-Item \"{}\"", backup_path.replace('/', "\\")), false);
    if std::path::Path::new(&backup_path).exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|e| format!("Cannot delete backup: {}", e))?;
    }
    emit_line(&app, format!("  ✓ deleted {}", file_name_of(&backup_path)), false);
    Ok(())
}

/// Shut down all running distros (`wsl --shutdown`) so .wslconfig changes apply.
/// Not elevated, but stops every running distro — the UI warns first.
#[tauri::command]
pub async fn wsl_shutdown() -> Result<(), String> {
    let out = Command::new("wsl")
        .arg("--shutdown")
        .output()
        .map_err(|e| format!("Failed to run wsl --shutdown: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(serde::Serialize, Clone)]
pub struct OptimizeResult {
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub reclaimed_bytes: u64,
    /// Which backend ran: "Optimize-VHD" (Hyper-V) or "diskpart".
    pub method: String,
}

/// Escape a string for embedding inside a single-quoted PowerShell literal.
fn ps_single_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// Compact a distro's ext4.vhdx, reclaiming unused space. Requires admin, so a
/// single elevated PowerShell child is spawned via UAC (the app stays
/// unprivileged). The child shuts WSL down, then prefers `Optimize-VHD -Mode
/// Full` and falls back to `diskpart compact vdisk` on editions without Hyper-V.
///
/// The before/after sizes are measured by the unprivileged parent (the VHD is
/// user-readable); the elevated child only reports success/failure and method
/// via a temp file, since output cannot cross the integrity boundary.
#[tauri::command]
pub async fn wsl_optimize_vhd(
    app: tauri::AppHandle,
    vhd_path: String,
) -> Result<OptimizeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let before = std::fs::metadata(&vhd_path)
            .map(|m| m.len())
            .map_err(|e| format!("Cannot read VHD '{}': {}", vhd_path, e))?;

        let tmp = std::env::temp_dir();
        let script_path = tmp.join("atlas_wsl_optimize.ps1");
        let result_path = tmp.join("atlas_wsl_optimize_result.txt");
        let script_str = script_path.to_string_lossy().to_string();
        let result_str = result_path.to_string_lossy().to_string();

        // Stale result from a previous run would be misread — remove it first.
        std::fs::remove_file(&result_path).ok();

        // Inner script runs elevated. Placeholders avoid format! brace-escaping.
        let inner = INNER_OPTIMIZE_PS
            .replace("__VHD__", &ps_single_quote(&vhd_path))
            .replace("__OUT__", &ps_single_quote(&result_str));
        std::fs::write(&script_path, inner)
            .map_err(|e| format!("Cannot write optimize script: {}", e))?;

        emit_line(&app, format!("# Optimizing {} — administrator approval required", vhd_path), false);
        emit_line(&app, "$ wsl --shutdown", false);

        // Outer (unprivileged) launches the elevated child and waits for it.
        let outer = format!(
            "try {{ $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"{}\"'; exit $p.ExitCode }} catch {{ exit 1223 }}",
            ps_single_quote(&script_str)
        );

        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &outer])
            .status()
            .map_err(|e| format!("Failed to request elevation: {}", e))?;

        std::fs::remove_file(&script_path).ok();

        if status.code() == Some(1223) {
            emit_line(&app, "  ✗ administrator access was cancelled", true);
            return Err("Administrator access was cancelled.".to_string());
        }

        let result_raw = std::fs::read_to_string(&result_path).unwrap_or_default();
        std::fs::remove_file(&result_path).ok();
        // PowerShell 5.1's `Out-File -Encoding utf8` prepends a UTF-8 BOM; strip it
        // so the first line's `method=` / `error=` prefix still matches.
        let result = result_raw.trim_start_matches('\u{feff}');

        if let Some(err) = result.lines().find_map(|l| l.strip_prefix("error=")) {
            emit_line(&app, format!("  ✗ {}", err.trim()), true);
            return Err(err.trim().to_string());
        }

        let method = result
            .lines()
            .find_map(|l| l.strip_prefix("method="))
            .map(|s| s.trim().to_string())
            .ok_or_else(|| "Optimization did not complete (no result was reported).".to_string())?;

        let after = std::fs::metadata(&vhd_path).map(|m| m.len()).unwrap_or(before);
        let reclaimed = before.saturating_sub(after);

        let cmd = if method == "Optimize-VHD" {
            format!("Optimize-VHD -Path \"{}\" -Mode Full", vhd_path)
        } else {
            format!("diskpart: select/attach/compact/detach \"{}\"", vhd_path)
        };
        emit_line(&app, format!("$ {}", cmd), false);
        emit_line(
            &app,
            format!(
                "  ✓ reclaimed {} ({} → {})",
                bytes_human(reclaimed),
                bytes_human(before),
                bytes_human(after)
            ),
            false,
        );

        Ok(OptimizeResult { before_bytes: before, after_bytes: after, reclaimed_bytes: reclaimed, method })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Clone)]
pub struct ExportResult {
    pub path: String,
    pub size_bytes: u64,
}

/// Open a file picker for a distro `.tar` archive. Returns `None` if cancelled.
#[tauri::command]
pub async fn pick_tar_file() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Distro archive", &["tar", "gz", "tgz"])
            .pick_file()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
    })
    .await
    .ok()
    .flatten()
}

/// Open a folder picker (used to choose a distro install location).
#[tauri::command]
pub async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .pick_folder()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
    })
    .await
    .ok()
    .flatten()
}

/// Export a distro to a `.tar` archive (`wsl --export`). Opens a save dialog;
/// returns `None` if cancelled. Not elevated. WSL_UTF8 keeps error text readable.
#[tauri::command]
pub async fn wsl_export_distro(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<ExportResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dest) = rfd::FileDialog::new()
            .set_file_name(format!("{}.tar", name))
            .add_filter("TAR archive", &["tar"])
            .save_file()
        else {
            return Ok(None);
        };
        let dest_str = dest.to_string_lossy().to_string();

        emit_line(&app, format!("$ wsl --export {} \"{}\"", name, dest_str), false);

        let out = Command::new("wsl")
            .env("WSL_UTF8", "1")
            .args(["--export", &name, &dest_str])
            .output()
            .map_err(|e| format!("Failed to run wsl --export: {}", e))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let err = if err.is_empty() { "Export failed".to_string() } else { err };
            emit_line(&app, format!("  ✗ {}", err), true);
            return Err(err);
        }

        let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        emit_line(&app, format!("  ✓ exported {} ({})", name, bytes_human(size)), false);
        Ok(Some(ExportResult { path: dest_str, size_bytes: size }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import a distro from a `.tar` archive (`wsl --import`). Creates the install
/// directory if needed. Cloning = export then import under a new name; relocating
/// = import into a different directory. Not elevated.
#[tauri::command]
pub async fn wsl_import_distro(
    app: tauri::AppHandle,
    name: String,
    install_dir: String,
    tar_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Cannot create install directory: {}", e))?;

        emit_line(&app, format!("$ wsl --import {} \"{}\" \"{}\"", name, install_dir, tar_path), false);

        let out = Command::new("wsl")
            .env("WSL_UTF8", "1")
            .args(["--import", &name, &install_dir, &tar_path])
            .output()
            .map_err(|e| format!("Failed to run wsl --import: {}", e))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let err = if err.is_empty() { "Import failed".to_string() } else { err };
            emit_line(&app, format!("  ✗ {}", err), true);
            return Err(err);
        }

        emit_line(&app, format!("  ✓ imported {}", name), false);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// Live in-distro metrics (Dashboard)
// ─────────────────────────────────────────────────────────────────────────────

/// Run a bash script inside a distro as root. See `run_in_distro_as`.
fn run_in_distro(distro: &str, script: &str) -> Result<String, String> {
    run_in_distro_as(distro, Some("root"), script)
}

/// Run a shell script inside a distro as `user` (None = the distro's default
/// login user). The script is piped over stdin as raw UTF-8 with LF line endings
/// (no BOM), so it sidesteps the PowerShell console encoding pitfalls that mangle
/// scripts. WSL_UTF8 keeps wsl.exe's own output UTF-8. Booting a stopped distro
/// is the caller's intent.
///
/// Prefers bash but falls back to sh, so busybox-based distros (Alpine,
/// docker-desktop) still run the POSIX-compatible probe scripts. Scripts that
/// genuinely need bash must guard themselves (see PROFILE_SCRIPT).
fn run_in_distro_as(distro: &str, user: Option<&str>, script: &str) -> Result<String, String> {
    use std::io::Write as _;
    let mut cmd = Command::new("wsl");
    cmd.env("WSL_UTF8", "1").arg("-d").arg(distro);
    if let Some(u) = user {
        cmd.arg("-u").arg(u);
    }
    let mut child = cmd
        .args(["sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash -s; else exec sh -s; fi"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch wsl: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "Command failed inside distro".to_string() } else { err })
    }
}

#[derive(serde::Serialize, Clone)]
pub struct TopProc {
    pub cpu_pct: f32,
    pub mem_pct: f32,
    pub command: String,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct DistroMetrics {
    pub load1: f32,
    pub load5: f32,
    pub load15: f32,
    pub cpu_count: u32,
    pub uptime_secs: u64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    /// Name of pid 1 (e.g. "systemd" or "init").
    pub pid1: String,
    /// True when systemd is pid 1 (the reliable check — `is-system-running`
    /// returns non-zero on "degraded").
    pub systemd: bool,
    /// Raw `systemctl is-system-running` output (running/degraded/…), if any.
    pub systemd_state: String,
    pub nameservers: Vec<String>,
    pub iface: String,
    pub ip: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub zombies: u32,
    pub docker_present: bool,
    pub docker_running: u32,
    pub top_procs: Vec<TopProc>,
}

/// Section-delimited probe of a distro's live state. Each scalar is a `key=value`
/// line; the process list follows a literal `@top` marker. Parsed by
/// `parse_distro_metrics`.
const METRICS_SCRIPT: &str = r#"
echo "loadavg=$(cat /proc/loadavg 2>/dev/null)"
echo "nproc=$(nproc 2>/dev/null)"
echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null | awk '{gsub(":","",$1); print $1"="$2}'
DF=$(df -B1 --output=used,size / 2>/dev/null | tail -1)
[ -z "$DF" ] && DF=$(df -kP / 2>/dev/null | tail -1 | awk '{print $3*1024" "$2*1024}')
echo "df=$DF"
echo "pid1=$(ps -p 1 -o comm= 2>/dev/null)"
echo "systemd_state=$(systemctl is-system-running 2>/dev/null)"
grep '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print "ns="$2}'
IFACE=$(ip -o -4 route show to default 2>/dev/null | awk '{print $5; exit}')
[ -z "$IFACE" ] && IFACE=$(ip -o -4 addr show scope global 2>/dev/null | awk '{print $2; exit}')
echo "iface=$IFACE"
echo "ip=$(ip -o -4 addr show dev "$IFACE" 2>/dev/null | awk '{print $4; exit}')"
echo "rxtx=$(awk -v i="$IFACE:" '$1==i{print $2" "$10}' /proc/net/dev 2>/dev/null)"
echo "zombies=$(ps -eo stat= 2>/dev/null | grep -c '^Z')"
if command -v docker >/dev/null 2>&1; then echo "docker=$(docker ps -q 2>/dev/null | wc -l)"; else echo "docker=none"; fi
echo "@top"
ps -eo pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null | head -15
"#;

fn parse_distro_metrics(out: &str) -> DistroMetrics {
    let mut m = DistroMetrics::default();
    let mut in_top = false;
    for raw in out.lines() {
        let line = raw.trim_end();
        if line == "@top" {
            in_top = true;
            continue;
        }
        if in_top {
            // "pcpu pmem comm…"
            let mut it = line.split_whitespace();
            let cpu = it.next().and_then(|s| s.parse().ok());
            let mem = it.next().and_then(|s| s.parse().ok());
            let comm = it.collect::<Vec<_>>().join(" ");
            if let (Some(cpu_pct), Some(mem_pct)) = (cpu, mem) {
                if !comm.is_empty() {
                    m.top_procs.push(TopProc { cpu_pct, mem_pct, command: comm });
                }
            }
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        match k {
            "loadavg" => {
                let mut p = v.split_whitespace();
                m.load1 = p.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                m.load5 = p.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                m.load15 = p.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            }
            "nproc" => m.cpu_count = v.parse().unwrap_or(0),
            "uptime" => m.uptime_secs = v.parse::<f64>().map(|f| f as u64).unwrap_or(0),
            "MemTotal" => m.mem_total_kb = v.parse().unwrap_or(0),
            "MemAvailable" => m.mem_available_kb = v.parse().unwrap_or(0),
            "SwapTotal" => m.swap_total_kb = v.parse().unwrap_or(0),
            "SwapFree" => m.swap_free_kb = v.parse().unwrap_or(0),
            "df" => {
                let mut p = v.split_whitespace();
                m.disk_used_bytes = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                m.disk_total_bytes = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            "pid1" => m.pid1 = v.to_string(),
            "systemd_state" => m.systemd_state = v.to_string(),
            "ns" => {
                if !v.is_empty() {
                    m.nameservers.push(v.to_string());
                }
            }
            "iface" => m.iface = v.to_string(),
            "ip" => m.ip = v.to_string(),
            "rxtx" => {
                let mut p = v.split_whitespace();
                m.rx_bytes = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                m.tx_bytes = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            "zombies" => m.zombies = v.parse().unwrap_or(0),
            "docker" => {
                if v == "none" {
                    m.docker_present = false;
                } else {
                    m.docker_present = true;
                    m.docker_running = v.parse().unwrap_or(0);
                }
            }
            _ => {}
        }
    }
    m.systemd = m.pid1 == "systemd";
    m
}

/// Snapshot a distro's live CPU/memory/swap/disk/network/process/service state.
/// Read-only and polled (every 10 s by the UI), so it intentionally does not emit
/// terminal lines — mirroring the silent `get_system_metrics` host poll. Selecting
/// a stopped distro boots it.
#[tauri::command]
pub async fn wsl_distro_metrics(distro: String) -> Result<DistroMetrics, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_in_distro(&distro, METRICS_SCRIPT)?;
        Ok(parse_distro_metrics(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// Distro management (comparison extras, restart, clone, migrate)
// ─────────────────────────────────────────────────────────────────────────────

/// Run `wsl <args>` with UTF-8 output, mapping a non-zero exit to an error.
/// wsl.exe sometimes writes its error text to stdout, so both streams are checked.
fn run_wsl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("wsl")
        .env("WSL_UTF8", "1")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run wsl: {}", e))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let err = if err.is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        err
    };
    Err(if err.is_empty() { "wsl command failed".to_string() } else { err })
}

/// Capture a distro's default login user (the user `wsl -d <distro>` logs in as).
/// Returns None for root or on failure. `wsl --import` resets the default user to
/// root, so import-based ops use this to restore it afterwards.
fn distro_default_user(distro: &str) -> Option<String> {
    let out = Command::new("wsl")
        .env("WSL_UTF8", "1")
        .args(["-d", distro, "--", "whoami"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let user = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if user.is_empty() || user == "root" { None } else { Some(user) }
}

/// Human-readable `--version N` suffix for an import command, empty when unknown.
fn version_flag(version: u32) -> String {
    if version == 1 || version == 2 { format!(" --version {}", version) } else { String::new() }
}

/// `wsl --import`, preserving the source WSL version when known (1 or 2) so a
/// WSL1 distro is not silently upgraded to WSL2 (or vice-versa).
fn import_distro(name: &str, dir: &str, tar: &str, version: u32) -> Result<(), String> {
    let v = version.to_string();
    let mut args = vec!["--import", name, dir, tar];
    if version == 1 || version == 2 {
        args.push("--version");
        args.push(&v);
    }
    run_wsl(&args)
}

/// Restore a distro's default user via `wsl --manage` (best-effort; older WSL
/// builds lack `--manage`). No-op for root / None.
fn restore_default_user(app: &tauri::AppHandle, distro: &str, user: &Option<String>) {
    let Some(u) = user else { return };
    emit_line(app, format!("$ wsl --manage {} --set-default-user {}", distro, u), false);
    run_wsl(&["--manage", distro, "--set-default-user", u]).ok();
}

#[derive(serde::Serialize, Clone, Default)]
pub struct DistroExtras {
    pub package_count: u64,
    /// dpkg | rpm | apk | pacman | unknown
    pub package_manager: String,
    pub uptime_secs: u64,
    /// Used / total bytes of the distro's root ext4 filesystem (from `df`). The
    /// gap between this and the VHD file size is the optimize dry-run estimate.
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
}

const EXTRAS_SCRIPT: &str = r#"
echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
DF=$(df -B1 --output=used,size / 2>/dev/null | tail -1)
[ -z "$DF" ] && DF=$(df -kP / 2>/dev/null | tail -1 | awk '{print $3*1024" "$2*1024}')
echo "df=$DF"
if command -v dpkg-query >/dev/null 2>&1; then echo "pm=dpkg"; echo "count=$(dpkg-query -f '.\n' -W 2>/dev/null | wc -l)"
elif command -v rpm >/dev/null 2>&1; then echo "pm=rpm"; echo "count=$(rpm -qa 2>/dev/null | wc -l)"
elif command -v apk >/dev/null 2>&1; then echo "pm=apk"; echo "count=$(apk info 2>/dev/null | wc -l)"
elif command -v pacman >/dev/null 2>&1; then echo "pm=pacman"; echo "count=$(pacman -Q 2>/dev/null | wc -l)"
else echo "pm=unknown"; echo "count=0"; fi
"#;

fn parse_distro_extras(out: &str) -> DistroExtras {
    let mut e = DistroExtras::default();
    for line in out.lines() {
        let Some((k, v)) = line.trim().split_once('=') else { continue };
        let v = v.trim();
        match k {
            "uptime" => e.uptime_secs = v.parse::<f64>().map(|f| f as u64).unwrap_or(0),
            "pm" => e.package_manager = v.to_string(),
            "count" => e.package_count = v.parse().unwrap_or(0),
            "df" => {
                let mut p = v.split_whitespace();
                e.disk_used_bytes = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                e.disk_total_bytes = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            }
            _ => {}
        }
    }
    e
}

/// Open an interactive shell into a distro. Prefers Windows Terminal; falls back
/// to a console window. Detached — the GUI does not wait on it.
#[tauri::command]
pub async fn wsl_open_terminal(app: tauri::AppHandle, distro: String) -> Result<(), String> {
    emit_line(&app, format!("$ wt wsl -d {}", distro), false);
    if Command::new("wt.exe").args(["wsl.exe", "-d", &distro]).spawn().is_ok() {
        return Ok(());
    }
    // No Windows Terminal — open a classic console window instead.
    Command::new("cmd")
        .args(["/c", "start", "", "wsl.exe", "-d", &distro])
        .spawn()
        .map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            format!("Failed to open terminal: {}", e)
        })?;
    Ok(())
}

/// Open a distro's Linux filesystem in Explorer via the `\\wsl.localhost` share.
#[tauri::command]
pub async fn wsl_open_distro_folder(app: tauri::AppHandle, distro: String) -> Result<(), String> {
    let path = format!("\\\\wsl.localhost\\{}", distro);
    emit_line(&app, format!("$ explorer \"{}\"", path), false);
    // explorer.exe returns a non-zero exit code even on success, so don't check it.
    Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}

/// Package count + manager + uptime for the comparison table. Reads inside the
/// distro, so the caller should only invoke this for running distros (otherwise
/// it boots the distro). Read-only — no terminal emission.
#[tauri::command]
pub async fn wsl_distro_extras(distro: String) -> Result<DistroExtras, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_in_distro(&distro, EXTRAS_SCRIPT)?;
        Ok(parse_distro_extras(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop a distro: `wsl --terminate <distro>`. It stays stopped until next access.
#[tauri::command]
pub async fn wsl_terminate_distro(app: tauri::AppHandle, distro: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_line(&app, format!("$ wsl --terminate {}", distro), false);
        run_wsl(&["--terminate", &distro]).map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;
        emit_line(&app, format!("  ✓ stopped {}", distro), false);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restart a distro: terminate it, then boot it straight back up.
#[tauri::command]
pub async fn wsl_restart_distro(app: tauri::AppHandle, distro: String) -> Result<(), String> {
    use std::time::Duration;
    tauri::async_runtime::spawn_blocking(move || {
        emit_line(&app, format!("$ wsl --terminate {}", distro), false);
        run_wsl(&["--terminate", &distro]).map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;
        std::thread::sleep(Duration::from_millis(800));
        emit_line(&app, format!("$ wsl -d {} -u root true   # boot", distro), false);
        run_wsl(&["-d", &distro, "-u", "root", "true"]).map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;
        emit_line(&app, format!("  ✓ restarted {}", distro), false);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Boot a stopped distro (a no-op command brings the VM up).
#[tauri::command]
pub async fn wsl_start_distro(app: tauri::AppHandle, distro: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_line(&app, format!("$ wsl -d {} -u root true   # start", distro), false);
        run_wsl(&["-d", &distro, "-u", "root", "true"]).map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;
        emit_line(&app, format!("  ✓ started {}", distro), false);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clone a distro: export it to a temp `.tar`, import under a new name/location,
/// then delete the temp archive. Not elevated.
#[tauri::command]
pub async fn wsl_clone_distro(
    app: tauri::AppHandle,
    source: String,
    new_name: String,
    install_dir: String,
    version: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Cannot create install directory: {}", e))?;

        // Capture the source's default user before terminating it, so the clone
        // logs in as the same user rather than root.
        let default_user = distro_default_user(&source);

        let tmp = std::env::temp_dir().join(format!("atlas_clone_{}.tar", safe_name(&new_name)));
        let tmp_str = tmp.to_string_lossy().to_string();

        emit_line(&app, format!("$ wsl --terminate {}", source), false);
        run_wsl(&["--terminate", &source]).ok();

        emit_line(&app, format!("$ wsl --export {} \"{}\"", source, tmp_str), false);
        run_wsl(&["--export", &source, &tmp_str]).map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;

        emit_line(&app, format!("$ wsl --import {} \"{}\" \"{}\"{}", new_name, install_dir, tmp_str, version_flag(version)), false);
        let imported = import_distro(&new_name, &install_dir, &tmp_str, version);
        std::fs::remove_file(&tmp).ok();
        imported.map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;

        restore_default_user(&app, &new_name, &default_user);

        emit_line(&app, format!("  ✓ cloned {} → {}", source, new_name), false);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Clone)]
pub struct MigrateResult {
    /// Path to the retained `.tar` backup (the rollback artifact).
    pub backup_tar: String,
}

/// Move a distro to another directory/drive with a verified, recoverable flow:
/// export to a `.tar` in the destination → import to a temp name there → verify it
/// boots → only then unregister the original → re-import the original name at the
/// new location → drop the temp. The `.tar` is kept as a rollback artifact; the
/// original is never unregistered until the new copy is confirmed bootable.
#[tauri::command]
pub async fn wsl_migrate_distro(
    app: tauri::AppHandle,
    distro: String,
    new_dir: String,
    was_default: bool,
    current_base: String,
    version: u32,
) -> Result<MigrateResult, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    tauri::async_runtime::spawn_blocking(move || {
        // Refuse to migrate into the distro's current install folder (or a subfolder
        // of it): `wsl --unregister` deletes that tree, which would take the backup
        // .tar with it and leave no way to recover. Compare case-insensitively with
        // normalized separators (Windows paths).
        let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let dest_n = norm(&new_dir);
        let base_n = norm(&current_base);
        if !base_n.is_empty() && (dest_n == base_n || dest_n.starts_with(&format!("{}/", base_n))) {
            return Err("Choose a destination outside the distro's current install folder — migrating into it would delete the backup.".to_string());
        }

        std::fs::create_dir_all(&new_dir)
            .map_err(|e| format!("Cannot create destination directory: {}", e))?;

        // Capture the default user before terminating, to restore it after re-import.
        let default_user = distro_default_user(&distro);

        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let backup = format!("{}/{}_migrate_{}.tar", new_dir.replace('\\', "/"), safe_name(&distro), ts);
        let temp_name = format!("{}_atlas_migrate", distro);
        let temp_dir = format!("{}/__atlas_migrate_verify", new_dir.replace('\\', "/"));

        emit_line(&app, format!("# Migrating {} to {} — exporting a backup first", distro, new_dir), false);
        emit_line(&app, format!("$ wsl --terminate {}", distro), false);
        run_wsl(&["--terminate", &distro]).ok();

        emit_line(&app, format!("$ wsl --export {} \"{}\"", distro, backup), false);
        run_wsl(&["--export", &distro, &backup]).map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;

        // Import + boot-verify a temp copy at the destination before touching the original.
        emit_line(&app, format!("$ wsl --import {} \"{}\" \"{}\"{}", temp_name, temp_dir, backup, version_flag(version)), false);
        if let Err(e) = import_distro(&temp_name, &temp_dir, &backup, version) {
            emit_line(&app, format!("  ✗ {} (original intact, backup kept at {})", e, backup), true);
            std::fs::remove_dir_all(&temp_dir).ok();
            return Err(e);
        }

        emit_line(&app, format!("$ wsl -d {} -u root true   # verify boot", temp_name), false);
        if let Err(e) = run_wsl(&["-d", &temp_name, "-u", "root", "true"]) {
            emit_line(&app, format!("  ✗ migrated copy failed to boot: {} — keeping original, backup at {}", e, backup), true);
            run_wsl(&["--unregister", &temp_name]).ok();
            std::fs::remove_dir_all(&temp_dir).ok();
            return Err(format!("Migrated copy failed to boot; original left untouched. Backup: {}", backup));
        }

        // Verified bootable — now replace the original at the new location.
        emit_line(&app, format!("$ wsl --unregister {}", distro), false);
        if let Err(e) = run_wsl(&["--unregister", &distro]) {
            emit_line(&app, format!("  ✗ {} — original intact, backup at {}", e, backup), true);
            run_wsl(&["--unregister", &temp_name]).ok();
            std::fs::remove_dir_all(&temp_dir).ok();
            return Err(e);
        }

        emit_line(&app, format!("$ wsl --import {} \"{}\" \"{}\"{}", distro, new_dir, backup, version_flag(version)), false);
        if let Err(e) = import_distro(&distro, &new_dir, &backup, version) {
            emit_line(&app, format!("  ✗ re-import failed: {} — recover with: wsl --import {} \"{}\" \"{}\"", e, distro, new_dir, backup), true);
            return Err(format!("Re-import failed: {}. Recover from the backup: {}", e, backup));
        }

        // Clean up the temp verification copy.
        emit_line(&app, format!("$ wsl --unregister {}", temp_name), false);
        run_wsl(&["--unregister", &temp_name]).ok();
        std::fs::remove_dir_all(&temp_dir).ok();

        restore_default_user(&app, &distro, &default_user);

        if was_default {
            emit_line(&app, format!("$ wsl --set-default {}", distro), false);
            run_wsl(&["--set-default", &distro]).ok();
        }

        emit_line(&app, format!("  ✓ migrated {} to {} (backup kept: {})", distro, new_dir, backup), false);
        Ok(MigrateResult { backup_tar: backup })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup manager (systemd services)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone, Default)]
pub struct ServiceInit {
    /// True when systemd is pid 1.
    pub is_systemd: bool,
    pub pid1: String,
    /// Setup hint shown when systemd is not the init (None when it is).
    pub hint: Option<String>,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct Service {
    pub name: String,
    /// enabled | disabled | static | masked | alias | generated | …
    pub enabled_state: String,
    /// active | inactive | failed | activating | …
    pub active_state: String,
    /// running | dead | exited | …
    pub sub_state: String,
    pub description: String,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct ServiceList {
    pub init: ServiceInit,
    pub services: Vec<Service>,
}

const SERVICES_SCRIPT: &str = r#"
echo "pid1=$(ps -p 1 -o comm= 2>/dev/null)"
if [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then
  echo "@unitfiles"
  systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null
  echo "@units"
  systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null
fi
"#;

fn parse_services(out: &str) -> ServiceList {
    use std::collections::HashMap;

    #[derive(Default)]
    enum Sec { #[default] Head, UnitFiles, Units }
    let mut sec = Sec::Head;
    let mut pid1 = String::new();
    // name -> (active, sub, description)
    let mut runtime: HashMap<String, (String, String, String)> = HashMap::new();
    // (name, enabled_state) preserving order.
    let mut files: Vec<(String, String)> = Vec::new();

    for line in out.lines() {
        let line = line.trim_end();
        match line {
            "@unitfiles" => { sec = Sec::UnitFiles; continue }
            "@units" => { sec = Sec::Units; continue }
            _ => {}
        }
        match sec {
            Sec::Head => {
                if let Some(v) = line.strip_prefix("pid1=") {
                    pid1 = v.trim().to_string();
                }
            }
            Sec::UnitFiles => {
                let mut it = line.split_whitespace();
                if let (Some(name), Some(state)) = (it.next(), it.next()) {
                    files.push((name.to_string(), state.to_string()));
                }
            }
            Sec::Units => {
                let mut it = line.split_whitespace();
                let name = it.next();
                let _load = it.next();
                let active = it.next();
                let sub = it.next();
                if let (Some(name), Some(active), Some(sub)) = (name, active, sub) {
                    let desc = it.collect::<Vec<_>>().join(" ");
                    runtime.insert(name.to_string(), (active.to_string(), sub.to_string(), desc));
                }
            }
        }
    }

    let services = files
        .into_iter()
        .map(|(name, enabled_state)| {
            let (active_state, sub_state, description) = runtime
                .get(&name)
                .cloned()
                .unwrap_or_else(|| ("inactive".into(), "dead".into(), String::new()));
            Service { name, enabled_state, active_state, sub_state, description }
        })
        .collect();

    let is_systemd = pid1 == "systemd";
    let hint = if is_systemd {
        None
    } else {
        Some("systemd is not the init system. Add `[boot] systemd=true` to /etc/wsl.conf, then restart the distro.".to_string())
    };

    ServiceList { init: ServiceInit { is_systemd, pid1, hint }, services }
}

/// List a distro's systemd services (enabled + active state). Reads inside the
/// distro, so it boots a stopped one — the caller gates on user intent.
#[tauri::command]
pub async fn wsl_list_services(distro: String) -> Result<ServiceList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_in_distro(&distro, SERVICES_SCRIPT)?;
        Ok(parse_services(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Clone, Default)]
pub struct ServiceDetail {
    pub id: String,
    pub description: String,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
    pub unit_file_state: String,
    pub fragment_path: String,
    pub main_pid: String,
    pub requires: Vec<String>,
    pub after: Vec<String>,
}

fn parse_service_detail(out: &str) -> ServiceDetail {
    let mut d = ServiceDetail::default();
    for line in out.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        let split = |s: &str| s.split_whitespace().map(|x| x.to_string()).collect::<Vec<_>>();
        match k {
            "Id" => d.id = v.to_string(),
            "Description" => d.description = v.to_string(),
            "LoadState" => d.load_state = v.to_string(),
            "ActiveState" => d.active_state = v.to_string(),
            "SubState" => d.sub_state = v.to_string(),
            "UnitFileState" => d.unit_file_state = v.to_string(),
            "FragmentPath" => d.fragment_path = v.to_string(),
            "MainPID" => d.main_pid = v.to_string(),
            "Requires" => d.requires = split(v),
            "After" => d.after = split(v),
            _ => {}
        }
    }
    d
}

/// Detailed status for one service (dependencies, paths, PID).
#[tauri::command]
pub async fn wsl_service_detail(distro: String, service: String) -> Result<ServiceDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = format!(
            "systemctl show {} -p Id,Description,LoadState,ActiveState,SubState,UnitFileState,FragmentPath,MainPID,Requires,After 2>/dev/null",
            shell_quote(&service)
        );
        let out = run_in_distro(&distro, &script)?;
        Ok(parse_service_detail(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Single-quote a string for safe embedding in a bash command.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Enable or disable a service (`systemctl enable|disable`). Mutating —
/// the UI confirms first.
#[tauri::command]
pub async fn wsl_service_set(
    app: tauri::AppHandle,
    distro: String,
    service: String,
    enable: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let verb = if enable { "enable" } else { "disable" };
        emit_line(&app, format!("$ wsl -d {} -u root systemctl {} {}", distro, verb, service), false);
        // No `2>&1`: systemctl writes its symlink notice to stderr even on success,
        // which run_in_distro discards; on failure it surfaces stderr as the error.
        let script = format!("systemctl {} {}", verb, shell_quote(&service));
        match run_in_distro(&distro, &script) {
            Ok(_) => {
                emit_line(&app, format!("  ✓ {}d {}", verb, service), false);
                Ok(())
            }
            Err(e) => {
                emit_line(&app, format!("  ✗ {}", e), true);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// Performance analyzer (cold-boot benchmark + shell profiler)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct BenchmarkResult {
    pub boot_ms: u64,
}

/// Benchmark a distro's cold-boot time: terminate it, let the VM tear down, then
/// time the first access (`wsl -d <distro> -u root true`) from the host. Mutating
/// (terminates the distro), so the UI confirms first.
#[tauri::command]
pub async fn wsl_benchmark_boot(app: tauri::AppHandle, distro: String) -> Result<BenchmarkResult, String> {
    use std::time::{Duration, Instant};
    tauri::async_runtime::spawn_blocking(move || {
        emit_line(&app, format!("# Cold-boot benchmark — terminating {} first", distro), false);
        emit_line(&app, format!("$ wsl --terminate {}", distro), false);
        run_wsl(&["--terminate", &distro]).ok(); // already-stopped is fine

        // Let the lightweight VM fully tear down so the next access is a true cold boot.
        std::thread::sleep(Duration::from_millis(1500));

        emit_line(&app, format!("$ wsl -d {} -u root true   # timing cold boot", distro), false);
        let start = Instant::now();
        run_wsl(&["-d", &distro, "-u", "root", "true"]).map_err(|e| {
            emit_line(&app, format!("  ✗ {}", e), true);
            e
        })?;
        let boot_ms = start.elapsed().as_millis() as u64;
        emit_line(&app, format!("  ✓ cold boot: {} ms", boot_ms), false);
        Ok(BenchmarkResult { boot_ms })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Clone, Default)]
pub struct RcFile {
    pub path: String,
    pub seconds: f32,
}

#[derive(serde::Serialize, Clone)]
pub struct DetectedTool {
    pub tool: String,
    pub suggestion: String,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct ShellProfile {
    /// The default user's login shell (profiling assumes bash).
    pub shell: String,
    pub baseline_secs: f32,
    pub interactive_secs: f32,
    pub login_secs: f32,
    /// interactive − baseline: the cost added by rc files (never negative).
    pub rc_overhead_secs: f32,
    pub files: Vec<RcFile>,
    pub detected: Vec<DetectedTool>,
}

/// Fixed optimization suggestion for a detected slow startup item.
fn suggestion_for(tool: &str) -> String {
    match tool {
        "nvm" => "nvm sourcing nvm.sh eagerly adds 100ms+ — lazy-load it so node/npm/nvm load it on first use.",
        "conda" => "Disable base auto-activation (`conda config --set auto_activate_base false`) or lazy-init conda.",
        "pyenv" => "Defer pyenv: use `pyenv init - --no-rehash` and keep virtualenv-init off the hot path.",
        "rbenv" => "Use `rbenv init - --no-rehash` to skip the rehash on every shell start.",
        "oh-my-zsh" => "Trim oh-my-zsh plugins and theme — each plugin adds measurable startup cost.",
        "sdkman" => "SDKMAN sources a large init script — lazy-load it on first `sdk` use.",
        "nodenv" => "Use `nodenv init - --no-rehash` to cut the per-shell rehash cost.",
        _ => "Review this item — it runs on every shell startup.",
    }
    .to_string()
}

/// Profiles bash startup as the default user: baseline (no rc), interactive, and
/// login-interactive timings, isolated per-rc-file source times, and detection of
/// known-slow tools. Run as the default user so `~` and the login shell are right.
const PROFILE_SCRIPT: &str = r#"
command -v bash >/dev/null 2>&1 || { echo "bash is not installed in this distro; shell profiling needs it" >&2; exit 1; }
SHELL_PATH=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
echo "shell=$SHELL_PATH"
export TIMEFORMAT=%R
echo "baseline=$( { time bash --norc --noprofile -c true >/dev/null 2>&1 ; } 2>&1 )"
echo "interactive=$( { time bash -i -c true >/dev/null 2>&1 ; } 2>&1 )"
echo "login=$( { time bash -l -i -c true >/dev/null 2>&1 ; } 2>&1 )"
echo "@files"
for f in /etc/profile "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  [ -f "$f" ] || continue
  echo "$f=$( { time bash --norc -i -c "source '$f'" >/dev/null 2>&1 ; } 2>&1 )"
done
echo "@detect"
RC="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile /etc/profile"
for spec in "nvm:nvm|NVM_DIR" "conda:conda init|conda.sh|miniconda|anaconda" "pyenv:pyenv init|PYENV_ROOT" "rbenv:rbenv init" "oh-my-zsh:oh-my-zsh|robbyrussell" "sdkman:sdkman|SDKMAN_DIR" "nodenv:nodenv init"; do
  tool="${spec%%:*}"; pat="${spec#*:}"
  if grep -lE "$pat" $RC >/dev/null 2>&1; then echo "$tool"; fi
done
"#;

fn parse_shell_profile(out: &str) -> ShellProfile {
    enum Sec { Head, Files, Detect }
    let mut sec = Sec::Head;
    let mut p = ShellProfile::default();
    for line in out.lines() {
        let line = line.trim_end();
        match line {
            "@files" => { sec = Sec::Files; continue }
            "@detect" => { sec = Sec::Detect; continue }
            _ => {}
        }
        match sec {
            Sec::Head => {
                if let Some((k, v)) = line.split_once('=') {
                    let v = v.trim();
                    match k {
                        "shell" => p.shell = v.to_string(),
                        "baseline" => p.baseline_secs = v.parse().unwrap_or(0.0),
                        "interactive" => p.interactive_secs = v.parse().unwrap_or(0.0),
                        "login" => p.login_secs = v.parse().unwrap_or(0.0),
                        _ => {}
                    }
                }
            }
            Sec::Files => {
                if let Some((path, secs)) = line.rsplit_once('=') {
                    if let Ok(seconds) = secs.trim().parse::<f32>() {
                        p.files.push(RcFile { path: path.to_string(), seconds });
                    }
                }
            }
            Sec::Detect => {
                let t = line.trim();
                if !t.is_empty() {
                    p.detected.push(DetectedTool { tool: t.to_string(), suggestion: suggestion_for(t) });
                }
            }
        }
    }
    p.rc_overhead_secs = (p.interactive_secs - p.baseline_secs).max(0.0);
    p
}

/// Profile the default user's shell startup. Read-only (boots a stopped distro).
#[tauri::command]
pub async fn wsl_profile_shell(distro: String) -> Result<ShellProfile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_in_distro_as(&distro, None, PROFILE_SCRIPT)?;
        Ok(parse_shell_profile(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Minimal byte formatter for terminal lines (mirrors the frontend's bytesToHuman).
fn bytes_human(b: u64) -> String {
    if b >= 1_000_000_000 {
        format!("{:.2} GB", b as f64 / 1e9)
    } else if b >= 1_000_000 {
        format!("{:.1} MB", b as f64 / 1e6)
    } else if b >= 1_000 {
        format!("{:.0} kB", b as f64 / 1e3)
    } else {
        format!("{} B", b)
    }
}

const INNER_OPTIMIZE_PS: &str = r#"$ErrorActionPreference='Stop'
$vhd='__VHD__'
$out='__OUT__'
try {
  wsl.exe --shutdown
  Start-Sleep -Seconds 2
  if (Get-Command Optimize-VHD -ErrorAction SilentlyContinue) {
    Optimize-VHD -Path $vhd -Mode Full
    'method=Optimize-VHD' | Out-File -FilePath $out -Encoding utf8
  } else {
    $lines = @(
      'select vdisk file="' + $vhd + '"',
      'attach vdisk readonly',
      'compact vdisk',
      'detach vdisk',
      'exit'
    )
    $dpFile = [System.IO.Path]::GetTempFileName()
    $lines | Out-File -FilePath $dpFile -Encoding ascii
    $r = & diskpart /s $dpFile 2>&1 | Out-String
    Remove-Item $dpFile -Force
    if ($LASTEXITCODE -ne 0) { throw ('diskpart failed: ' + $r) }
    'method=diskpart' | Out-File -FilePath $out -Encoding utf8
  }
} catch {
  ('error=' + $_.Exception.Message) | Out-File -FilePath $out -Encoding utf8
  exit 1
}
"#;

/// Report whether WSL is installed (is `wsl.exe` resolvable on PATH).
#[tauri::command]
pub async fn wsl_check() -> WslStatus {
    let found = Command::new("where.exe")
        .arg("wsl.exe")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if found {
        WslStatus { available: true, error: None }
    } else {
        WslStatus {
            available: false,
            error: Some("WSL is not installed. Enable it with: wsl --install".to_string()),
        }
    }
}

/// Enumerate installed distros from the registry (HKCU\...\Lxss), cross-referenced
/// with `wsl -l --running` for live state and the VHD file size on disk.
///
/// Reading the registry directly (rather than parsing `wsl -l -v`) avoids the
/// UTF-16 console-encoding pitfalls and gives us the BasePath needed to locate
/// each distro's `ext4.vhdx`.
#[tauri::command]
pub async fn wsl_list_distros(app: tauri::AppHandle) -> Result<Vec<WslDistro>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_line(&app, "$ Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'", false);
        emit_line(&app, "$ wsl -l --running", false);
        // WSL_UTF8=1 makes `wsl.exe` emit UTF-8 instead of UTF-16, so the
        // running-distro list reads cleanly.
        let script = r#"
$ErrorActionPreference='SilentlyContinue'
$env:WSL_UTF8=1
$lxss='HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
$default=(Get-ItemProperty -LiteralPath $lxss).DefaultDistribution
$running=@(wsl.exe -l --running -q | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$list=@()
foreach($k in Get-ChildItem -LiteralPath $lxss){
  $p=Get-ItemProperty -LiteralPath $k.PSPath
  if(-not $p.DistributionName){continue}
  $base=[string]$p.BasePath
  if($base.StartsWith('\\?\')){$base=$base.Substring(4)}
  $vhd=Join-Path $base 'ext4.vhdx'
  $size=0
  $vhdOut=''
  if(Test-Path -LiteralPath $vhd){$size=(Get-Item -LiteralPath $vhd).Length; $vhdOut=$vhd}
  $list+=[pscustomobject]@{
    name=$p.DistributionName
    version=[int]$p.Version
    isDefault=($k.PSChildName -eq $default)
    running=($running -contains $p.DistributionName)
    basePath=$base
    vhdPath=$vhdOut
    vhdSize=[int64]$size
  }
}
$list | ConvertTo-Json -Compress -Depth 3
"#;

        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|e| format!("powershell: {}", e))?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }

        let text = String::from_utf8_lossy(&out.stdout);
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed == "null" {
            return Ok(Vec::new());
        }

        let val: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("Failed to parse distro list: {}", e))?;

        // ConvertTo-Json yields a bare object for a single distro, an array for many.
        let items = match val {
            serde_json::Value::Array(a) => a,
            other => vec![other],
        };

        let distros = items
            .iter()
            .map(|v| WslDistro {
                name: v["name"].as_str().unwrap_or("").to_string(),
                version: v["version"].as_u64().unwrap_or(0) as u32,
                running: v["running"].as_bool().unwrap_or(false),
                is_default: v["isDefault"].as_bool().unwrap_or(false),
                base_path: v["basePath"].as_str().unwrap_or("").to_string(),
                vhd_path: v["vhdPath"].as_str().unwrap_or("").to_string(),
                vhd_size_bytes: v["vhdSize"].as_u64().unwrap_or(0),
            })
            .filter(|d| !d.name.is_empty())
            .collect::<Vec<WslDistro>>();

        emit_line(&app, format!("  ✓ {} distro(s)", distros.len()), false);
        Ok(distros)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_distro_metrics() {
        let sample = "\
loadavg=1.20 0.86 0.41 2/761 8590
nproc=12
uptime=43232.02
MemTotal=40965184
MemAvailable=35416268
SwapTotal=10485760
SwapFree=10485760
df=28343468032 1081101176832
pid1=systemd
systemd_state=degraded
ns=10.255.255.254
iface=eth0
ip=172.20.1.2/20
rxtx=12345 67890
zombies=0
docker=5
@top
11.7 0.0 bash
8.9 0.5 updatedb.plocat
";
        let m = parse_distro_metrics(sample);
        assert_eq!(m.cpu_count, 12);
        assert_eq!(m.load1, 1.20);
        assert_eq!(m.uptime_secs, 43232);
        assert_eq!(m.mem_total_kb, 40965184);
        assert_eq!(m.mem_available_kb, 35416268);
        assert_eq!(m.swap_total_kb, 10485760);
        assert_eq!(m.disk_total_bytes, 1081101176832);
        assert_eq!(m.disk_used_bytes, 28343468032);
        assert!(m.systemd);
        assert_eq!(m.systemd_state, "degraded");
        assert_eq!(m.nameservers, vec!["10.255.255.254".to_string()]);
        assert_eq!(m.iface, "eth0");
        assert_eq!(m.ip, "172.20.1.2/20");
        assert_eq!(m.rx_bytes, 12345);
        assert_eq!(m.tx_bytes, 67890);
        assert_eq!(m.zombies, 0);
        assert!(m.docker_present);
        assert_eq!(m.docker_running, 5);
        assert_eq!(m.top_procs.len(), 2);
        assert_eq!(m.top_procs[0].command, "bash");
        assert_eq!(m.top_procs[1].command, "updatedb.plocat");
    }

    #[test]
    fn parses_distro_extras() {
        let e = parse_distro_extras("uptime=43232.99\ndf=28321128448 1081101176832\npm=dpkg\ncount=1463\n");
        assert_eq!(e.uptime_secs, 43232);
        assert_eq!(e.package_manager, "dpkg");
        assert_eq!(e.package_count, 1463);
        assert_eq!(e.disk_used_bytes, 28321128448);
        assert_eq!(e.disk_total_bytes, 1081101176832);
    }

    #[test]
    fn parses_services_join() {
        let sample = "pid1=systemd\n@unitfiles\nssh.service disabled enabled\naccounts-daemon.service enabled enabled\napt-daily.service static -\n@units\naccounts-daemon.service loaded active running Accounts Service\napt-daily.service loaded inactive dead Daily apt download activities\n";
        let list = parse_services(sample);
        assert!(list.init.is_systemd);
        assert!(list.init.hint.is_none());
        assert_eq!(list.services.len(), 3);
        let ssh = list.services.iter().find(|s| s.name == "ssh.service").unwrap();
        assert_eq!(ssh.enabled_state, "disabled");
        // ssh has no runtime entry → defaults.
        assert_eq!(ssh.active_state, "inactive");
        assert_eq!(ssh.sub_state, "dead");
        let acct = list.services.iter().find(|s| s.name == "accounts-daemon.service").unwrap();
        assert_eq!(acct.active_state, "active");
        assert_eq!(acct.sub_state, "running");
        assert_eq!(acct.description, "Accounts Service");
    }

    #[test]
    fn parses_services_non_systemd() {
        let list = parse_services("pid1=init\n");
        assert!(!list.init.is_systemd);
        assert!(list.init.hint.is_some());
        assert!(list.services.is_empty());
    }

    #[test]
    fn parses_service_detail_deps() {
        let sample = "Id=ssh.service\nRequires=system.slice sysinit.target\nAfter=network.target basic.target\nDescription=OpenBSD Secure Shell server\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0\n";
        let d = parse_service_detail(sample);
        assert_eq!(d.id, "ssh.service");
        assert_eq!(d.requires, vec!["system.slice", "sysinit.target"]);
        assert_eq!(d.after.len(), 2);
        assert_eq!(d.unit_file_state, "disabled");
    }

    #[test]
    fn parses_shell_profile() {
        let sample = "shell=/bin/bash\nbaseline=0.003\ninteractive=0.140\nlogin=0.200\n@files\n/etc/profile=0.005\n/root/.bashrc=0.110\n@detect\nnvm\noh-my-zsh\n";
        let p = parse_shell_profile(sample);
        assert_eq!(p.shell, "/bin/bash");
        assert!((p.baseline_secs - 0.003).abs() < 1e-4);
        assert!((p.interactive_secs - 0.140).abs() < 1e-4);
        assert!((p.rc_overhead_secs - 0.137).abs() < 1e-3);
        assert_eq!(p.files.len(), 2);
        assert_eq!(p.files[1].path, "/root/.bashrc");
        assert!((p.files[1].seconds - 0.110).abs() < 1e-4);
        assert_eq!(p.detected.len(), 2);
        assert_eq!(p.detected[0].tool, "nvm");
        assert!(p.detected[0].suggestion.contains("lazy-load"));
    }

    #[test]
    fn shell_profile_overhead_never_negative() {
        // Baseline can occasionally exceed interactive due to scheduling noise.
        let p = parse_shell_profile("baseline=0.050\ninteractive=0.030\n");
        assert_eq!(p.rc_overhead_secs, 0.0);
    }

    #[test]
    fn metrics_without_docker_or_systemd() {
        let sample = "pid1=init\ndocker=none\nzombies=2\n@top\n";
        let m = parse_distro_metrics(sample);
        assert!(!m.systemd);
        assert!(!m.docker_present);
        assert_eq!(m.docker_running, 0);
        assert_eq!(m.zombies, 2);
        assert!(m.top_procs.is_empty());
    }
}
