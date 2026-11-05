use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{CpuRefreshKind, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

use crate::error::{AtlasError, ErrorKind};
use crate::shell::hidden;
use crate::wsl::{emit_line, output_within};
use crate::wsl_migration::quote;

const LIST_TIME_LIMIT: Duration = Duration::from_secs(15);
const START_TIME_LIMIT: Duration = Duration::from_secs(300);
const STOP_TIME_LIMIT: Duration = Duration::from_secs(60);
const SHARE_TIME_LIMIT: Duration = Duration::from_secs(30);
const EXEC_TIME_LIMIT: Duration = Duration::from_secs(20);
// PowerShell in a fresh sandbox took over 20 s with the host CPU at 84%, and nothing waits on these reads.
const DETAIL_TIME_LIMIT: Duration = Duration::from_secs(180);
const LOGON_TIME_LIMIT: Duration = Duration::from_secs(60);
const NOT_LOGGED_ON_YET: &str = "0x80070520";
const MEMORY_CHOICES_MB: [u32; 2] = [8192, 16384];
const DESKTOP_INSIDE: &str = r"C:\Users\WDAGUtilityAccount\Desktop";
const OPENS_BY_ITSELF: [&str; 4] = ["exe", "msi", "bat", "cmd"];
const WINDOW_PROGRAM: &str = "WindowsSandboxRemoteSession.exe";
const MEMORY_PROGRAM: &str = "vmmemWindowsSandbox";

const READ_THREADS: &str = "cmd.exe /c exit %NUMBER_OF_PROCESSORS%";
const READ_MEMORY_MB: &str = "powershell.exe -NoProfile -Command exit [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1MB)";
const READ_DISK_TOTAL_GB: &str = "powershell.exe -NoProfile -Command exit [int](((Get-PSDrive C).Used + (Get-PSDrive C).Free)/1GB)";
const READ_DISK_FREE_GB: &str = "powershell.exe -NoProfile -Command exit [int]((Get-PSDrive C).Free/1GB)";
const READ_WINDOWS_BUILD: &str = "powershell.exe -NoProfile -Command exit [Environment]::OSVersion.Version.Build";
// A closed or open window adds a Remote Display adapter, which is not a graphics card.
const READ_GRAPHICS_CARDS: &str = "powershell.exe -NoProfile -Command exit @(Get-CimInstance Win32_VideoController | Where-Object Name -NotMatch Remote).Count";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SandboxStatus {
    /// False when this PC has no `wsb` command.
    pub available: bool,
    pub running: Vec<String>,
    /// Closing the window does not stop the sandbox, so this can be false while one runs.
    pub window_open: bool,
    /// What the sandbox uses right now, seen from this PC.
    pub memory_used_bytes: Option<u64>,
}

/// None means the sandbox did not answer, except for `ip_address`, where it means no network.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SandboxDetails {
    /// Read from this PC, because a sandbox reports the same CPU as its host.
    pub cpu_name: Option<String>,
    pub cpu_threads: Option<u32>,
    pub memory_mb: Option<u32>,
    pub disk_total_gb: Option<u32>,
    pub disk_free_gb: Option<u32>,
    pub windows_build: Option<u32>,
    pub graphics: Option<bool>,
    pub ip_address: Option<String>,
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
    pub open_file: Option<String>,
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
        // PowerShell needs quotes around spaces and its own < > & characters.
        if arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:\\".contains(c)) {
            line.push_str(&format!(" {}", arg));
        } else {
            line.push_str(&format!(" {}", quote(arg)));
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

/// Each opened file has its own folder on the sandbox desktop: Shared file, Shared file 2, and so on.
fn shared_folder_inside(number: u32) -> String {
    match number {
        1 => format!(r"{}\Shared file", DESKTOP_INSIDE),
        _ => format!(r"{}\Shared file {}", DESKTOP_INSIDE, number),
    }
}

/// The quotes are safe because a Windows file name cannot contain one.
/// Other file types may have no app inside, so the folder opens with the file selected instead.
fn open_command(folder_inside: &str, name: &str) -> String {
    let inside = format!(r"{}\{}", folder_inside, name);
    let extension = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or_default();
    if OPENS_BY_ITSELF.iter().any(|e| e.eq_ignore_ascii_case(extension)) {
        format!(r#"explorer.exe "{}""#, inside)
    } else {
        format!(r#"explorer.exe /select,"{}""#, inside)
    }
}

/// Every switch is written out because the Windows defaults share the microphone, clipboard, and graphics card.
fn build_config(options: &SandboxOptions, open_copy: Option<&Path>) -> String {
    let inside = shared_folder_inside(1);
    let shared = options.folder.as_deref().map(|path| mapped_folder(path, None, !options.writable));
    let copy_share = open_copy
        .and_then(Path::parent)
        .map(|folder| mapped_folder(&folder.to_string_lossy(), Some(&inside), true));
    let folders: String = shared.into_iter().chain(copy_share).collect();
    let mapped = if folders.is_empty() { String::new() } else { format!("<MappedFolders>{}</MappedFolders>", folders) };
    let logon = open_copy
        .and_then(Path::file_name)
        .map(|name| format!("<LogonCommand><Command>{}</Command></LogonCommand>", xml_escape(&open_command(&inside, &name.to_string_lossy()))))
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

fn check_open_file(raw: &str) -> Result<(), AtlasError> {
    let path = Path::new(raw);
    if path.is_dir() {
        return Err(AtlasError::invalid("That is a folder. Choose one file, or use Share a folder."));
    }
    if path.is_absolute() && path.is_file() {
        return Ok(());
    }
    Err(AtlasError::new(ErrorKind::NotFound, format!("The file {} does not exist.", raw)).hint("Choose the file again."))
}

fn copies_folder() -> PathBuf {
    std::env::temp_dir().join("workspace-atlas-sandbox-file")
}

fn next_copy_number(copies: &Path) -> u32 {
    let mut number = 1;
    while copies.join(number.to_string()).exists() {
        number += 1;
    }
    number
}

/// Only a copy is shared, because a program can read every other file in a shared folder, even a read-only one.
fn copy_into_new_folder(file: &str, folder: &Path) -> Result<PathBuf, AtlasError> {
    let failed = |e: std::io::Error| AtlasError::new(ErrorKind::Unknown, format!("Could not copy {}: {}", file, e));
    let name = Path::new(file).file_name().ok_or_else(|| AtlasError::invalid("That is not a file."))?;
    std::fs::create_dir_all(folder).map_err(failed)?;
    let copy = folder.join(name);
    std::fs::copy(file, &copy).map_err(failed)?;
    Ok(copy)
}

fn copy_logged(app: &tauri::AppHandle, file: &str, folder: &Path) -> Result<PathBuf, AtlasError> {
    emit_line(app, format!("$ Copy-Item -LiteralPath {} -Destination (New-Item -ItemType Directory {})", quote(file), quote(&folder.to_string_lossy())), false);
    let copied = copy_into_new_folder(file, folder);
    if let Err(e) = &copied {
        emit_line(app, format!("  ✗ {}", e), true);
    }
    copied
}

/// A copy that cannot be deleted now is tried again on the next start or stop, so this never fails either one.
fn delete_copies(app: &tauri::AppHandle) {
    let copies = copies_folder();
    if !copies.exists() {
        return;
    }
    emit_line(app, format!("$ Remove-Item -LiteralPath {} -Recurse -Force", quote(&copies.to_string_lossy())), false);
    if let Err(e) = std::fs::remove_dir_all(&copies) {
        emit_line(app, format!("  ✗ Could not delete the copies: {}", e), true);
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

fn running_programs() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    system
}

fn program_memory(system: &System, name: &str) -> Option<u64> {
    let memory = system.processes_by_exact_name(name.as_ref()).next().map(|program| program.memory());
    memory
}

/// Windows runs one sandbox at a time, so any window program belongs to the running sandbox.
fn window_is_open() -> bool {
    program_memory(&running_programs(), WINDOW_PROGRAM).is_some()
}

fn status() -> Result<SandboxStatus, AtlasError> {
    let mut status = SandboxStatus { available: true, running: Vec::new(), window_open: false, memory_used_bytes: None };
    match run_wsb(&["list", "--raw"], LIST_TIME_LIMIT) {
        Ok(json) => status.running = parse_running(&json)?,
        Err(e) if e.kind == ErrorKind::NotFound => status.available = false,
        Err(e) => return Err(e),
    }
    if !status.running.is_empty() {
        let system = running_programs();
        status.window_open = program_memory(&system, WINDOW_PROGRAM).is_some();
        status.memory_used_bytes = program_memory(&system, MEMORY_PROGRAM).filter(|bytes| *bytes > 0);
    }
    Ok(status)
}

fn parse_exit_code(output: &str) -> Option<u32> {
    output.strip_prefix("Process exited with code:")?.trim().parse().ok()
}

fn host_cpu_name() -> Option<String> {
    let system = System::new_with_specifics(RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing()));
    system.cpus().first().map(|cpu| cpu.brand().trim().to_string()).filter(|name| !name.is_empty())
}

/// wsb exec returns no output, only an exit code, so each fact comes back as one number.
/// The System account needs no window, and no writable folder has to be shared for this.
fn read_details(id: &str, log: impl Fn(&[&str]) + Sync) -> SandboxDetails {
    let read = |command: &str| {
        let args = ["exec", "--id", id, "-r", "System", "-c", command];
        log(&args);
        run_wsb(&args, DETAIL_TIME_LIMIT).ok().and_then(|output| parse_exit_code(&output))
    };
    let read = &read;
    let [cpu_threads, memory_mb, disk_total_gb, disk_free_gb, windows_build, graphics_cards] = std::thread::scope(|scope| {
        [READ_THREADS, READ_MEMORY_MB, READ_DISK_TOTAL_GB, READ_DISK_FREE_GB, READ_WINDOWS_BUILD, READ_GRAPHICS_CARDS]
            .map(|command| scope.spawn(move || read(command)))
            .map(|reading| reading.join().ok().flatten())
    });
    let ip_args = ["ip", "--id", id];
    log(&ip_args);
    SandboxDetails {
        cpu_name: host_cpu_name(),
        cpu_threads,
        memory_mb,
        disk_total_gb,
        disk_free_gb,
        windows_build,
        graphics: graphics_cards.map(|cards| cards > 0),
        ip_address: run_wsb(&ip_args, LIST_TIME_LIMIT).ok().filter(|ip| !ip.is_empty()),
    }
}

fn start(app: &tauri::AppHandle, options: &SandboxOptions) -> Result<String, AtlasError> {
    if let Some(folder) = &options.folder {
        check_folder(folder)?;
    }
    check_memory(options.memory_mb)?;
    if let Some(file) = &options.open_file {
        check_open_file(file)?;
    }
    delete_copies(app);
    let copies = copies_folder();
    let open_copy = options
        .open_file
        .as_deref()
        .map(|file| copy_logged(app, file, &copies.join(next_copy_number(&copies).to_string())))
        .transpose()?;
    let config = build_config(options, open_copy.as_deref());
    let id = parse_started(&run_logged(app, &["start", "--raw", "--config", &config], START_TIME_LIMIT)?)?;
    emit_line(app, format!("  ✓ Started {}", id), false);
    Ok(id)
}

fn stop(app: &tauri::AppHandle, id: &str) -> Result<(), AtlasError> {
    check_id(id)?;
    run_logged(app, &["stop", "--id", id], STOP_TIME_LIMIT)?;
    emit_line(app, format!("  ✓ Stopped {}", id), false);
    delete_copies(app);
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

/// wsb refuses with this code until the sandbox has logged on, a few seconds after its first window opens.
fn run_once_logged_on(args: &[&str]) -> Result<String, AtlasError> {
    let waited = Instant::now();
    loop {
        match run_wsb(args, EXEC_TIME_LIMIT) {
            Err(e) if e.to_string().contains(NOT_LOGGED_ON_YET) && waited.elapsed() < LOGON_TIME_LIMIT => {
                std::thread::sleep(Duration::from_secs(2));
            }
            result => return result,
        }
    }
}

/// A second connect would open a second window. Without any window, a file opens out of sight.
fn open_window_if_closed(app: &tauri::AppHandle, id: &str) -> Result<(), AtlasError> {
    if window_is_open() {
        return Ok(());
    }
    emit_line(app, command_line(&["connect", "--id", id]), false);
    open_window(id)
}

fn open_in_running(app: &tauri::AppHandle, id: &str, file: &str) -> Result<(), AtlasError> {
    check_id(id)?;
    check_open_file(file)?;
    let copies = copies_folder();
    let number = next_copy_number(&copies);
    let folder = copies.join(number.to_string());
    let copy = copy_logged(app, file, &folder)?;
    let inside = shared_folder_inside(number);
    run_logged(app, &["share", "--id", id, "--host-path", &folder.to_string_lossy(), "--sandbox-path", &inside], SHARE_TIME_LIMIT)?;

    open_window_if_closed(app, id)?;

    let name = copy.file_name().unwrap_or_default().to_string_lossy();
    let command = open_command(&inside, &name);
    let args = ["exec", "--id", id, "-r", "ExistingLogin", "-c", &command];
    emit_line(app, command_line(&args), false);
    if let Err(e) = run_once_logged_on(&args) {
        emit_line(app, format!("  ✗ {}", e), true);
        return Err(e);
    }
    emit_line(app, format!("  ✓ Opened {}", name), false);
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
        open_window_if_closed(&app, &id)
    })
    .await
}

#[tauri::command]
pub async fn sandbox_open_file(app: tauri::AppHandle, id: String, file: String) -> Result<(), AtlasError> {
    in_background(move || open_in_running(&app, &id, &file)).await
}

#[tauri::command]
pub async fn sandbox_details(app: tauri::AppHandle, id: String) -> Result<SandboxDetails, AtlasError> {
    in_background(move || {
        check_id(&id)?;
        Ok(read_details(&id, |args| emit_line(&app, command_line(args), false)))
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
            open_file: None,
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
        let inside = shared_folder_inside(1);
        for name in ["setup.exe", "SETUP.EXE", "tool.msi", "run.bat", "run.cmd"] {
            assert_eq!(open_command(&inside, name), format!(r#"explorer.exe "{}\{}""#, inside, name));
        }
        for name in ["notes.txt", "script.ps1", "archive.zip", "no extension", "fake.exe.txt"] {
            assert_eq!(open_command(&inside, name), format!(r#"explorer.exe /select,"{}\{}""#, inside, name));
        }
    }

    #[test]
    fn each_opened_file_has_its_own_folder_on_the_sandbox_desktop() {
        assert_eq!(shared_folder_inside(1), r"C:\Users\WDAGUtilityAccount\Desktop\Shared file");
        assert_eq!(shared_folder_inside(2), r"C:\Users\WDAGUtilityAccount\Desktop\Shared file 2");
    }

    #[test]
    fn a_file_opened_at_start_is_shared_read_only_and_opened_at_logon() {
        let inside = shared_folder_inside(1);
        let config = build_config(&all_off(), Some(Path::new(r"C:\Temp\copies\1\R&D setup.exe")));
        assert!(config.contains(&format!(
            r"<MappedFolders><MappedFolder><HostFolder>C:\Temp\copies\1</HostFolder><SandboxFolder>{}</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders>",
            inside,
        )), "{}", config);
        assert!(config.contains(&format!(r#"<LogonCommand><Command>explorer.exe "{}\R&amp;D setup.exe"</Command></LogonCommand>"#, inside)), "{}", config);
        assert!(!build_config(&all_off(), None).contains("LogonCommand"));
    }

    #[test]
    fn an_opened_file_does_not_replace_a_shared_folder_or_make_it_writable() {
        let options = SandboxOptions { folder: Some(r"C:\Dev".to_string()), ..all_off() };
        let config = build_config(&options, Some(Path::new(r"C:\Temp\copies\1\setup.exe")));
        assert_eq!(config.matches("<MappedFolder>").count(), 2, "{}", config);
        assert_eq!(config.matches("<ReadOnly>true</ReadOnly>").count(), 2, "{}", config);
    }

    #[test]
    fn only_a_real_file_can_be_opened() {
        let folder = std::env::temp_dir().join(format!("atlas-open-check-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("real.txt");
        std::fs::write(&file, "x").unwrap();

        assert!(check_open_file(file.to_str().unwrap()).is_ok());
        assert_eq!(check_open_file(folder.to_str().unwrap()).unwrap_err().kind, ErrorKind::Invalid);
        for bad in ["real.txt", r"C:\no\such\file.exe", ""] {
            assert_eq!(check_open_file(bad).unwrap_err().kind, ErrorKind::NotFound, "{}", bad);
        }
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn each_copy_gets_a_new_folder_with_only_that_file_and_read_only_copies_can_be_deleted() {
        let root = std::env::temp_dir().join(format!("atlas-open-copy-{}", std::process::id()));
        let source = root.join("source");
        let copies = root.join("copies");
        std::fs::create_dir_all(&source).unwrap();
        let first = source.join("first.exe");
        let second = source.join("R&D's (1).exe");
        std::fs::write(source.join("beside.txt"), "private").unwrap();
        std::fs::write(&first, "1").unwrap();
        std::fs::write(&second, "2").unwrap();
        let mut read_only = std::fs::metadata(&first).unwrap().permissions();
        read_only.set_readonly(true);
        std::fs::set_permissions(&first, read_only).unwrap();

        assert_eq!(next_copy_number(&copies), 1);
        copy_into_new_folder(first.to_str().unwrap(), &copies.join("1")).unwrap();
        assert_eq!(next_copy_number(&copies), 2);
        let copy = copy_into_new_folder(second.to_str().unwrap(), &copies.join("2")).unwrap();
        assert_eq!(next_copy_number(&copies), 3);

        let names: Vec<_> = std::fs::read_dir(copies.join("2")).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec!["R&D's (1).exe"]);
        assert_eq!(std::fs::read_to_string(copy).unwrap(), "2");
        std::fs::remove_dir_all(&copies).unwrap();
        assert_eq!(next_copy_number(&copies), 1);

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
        let json = r#"{"networking":false,"folder":null,"writable":false,"microphone":true,"camera":false,"clipboard":false,"printers":false,"graphics":false,"memory_mb":null,"open_file":null}"#;
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
        assert_eq!(
            command_line(&["share", "--id", "abc-1", "--host-path", r"C:\Temp\1", "--sandbox-path", r"C:\Desktop\Shared file"]),
            r"$ wsb share --id abc-1 --host-path C:\Temp\1 --sandbox-path 'C:\Desktop\Shared file'",
        );
    }

    #[test]
    fn an_exit_code_is_read_only_from_wsb_real_wording() {
        assert_eq!(parse_exit_code("Process exited with code: 12"), Some(12));
        assert_eq!(parse_exit_code("Process exited with code: 0"), Some(0));
        for bad in ["", "12", "Process exited with code: ", "Process exited with code: -1", "A specified logon session does not exist."] {
            assert_eq!(parse_exit_code(bad), None, "{}", bad);
        }
    }

    #[test]
    fn the_commands_that_read_details_have_no_double_quotes_to_break_pasting() {
        for command in [READ_THREADS, READ_MEMORY_MB, READ_DISK_TOTAL_GB, READ_DISK_FREE_GB, READ_WINDOWS_BUILD, READ_GRAPHICS_CARDS] {
            assert!(!command.contains('"'), "{}", command);
        }
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

    /// Boots a real sandbox twice, all off then all on, with no window, and reads what each reports.
    #[test]
    #[ignore]
    fn real_sandbox_reports_its_details() {
        assert!(status().unwrap().running.is_empty(), "stop the running sandbox first");
        let host_threads = System::new_with_specifics(RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing())).cpus().len() as u32;

        for (options, memory_mb, shared) in [(all_off(), 4096, false), (all_on(), 8192, true)] {
            let config = build_config(&options, None);
            let id = parse_started(&run_wsb(&["start", "--raw", "--config", &config], START_TIME_LIMIT).unwrap()).unwrap();
            let waited = Instant::now();
            let details = read_details(&id, |_| {});
            let read_seconds = waited.elapsed().as_secs();
            let running = status();
            let stopped = run_wsb(&["stop", "--id", &id], STOP_TIME_LIMIT);
            eprintln!("{:?} in {} s, status {:?}", details, read_seconds, running);

            stopped.unwrap();
            let running = running.unwrap();
            assert!(running.memory_used_bytes.unwrap() > 0);
            assert!(!running.window_open);
            assert!(details.cpu_name.is_some());
            assert_eq!(details.cpu_threads, Some(host_threads));
            assert!(details.memory_mb.unwrap().abs_diff(memory_mb) < 64, "{:?}", details.memory_mb);
            assert!(details.disk_free_gb.unwrap() > 0 && details.disk_free_gb <= details.disk_total_gb);
            assert!(details.windows_build.unwrap() > 0);
            assert_eq!(details.graphics, Some(shared));
            assert_eq!(details.ip_address.is_some(), shared);
        }
    }

    /// A script that lists what it can see into a file in the shared results folder.
    fn write_listing_script(path: &Path, results_name: &str, listing: &str) {
        std::fs::write(path, format!("dir /b \"%~dp0\" > \"%USERPROFILE%\\Desktop\\{}\\{}\"\r\n", results_name, listing)).unwrap();
    }

    fn read_when_written(path: &Path) -> std::io::Result<String> {
        let waited = Instant::now();
        while !path.exists() && waited.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_secs(1));
        }
        std::thread::sleep(Duration::from_secs(1));
        std::fs::read_to_string(path)
    }

    /// Boots a real sandbox that runs a copied script at logon.
    #[test]
    #[ignore]
    fn real_sandbox_runs_an_opened_file_that_sees_only_itself() {
        let root = std::env::temp_dir().join("atlas sandbox open test");
        let source = root.join("source");
        let results = root.join("atlas open results");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&results).unwrap();
        std::fs::write(source.join("beside me.txt"), "private").unwrap();
        let script = source.join("open me (1).cmd");
        write_listing_script(&script, "atlas open results", "seen.txt");

        let copy = copy_into_new_folder(script.to_str().unwrap(), &root.join("copy")).unwrap();
        let options = SandboxOptions { folder: results.to_str().map(String::from), writable: true, ..all_off() };
        let config = build_config(&options, Some(&copy));
        let id = parse_started(&run_wsb(&["start", "--raw", "--config", &config], START_TIME_LIMIT).unwrap()).unwrap();
        let opened = open_window(&id);

        let listed = read_when_written(&results.join("seen.txt"));
        let stopped = run_wsb(&["stop", "--id", &id], STOP_TIME_LIMIT);
        let cleared = std::fs::remove_dir_all(&root);

        opened.unwrap();
        stopped.unwrap();
        assert_eq!(listed.unwrap().trim(), "open me (1).cmd");
        cleared.unwrap();
    }

    /// Opens one file with the window open and one after closing it. Closes only windows of its own sandbox,
    /// because it refuses to run while another sandbox is running.
    #[test]
    #[ignore]
    fn real_sandbox_opens_files_while_running_even_after_its_window_closes() {
        assert!(status().unwrap().running.is_empty(), "stop the running sandbox first");

        let root = std::env::temp_dir().join("atlas sandbox running test");
        let source = root.join("source");
        let results = root.join("atlas running results");
        let copies = root.join("copies");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&results).unwrap();
        std::fs::write(source.join("beside me.txt"), "private").unwrap();
        let first = source.join("first (1).cmd");
        let second = source.join("second & last.cmd");
        write_listing_script(&first, "atlas running results", "first.txt");
        write_listing_script(&second, "atlas running results", "second.txt");

        let options = SandboxOptions { folder: results.to_str().map(String::from), writable: true, ..all_off() };
        let config = build_config(&options, None);
        let id = parse_started(&run_wsb(&["start", "--raw", "--config", &config], START_TIME_LIMIT).unwrap()).unwrap();
        let opened = open_window(&id);

        let open_copy = |number: u32, file: &Path| -> Result<(), AtlasError> {
            let folder = copies.join(number.to_string());
            let copy = copy_into_new_folder(file.to_str().unwrap(), &folder)?;
            let inside = shared_folder_inside(number);
            run_wsb(&["share", "--id", &id, "--host-path", folder.to_str().unwrap(), "--sandbox-path", &inside], SHARE_TIME_LIMIT)?;
            if !window_is_open() {
                open_window(&id)?;
            }
            let command = open_command(&inside, &copy.file_name().unwrap().to_string_lossy());
            run_once_logged_on(&["exec", "--id", &id, "-r", "ExistingLogin", "-c", &command]).map(|_| ())
        };

        let first_opened = open_copy(1, &first);
        let first_listed = read_when_written(&results.join("first.txt"));
        let open_before_closing = window_is_open();

        let closing = hidden("taskkill").args(["/IM", WINDOW_PROGRAM]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let waited = Instant::now();
        while window_is_open() && waited.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_secs(1));
        }
        let open_after_closing = window_is_open();
        let running_after_closing = status().map(|s| s.running.contains(&id));

        let second_opened = open_copy(2, &second);
        let second_listed = read_when_written(&results.join("second.txt"));
        let open_after_second = window_is_open();

        let stopped = run_wsb(&["stop", "--id", &id], STOP_TIME_LIMIT);
        let cleared = std::fs::remove_dir_all(&root);

        opened.unwrap();
        first_opened.unwrap();
        assert_eq!(first_listed.unwrap().trim(), "first (1).cmd");
        assert!(open_before_closing);
        closing.unwrap();
        assert!(!open_after_closing);
        assert!(running_after_closing.unwrap());
        second_opened.unwrap();
        assert_eq!(second_listed.unwrap().trim(), "second & last.cmd");
        assert!(open_after_second);
        stopped.unwrap();
        cleared.unwrap();
    }
}
