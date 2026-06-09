use std::process::Command;

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

        let result = std::fs::read_to_string(&result_path).unwrap_or_default();
        std::fs::remove_file(&result_path).ok();

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
