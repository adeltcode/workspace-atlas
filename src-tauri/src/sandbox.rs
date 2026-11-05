use std::path::{Path, PathBuf};
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
const MEMORY_CHOICES_MB: [u32; 3] = [4096, 8192, 16384];
const TRY_FOLDER_INSIDE: &str = r"C:\Users\WDAGUtilityAccount\Desktop\Try this file";
const OPENS_BY_ITSELF: [&str; 4] = ["exe", "msi", "bat", "cmd"];

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
    pub microphone: bool,
    pub camera: bool,
    pub clipboard: bool,
    pub printers: bool,
    pub graphics: bool,
    /// None leaves the amount to Windows.
    pub memory_mb: Option<u32>,
    /// A file to copy in and open as soon as the sandbox is ready.
    pub try_file: Option<String>,
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

fn enable_or_disable(on: bool) -> &'static str {
    if on { "Enable" } else { "Disable" }
}

/// With no sandbox path given, Windows puts the shared folder on the sandbox desktop.
fn mapped_folder(host: &str, inside: Option<&str>, read_only: bool) -> String {
    let inside = inside.map(|path| format!("<SandboxFolder>{}</SandboxFolder>", xml_escape(path))).unwrap_or_default();
    format!("<MappedFolder><HostFolder>{}</HostFolder>{}<ReadOnly>{}</ReadOnly></MappedFolder>", xml_escape(host), inside, read_only)
}

/// The quotes are safe because a Windows file name cannot contain one.
/// Other file types may have no app inside, so the folder opens with the file selected instead.
fn open_command(name: &str) -> String {
    let inside = format!(r"{}\{}", TRY_FOLDER_INSIDE, name);
    let extension = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or_default();
    if OPENS_BY_ITSELF.iter().any(|e| e.eq_ignore_ascii_case(extension)) {
        format!(r#"explorer.exe "{}""#, inside)
    } else {
        format!(r#"explorer.exe /select,"{}""#, inside)
    }
}

/// Every switch is written out because the Windows defaults share the microphone, clipboard, and graphics card.
fn build_config(options: &SandboxOptions, try_copy: Option<&Path>) -> String {
    let shared = options.folder.as_deref().map(|path| mapped_folder(path, None, !options.writable));
    let try_share = try_copy
        .and_then(Path::parent)
        .map(|folder| mapped_folder(&folder.to_string_lossy(), Some(TRY_FOLDER_INSIDE), true));
    let folders: String = shared.into_iter().chain(try_share).collect();
    let mapped = if folders.is_empty() { String::new() } else { format!("<MappedFolders>{}</MappedFolders>", folders) };
    let logon = try_copy
        .and_then(Path::file_name)
        .map(|name| format!("<LogonCommand><Command>{}</Command></LogonCommand>", xml_escape(&open_command(&name.to_string_lossy()))))
        .unwrap_or_default();
    let memory = options.memory_mb.map(|mb| format!("<MemoryInMB>{}</MemoryInMB>", mb)).unwrap_or_default();
    format!(
        "<Configuration><vGPU>{}</vGPU><Networking>{}</Networking>{}{}<AudioInput>{}</AudioInput><VideoInput>{}</VideoInput><PrinterRedirection>{}</PrinterRedirection><ClipboardRedirection>{}</ClipboardRedirection>{}</Configuration>",
        enable_or_disable(options.graphics),
        enable_or_disable(options.networking),
        mapped,
        logon,
        enable_or_disable(options.microphone),
        enable_or_disable(options.camera),
        enable_or_disable(options.printers),
        enable_or_disable(options.clipboard),
        memory,
    )
}

fn check_try_file(raw: &str) -> Result<(), AtlasError> {
    let path = Path::new(raw);
    if path.is_dir() {
        return Err(AtlasError::invalid("That is a folder. Choose one file, or use Share a folder."));
    }
    if path.is_absolute() && path.is_file() {
        return Ok(());
    }
    Err(AtlasError::new(ErrorKind::NotFound, format!("The file {} does not exist.", raw)).hint("Choose the file again."))
}

fn try_folder() -> PathBuf {
    std::env::temp_dir().join("workspace-atlas-sandbox-try")
}

/// Only a copy is shared, because a program can read every other file in a shared folder, even a read-only one.
fn copy_into_empty_folder(file: &str, folder: &Path) -> Result<PathBuf, AtlasError> {
    let failed = |e: std::io::Error| AtlasError::new(ErrorKind::Unknown, format!("Could not copy {}: {}", file, e));
    let name = Path::new(file).file_name().ok_or_else(|| AtlasError::invalid("That is not a file."))?;
    if folder.exists() {
        std::fs::remove_dir_all(folder).map_err(failed)?;
    }
    std::fs::create_dir_all(folder).map_err(failed)?;
    let copy = folder.join(name);
    std::fs::copy(file, &copy).map_err(failed)?;
    Ok(copy)
}

fn copy_logged(app: &tauri::AppHandle, file: &str) -> Result<PathBuf, AtlasError> {
    let folder = try_folder();
    let folder_text = quote(&folder.to_string_lossy());
    if folder.exists() {
        emit_line(app, format!("$ Remove-Item -LiteralPath {} -Recurse -Force", folder_text), false);
    }
    emit_line(app, format!("$ Copy-Item -LiteralPath {} -Destination (New-Item -ItemType Directory {})", quote(file), folder_text), false);
    let copied = copy_into_empty_folder(file, &folder);
    if let Err(e) = &copied {
        emit_line(app, format!("  ✗ {}", e), true);
    }
    copied
}

/// A copy that cannot be deleted now is cleared on the next try, so this never fails the stop.
fn delete_try_copy(app: &tauri::AppHandle) {
    let folder = try_folder();
    if !folder.exists() {
        return;
    }
    emit_line(app, format!("$ Remove-Item -LiteralPath {} -Recurse -Force", quote(&folder.to_string_lossy())), false);
    if let Err(e) = std::fs::remove_dir_all(&folder) {
        emit_line(app, format!("  ✗ Could not delete the copy: {}", e), true);
    }
}

fn check_memory(memory_mb: Option<u32>) -> Result<(), AtlasError> {
    match memory_mb {
        Some(mb) if !MEMORY_CHOICES_MB.contains(&mb) => Err(AtlasError::invalid(format!("{} MB is not one of the memory choices.", mb))),
        _ => Ok(()),
    }
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
    check_memory(options.memory_mb)?;
    let try_copy = match &options.try_file {
        Some(file) => {
            check_try_file(file)?;
            Some(copy_logged(app, file)?)
        }
        None => None,
    };
    let config = build_config(options, try_copy.as_deref());
    let id = parse_started(&run_logged(app, &["start", "--raw", "--config", &config], START_TIME_LIMIT)?)?;
    emit_line(app, format!("  ✓ Started {}", id), false);
    Ok(id)
}

fn stop(app: &tauri::AppHandle, id: &str) -> Result<(), AtlasError> {
    check_id(id)?;
    run_logged(app, &["stop", "--id", id], STOP_TIME_LIMIT)?;
    emit_line(app, format!("  ✓ Stopped {}", id), false);
    delete_try_copy(app);
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

    fn all_off() -> SandboxOptions {
        SandboxOptions {
            networking: false,
            folder: None,
            writable: false,
            microphone: false,
            camera: false,
            clipboard: false,
            printers: false,
            graphics: false,
            memory_mb: None,
            try_file: None,
        }
    }

    fn all_on() -> SandboxOptions {
        SandboxOptions {
            networking: true,
            microphone: true,
            camera: true,
            clipboard: true,
            printers: true,
            graphics: true,
            memory_mb: Some(8192),
            ..all_off()
        }
    }

    #[test]
    fn config_writes_out_every_switch_as_off() {
        assert_eq!(
            build_config(&all_off(), None),
            "<Configuration><vGPU>Disable</vGPU><Networking>Disable</Networking><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection></Configuration>",
        );
    }

    #[test]
    fn each_switch_turns_on_only_its_own_setting() {
        let cases = [
            (SandboxOptions { networking: true, ..all_off() }, "Networking"),
            (SandboxOptions { microphone: true, ..all_off() }, "AudioInput"),
            (SandboxOptions { camera: true, ..all_off() }, "VideoInput"),
            (SandboxOptions { clipboard: true, ..all_off() }, "ClipboardRedirection"),
            (SandboxOptions { printers: true, ..all_off() }, "PrinterRedirection"),
            (SandboxOptions { graphics: true, ..all_off() }, "vGPU"),
        ];
        for (options, setting) in cases {
            let config = build_config(&options, None);
            assert!(config.contains(&format!("<{0}>Enable</{0}>", setting)), "{}", config);
            assert_eq!(config.matches(">Enable<").count(), 1, "{}", config);
            assert_eq!(config.matches(">Disable<").count(), 5, "{}", config);
        }
    }

    #[test]
    fn a_shared_folder_is_read_only_unless_asked_and_its_path_cannot_break_the_config() {
        let read_only = build_config(&SandboxOptions { folder: Some(r"C:\Dev\R&D <new>".to_string()), ..all_off() }, None);
        assert!(read_only.contains(r"<HostFolder>C:\Dev\R&amp;D &lt;new&gt;</HostFolder>"), "{}", read_only);
        assert!(read_only.contains("<ReadOnly>true</ReadOnly>"));
        let writable = build_config(&SandboxOptions { folder: Some(r"C:\Dev".to_string()), writable: true, ..all_off() }, None);
        assert!(writable.contains("<ReadOnly>false</ReadOnly>"));
    }

    #[test]
    fn programs_open_by_themselves_and_other_files_are_only_shown() {
        for name in ["setup.exe", "SETUP.EXE", "tool.msi", "run.bat", "run.cmd"] {
            assert_eq!(open_command(name), format!(r#"explorer.exe "{}\{}""#, TRY_FOLDER_INSIDE, name));
        }
        for name in ["notes.txt", "script.ps1", "archive.zip", "no extension", "fake.exe.txt"] {
            assert_eq!(open_command(name), format!(r#"explorer.exe /select,"{}\{}""#, TRY_FOLDER_INSIDE, name));
        }
    }

    #[test]
    fn a_tried_file_is_shared_read_only_and_opened_at_logon() {
        let config = build_config(&all_off(), Some(Path::new(r"C:\Temp\try\R&D setup.exe")));
        assert!(config.contains(&format!(
            r"<MappedFolders><MappedFolder><HostFolder>C:\Temp\try</HostFolder><SandboxFolder>{}</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders>",
            TRY_FOLDER_INSIDE,
        )), "{}", config);
        assert!(config.contains(&format!(r#"<LogonCommand><Command>explorer.exe "{}\R&amp;D setup.exe"</Command></LogonCommand>"#, TRY_FOLDER_INSIDE)), "{}", config);
        assert!(!build_config(&all_off(), None).contains("LogonCommand"));
    }

    #[test]
    fn a_tried_file_does_not_replace_a_shared_folder_or_make_it_writable() {
        let options = SandboxOptions { folder: Some(r"C:\Dev".to_string()), ..all_off() };
        let config = build_config(&options, Some(Path::new(r"C:\Temp\try\setup.exe")));
        assert_eq!(config.matches("<MappedFolder>").count(), 2, "{}", config);
        assert_eq!(config.matches("<ReadOnly>true</ReadOnly>").count(), 2, "{}", config);
    }

    #[test]
    fn only_a_real_file_can_be_tried() {
        let folder = std::env::temp_dir().join(format!("atlas-try-check-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("real.txt");
        std::fs::write(&file, "x").unwrap();

        assert!(check_try_file(file.to_str().unwrap()).is_ok());
        assert_eq!(check_try_file(folder.to_str().unwrap()).unwrap_err().kind, ErrorKind::Invalid);
        for bad in ["real.txt", r"C:\no\such\file.exe", ""] {
            assert_eq!(check_try_file(bad).unwrap_err().kind, ErrorKind::NotFound, "{}", bad);
        }
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn the_copy_folder_holds_only_the_tried_file_even_after_a_read_only_one() {
        let root = std::env::temp_dir().join(format!("atlas-try-copy-{}", std::process::id()));
        let source = root.join("source");
        let folder = root.join("copy");
        std::fs::create_dir_all(&source).unwrap();
        let first = source.join("first.exe");
        let second = source.join("R&D's (1).exe");
        std::fs::write(source.join("beside.txt"), "private").unwrap();
        std::fs::write(&first, "1").unwrap();
        std::fs::write(&second, "2").unwrap();
        let mut read_only = std::fs::metadata(&first).unwrap().permissions();
        read_only.set_readonly(true);
        std::fs::set_permissions(&first, read_only).unwrap();

        copy_into_empty_folder(first.to_str().unwrap(), &folder).unwrap();
        let copy = copy_into_empty_folder(second.to_str().unwrap(), &folder).unwrap();

        let names: Vec<_> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec!["R&D's (1).exe"]);
        assert_eq!(std::fs::read_to_string(copy).unwrap(), "2");

        let mut writable = std::fs::metadata(&first).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        writable.set_readonly(false);
        std::fs::set_permissions(&first, writable).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn memory_is_left_to_windows_unless_a_listed_size_is_chosen() {
        assert!(!build_config(&all_off(), None).contains("MemoryInMB"));
        assert!(build_config(&SandboxOptions { memory_mb: Some(8192), ..all_off() }, None).contains("<MemoryInMB>8192</MemoryInMB>"));
        assert!(check_memory(None).is_ok());
        for mb in MEMORY_CHOICES_MB {
            assert!(check_memory(Some(mb)).is_ok(), "{}", mb);
        }
        for mb in [0, 2048, 4097, u32::MAX] {
            assert_eq!(check_memory(Some(mb)).unwrap_err().kind, ErrorKind::Invalid, "{}", mb);
        }
    }

    #[test]
    fn options_are_read_from_what_the_page_sends() {
        let json = r#"{"networking":false,"folder":null,"writable":false,"microphone":true,"camera":false,"clipboard":false,"printers":false,"graphics":false,"memory_mb":null,"try_file":null}"#;
        let options: SandboxOptions = serde_json::from_str(json).unwrap();
        assert!(options.microphone && !options.camera);
        assert_eq!(options.memory_mb, None);
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

    /// Boots a real sandbox twice, all off then all on, and opens each window for a few seconds:
    /// `cargo test real_sandbox -- --ignored --nocapture --test-threads=1`
    #[test]
    #[ignore]
    fn real_sandbox_starts_opens_and_stops() {
        let folder = std::env::temp_dir().join("atlas sandbox R&D test");
        std::fs::create_dir_all(&folder).unwrap();
        let shared = folder.to_str().map(String::from);

        for options in [SandboxOptions { folder: shared.clone(), ..all_off() }, SandboxOptions { folder: shared.clone(), ..all_on() }] {
            let config = build_config(&options, None);
            let id = parse_started(&run_wsb(&["start", "--raw", "--config", &config], START_TIME_LIMIT).unwrap()).unwrap();
            let listed = status().unwrap();
            let opened = open_window(&id);
            std::thread::sleep(Duration::from_secs(8));
            let stopped = run_wsb(&["stop", "--id", &id], STOP_TIME_LIMIT);
            let after = status().unwrap();

            assert!(listed.available && listed.running.contains(&id));
            opened.unwrap();
            stopped.unwrap();
            assert!(!after.running.contains(&id));
        }
        std::fs::remove_dir_all(&folder).unwrap();
    }

    /// Boots a real sandbox that runs a copied script, which lists what it can see into a shared folder.
    #[test]
    #[ignore]
    fn real_sandbox_runs_a_tried_file_that_sees_only_itself() {
        let root = std::env::temp_dir().join("atlas sandbox try test");
        let source = root.join("source");
        let results = root.join("atlas try results");
        let copy_folder = root.join("copy");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&results).unwrap();
        std::fs::write(source.join("beside me.txt"), "private").unwrap();
        let script = source.join("try me (1).cmd");
        std::fs::write(&script, "dir /b \"%~dp0\" > \"%USERPROFILE%\\Desktop\\atlas try results\\seen.txt\"\r\n").unwrap();

        let copy = copy_into_empty_folder(script.to_str().unwrap(), &copy_folder).unwrap();
        let options = SandboxOptions { folder: results.to_str().map(String::from), writable: true, ..all_off() };
        let config = build_config(&options, Some(&copy));
        let id = parse_started(&run_wsb(&["start", "--raw", "--config", &config], START_TIME_LIMIT).unwrap()).unwrap();
        let opened = open_window(&id);

        let seen = results.join("seen.txt");
        let waited = std::time::Instant::now();
        while !seen.exists() && waited.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_secs(1));
        }
        std::thread::sleep(Duration::from_secs(1));
        let listed = std::fs::read_to_string(&seen);
        let stopped = run_wsb(&["stop", "--id", &id], STOP_TIME_LIMIT);
        let cleared = std::fs::remove_dir_all(&root);

        opened.unwrap();
        stopped.unwrap();
        assert_eq!(listed.unwrap().trim(), "try me (1).cmd");
        cleared.unwrap();
    }
}
