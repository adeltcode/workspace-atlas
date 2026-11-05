use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AtlasError, ErrorKind};
use crate::shell::hidden;
use crate::wsl::{emit_line, output_within};
use crate::wsl_migration::quote;

const LIST_TIME_LIMIT: Duration = Duration::from_secs(15);
const START_TIME_LIMIT: Duration = Duration::from_secs(300);
const STOP_TIME_LIMIT: Duration = Duration::from_secs(60);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SandboxStatus {
    /// False when this PC has no `wsb` command.
    pub available: bool,
    pub running: Vec<String>,
}

#[derive(Deserialize)]
pub struct SandboxOptions {
    pub networking: bool,
    pub folder: Option<String>,
    pub writable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Environment {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct EnvironmentList {
    windows_sandbox_environments: Vec<Environment>,
}

fn wsb_missing() -> AtlasError {
    AtlasError::new(ErrorKind::NotFound, "This PC has no wsb command.")
}

/// wsb's own message is shown as it is, because the shared error sorting gives Docker and WSL advice.
fn run_wsb(args: &[&str], limit: Duration) -> Result<String, AtlasError> {
    let child = hidden("wsb")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { wsb_missing() } else { e.into() })?;
    let Some(output) = output_within(child, limit)? else {
        return Err(AtlasError::new(ErrorKind::Timeout, "Windows Sandbox did not respond in time.")
            .hint("Refresh to see whether it finished."));
    };
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { "Windows Sandbox failed without reporting a reason.".to_string() };
    Err(AtlasError::new(ErrorKind::Unknown, message))
}

fn command_line(args: &[&str]) -> String {
    let mut line = String::from("$ wsb");
    for arg in args {
        // Only the config needs quotes, and PowerShell needs them for its < > & characters.
        if arg.starts_with('<') {
            line.push_str(&format!(" {}", quote(arg)));
        } else {
            line.push_str(&format!(" {}", arg));
        }
    }
    line
}

fn run_logged(app: &tauri::AppHandle, args: &[&str], limit: Duration) -> Result<String, AtlasError> {
    emit_line(app, command_line(args), false);
    let result = run_wsb(args, limit);
    if let Err(e) = &result {
        emit_line(app, format!("  ✗ {}", e), true);
    }
    result
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// With no sandbox path given, Windows puts the shared folder on the sandbox desktop.
fn build_config(networking: bool, folder: Option<&str>, writable: bool) -> String {
    let network = if networking { "Enable" } else { "Disable" };
    let mapped = folder
        .map(|path| {
            format!(
                "<MappedFolders><MappedFolder><HostFolder>{}</HostFolder><ReadOnly>{}</ReadOnly></MappedFolder></MappedFolders>",
                xml_escape(path),
                !writable,
            )
        })
        .unwrap_or_default();
    format!("<Configuration><Networking>{}</Networking>{}</Configuration>", network, mapped)
}

fn check_folder(raw: &str) -> Result<(), AtlasError> {
    let path = Path::new(raw);
    if path.is_absolute() && path.is_dir() {
        return Ok(());
    }
    Err(AtlasError::new(ErrorKind::NotFound, format!("The folder {} does not exist.", raw)).hint("Choose the folder again."))
}

/// A leading dash would make wsb read the ID as an option.
fn check_id(id: &str) -> Result<(), AtlasError> {
    if !id.is_empty() && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Ok(());
    }
    Err(AtlasError::invalid("That is not a sandbox ID."))
}

fn parse_running(json: &str) -> Result<Vec<String>, AtlasError> {
    let list: EnvironmentList = serde_json::from_str(json)
        .map_err(|_| AtlasError::invalid("Could not read the list of sandboxes.").detail(json))?;
    Ok(list.windows_sandbox_environments.into_iter().map(|e| e.id).collect())
}

fn parse_started(json: &str) -> Result<String, AtlasError> {
    let started: Environment = serde_json::from_str(json)
        .map_err(|_| AtlasError::invalid("The sandbox started, but its ID could not be read.").hint("Refresh to see it in the list.").detail(json))?;
    Ok(started.id)
}

fn status() -> Result<SandboxStatus, AtlasError> {
    match run_wsb(&["list", "--raw"], LIST_TIME_LIMIT) {
        Ok(json) => Ok(SandboxStatus { available: true, running: parse_running(&json)? }),
        Err(e) if e.kind == ErrorKind::NotFound => Ok(SandboxStatus { available: false, running: Vec::new() }),
        Err(e) => Err(e),
    }
}

fn start(app: &tauri::AppHandle, options: &SandboxOptions) -> Result<String, AtlasError> {
    if let Some(folder) = &options.folder {
        check_folder(folder)?;
    }
    let config = build_config(options.networking, options.folder.as_deref(), options.writable);
    let id = parse_started(&run_logged(app, &["start", "--raw", "--config", &config], START_TIME_LIMIT)?)?;
    emit_line(app, format!("  ✓ Started {}", id), false);
    Ok(id)
}

fn stop(app: &tauri::AppHandle, id: &str) -> Result<(), AtlasError> {
    check_id(id)?;
    run_logged(app, &["stop", "--id", id], STOP_TIME_LIMIT)?;
    emit_line(app, format!("  ✓ Stopped {}", id), false);
    Ok(())
}

/// Not waited for, because the window belongs to the user from here on.
fn open_window(id: &str) -> Result<(), AtlasError> {
    hidden("wsb")
        .args(["connect", "--id", id])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { wsb_missing() } else { e.into() })?;
    Ok(())
}

async fn in_background<T: Send + 'static>(work: impl FnOnce() -> Result<T, AtlasError> + Send + 'static) -> Result<T, AtlasError> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sandbox_status() -> Result<SandboxStatus, AtlasError> {
    in_background(status).await
}

#[tauri::command]
pub async fn sandbox_start(app: tauri::AppHandle, options: SandboxOptions) -> Result<String, AtlasError> {
    in_background(move || start(&app, &options)).await
}

#[tauri::command]
pub async fn sandbox_stop(app: tauri::AppHandle, id: String) -> Result<(), AtlasError> {
    in_background(move || stop(&app, &id)).await
}

#[tauri::command]
pub async fn sandbox_open_window(app: tauri::AppHandle, id: String) -> Result<(), AtlasError> {
    in_background(move || {
        check_id(&id)?;
        emit_line(&app, command_line(&["connect", "--id", &id]), false);
        open_window(&id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_turns_the_network_off_and_shares_nothing_by_default() {
        assert_eq!(build_config(false, None, false), "<Configuration><Networking>Disable</Networking></Configuration>");
        assert_eq!(build_config(true, None, true), "<Configuration><Networking>Enable</Networking></Configuration>");
    }

    #[test]
    fn a_shared_folder_is_read_only_unless_asked_and_its_path_cannot_break_the_config() {
        let read_only = build_config(false, Some(r"C:\Dev\R&D <new>"), false);
        assert!(read_only.contains(r"<HostFolder>C:\Dev\R&amp;D &lt;new&gt;</HostFolder>"), "{}", read_only);
        assert!(read_only.contains("<ReadOnly>true</ReadOnly>"));
        assert!(build_config(false, Some(r"C:\Dev"), true).contains("<ReadOnly>false</ReadOnly>"));
    }

    #[test]
    fn the_terminal_line_can_be_pasted_into_powershell() {
        assert_eq!(command_line(&["stop", "--id", "abc-1"]), "$ wsb stop --id abc-1");
        assert_eq!(
            command_line(&["start", "--raw", "--config", r"<Configuration><HostFolder>C:\Bob's</HostFolder></Configuration>"]),
            r"$ wsb start --raw --config '<Configuration><HostFolder>C:\Bob''s</HostFolder></Configuration>'",
        );
    }

    #[test]
    fn wsb_answers_are_read_from_its_real_output() {
        let list = "{\n  \"WindowsSandboxEnvironments\": [\n    {\n      \"Id\": \"8bff7ba0-c91e-40dc-9ab8-3903c82f70b5\"\n    }\n  ]\n}";
        assert_eq!(parse_running(list).unwrap(), vec!["8bff7ba0-c91e-40dc-9ab8-3903c82f70b5"]);
        assert!(parse_running("{\n  \"WindowsSandboxEnvironments\": []\n}").unwrap().is_empty());
        assert_eq!(parse_started("{\n  \"Id\": \"abc-1\"\n}").unwrap(), "abc-1");
        assert_eq!(parse_running("not json").unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(parse_started("").unwrap_err().kind, ErrorKind::Invalid);
    }

    #[test]
    fn an_id_cannot_pass_itself_off_as_an_option() {
        assert!(check_id("8bff7ba0-c91e-40dc-9ab8-3903c82f70b5").is_ok());
        for bad in ["", "--raw", "-h", "abc def", "abc;def", r"..\abc"] {
            assert_eq!(check_id(bad).unwrap_err().kind, ErrorKind::Invalid, "{}", bad);
        }
    }

    #[test]
    fn only_a_real_folder_can_be_shared() {
        assert!(check_folder(std::env::temp_dir().to_str().unwrap()).is_ok());
        for bad in ["relative\\folder", r"C:\no\such\folder\for\this\test", ""] {
            assert_eq!(check_folder(bad).unwrap_err().kind, ErrorKind::NotFound, "{}", bad);
        }
    }

    /// Boots a real sandbox and opens its window for a few seconds: `cargo test real_sandbox -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_sandbox_starts_opens_and_stops() {
        let folder = std::env::temp_dir().join("atlas sandbox R&D test");
        std::fs::create_dir_all(&folder).unwrap();
        let config = build_config(false, folder.to_str(), false);

        let id = parse_started(&run_wsb(&["start", "--raw", "--config", &config], START_TIME_LIMIT).unwrap()).unwrap();
        let listed = status().unwrap();
        let opened = open_window(&id);
        std::thread::sleep(Duration::from_secs(8));
        let stopped = run_wsb(&["stop", "--id", &id], STOP_TIME_LIMIT);
        let after = status().unwrap();
        std::fs::remove_dir_all(&folder).unwrap();

        assert!(listed.available && listed.running.contains(&id));
        opened.unwrap();
        stopped.unwrap();
        assert!(!after.running.contains(&id));
    }
}
