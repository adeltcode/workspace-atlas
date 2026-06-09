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
pub async fn read_wslconfig() -> Result<WslConfig, String> {
    let path = wslconfig_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(WslConfig { path, content, exists: true }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(WslConfig { path, content: String::new(), exists: false })
        }
        Err(e) => Err(format!("Cannot read .wslconfig: {}", e)),
    }
}

/// Write %USERPROFILE%\.wslconfig. Changes take effect after `wsl --shutdown`.
#[tauri::command]
pub async fn write_wslconfig(content: String) -> Result<(), String> {
    let path = wslconfig_path()?;
    std::fs::write(&path, content).map_err(|e| format!("Cannot write .wslconfig: {}", e))
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
pub async fn wslconfig_backup(backup_dir: String) -> Result<WslConfigBackup, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let src = wslconfig_path()?;
    let content = std::fs::read_to_string(&src)
        .map_err(|e| format!("Cannot read .wslconfig: {}", e))?;

    // De-dup against the most recent backup.
    let existing = list_wslconfig_backups_sync(&backup_dir);
    if let Some(latest) = existing.first() {
        if std::fs::read_to_string(&latest.path).ok().as_deref() == Some(content.as_str()) {
            return Ok(latest.clone());
        }
    }

    let dir = wslconfig_backup_dir(&backup_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create backup dir: {}", e))?;

    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let filename = format!("wslconfig_{}.conf", ts);
    let path = format!("{}/{}", dir, filename);
    std::fs::write(&path, &content).map_err(|e| format!("Cannot write backup: {}", e))?;

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
pub async fn wslconfig_restore(backup_path: String) -> Result<String, String> {
    let dest = wslconfig_path()?;
    let content = std::fs::read_to_string(&backup_path)
        .map_err(|e| format!("Cannot read backup: {}", e))?;
    std::fs::write(&dest, &content).map_err(|e| format!("Cannot write .wslconfig: {}", e))?;
    Ok(content)
}

/// Delete a single `.wslconfig` backup.
#[tauri::command]
pub async fn wslconfig_delete_backup(backup_path: String) -> Result<(), String> {
    if std::path::Path::new(&backup_path).exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|e| format!("Cannot delete backup: {}", e))?;
    }
    Ok(())
}

// ── /etc/wsl.conf (per-distro) read / write / backup / restore ──────────────────
//
// wsl.conf lives inside the distro's Linux filesystem. Reading boots the distro;
// writing needs root inside it (`wsl -u root tee`) — no Windows UAC. WSL_UTF8
// keeps output readable.

/// Read `/etc/wsl.conf` from a distro. A missing file is reported, not an error.
#[tauri::command]
pub async fn read_wsl_conf(distro: String) -> Result<WslConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let display_path = format!("\\\\wsl.localhost\\{}\\etc\\wsl.conf", distro);
        let out = Command::new("wsl")
            .env("WSL_UTF8", "1")
            .args(["-d", &distro, "-u", "root", "cat", "/etc/wsl.conf"])
            .output()
            .map_err(|e| format!("Failed to read wsl.conf: {}", e))?;
        if out.status.success() {
            Ok(WslConfig { path: display_path, content: String::from_utf8_lossy(&out.stdout).to_string(), exists: true })
        } else {
            // Missing file (or unreadable) — present an empty editor.
            Ok(WslConfig { path: display_path, content: String::new(), exists: false })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write `/etc/wsl.conf` inside a distro as root. Takes effect after `wsl --shutdown`.
#[tauri::command]
pub async fn write_wsl_conf(distro: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write as _;
        let mut child = Command::new("wsl")
            .env("WSL_UTF8", "1")
            .args(["-d", &distro, "-u", "root", "tee", "/etc/wsl.conf"])
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
pub async fn wsl_conf_backup(distro: String, backup_dir: String) -> Result<WslConfigBackup, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let current = read_wsl_conf(distro.clone()).await?;
    if !current.exists {
        return Err("No wsl.conf to back up yet.".to_string());
    }

    let existing = list_wslconf_backups_sync(&backup_dir, &distro);
    if let Some(latest) = existing.first() {
        if std::fs::read_to_string(&latest.path).ok().as_deref() == Some(current.content.as_str()) {
            return Ok(latest.clone());
        }
    }

    let dir = wslconf_backup_dir(&backup_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create backup dir: {}", e))?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let filename = format!("{}_{}.conf", safe_name(&distro), ts);
    let path = format!("{}/{}", dir, filename);
    std::fs::write(&path, &current.content).map_err(|e| format!("Cannot write backup: {}", e))?;

    for stale in list_wslconf_backups_sync(&backup_dir, &distro).into_iter().skip(20) {
        std::fs::remove_file(&stale.path).ok();
    }

    Ok(WslConfigBackup { filename, path, size_bytes: current.content.len() as u64, created_at: ts as i64 })
}

/// List a distro's wsl.conf backups, most-recent first.
#[tauri::command]
pub async fn wsl_conf_list_backups(distro: String, backup_dir: String) -> Result<Vec<WslConfigBackup>, String> {
    Ok(list_wslconf_backups_sync(&backup_dir, &distro))
}

/// Restore a backup into a distro's `/etc/wsl.conf`, returning the restored content.
#[tauri::command]
pub async fn wsl_conf_restore(distro: String, backup_path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&backup_path)
        .map_err(|e| format!("Cannot read backup: {}", e))?;
    write_wsl_conf(distro, content.clone()).await?;
    Ok(content)
}

/// Delete a single wsl.conf backup.
#[tauri::command]
pub async fn wsl_conf_delete_backup(backup_path: String) -> Result<(), String> {
    if std::path::Path::new(&backup_path).exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|e| format!("Cannot delete backup: {}", e))?;
    }
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
pub async fn wsl_list_distros() -> Result<Vec<WslDistro>, String> {
    tauri::async_runtime::spawn_blocking(|| {
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
            .collect();

        Ok(distros)
    })
    .await
    .map_err(|e| e.to_string())?
}
