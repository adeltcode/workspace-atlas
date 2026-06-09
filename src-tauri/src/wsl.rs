use std::process::Command;

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

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

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
