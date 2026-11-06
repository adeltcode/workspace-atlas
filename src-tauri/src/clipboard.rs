//! Windows clipboard history: reading it, turning it on and off, and what can get in its way.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::System;
use windows::core::{Interface, HSTRING};
use windows::ApplicationModel::DataTransfer::{
    Clipboard, ClipboardHistoryItem, ClipboardHistoryItemsResultStatus, DataPackageView, SetHistoryItemAsContentStatus,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStream};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows_future::{AsyncStatus, IAsyncOperation};
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HWND};
use windows_sys::Win32::System::DataExchange::{GetClipboardOwner, GetClipboardSequenceNumber, GetOpenClipboardWindow};
use windows_sys::Win32::System::Registry::{
    RegGetValueW, RegSetKeyValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_DWORD, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetWindowThreadProcessId, MsgWaitForMultipleObjects, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, QS_ALLINPUT,
};

use crate::error::{AtlasError, ErrorKind};
use crate::holders::{describe, process_snapshot, ProcessInfo};
use crate::shell::hidden;
use crate::wsl::elevation_command;

const USER_KEY: &str = r"Software\Microsoft\Clipboard";
const USER_VALUE: &str = "EnableClipboardHistory";
const POLICY_KEY: &str = r"SOFTWARE\Policies\Microsoft\Windows\System";
const POLICY_VALUE: &str = "AllowClipboardHistory";
const MANAGED_POLICY_KEY: &str = r"SOFTWARE\Microsoft\PolicyManager\current\device\Experience";
const SERVICE_KEY: &str = r"SYSTEM\CurrentControlSet\Services\cbdhsvc";
const SERVICE_DISABLED: u32 = 4;
const EXPLORER_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";

// src/features/clipboard/rules.ts shows these before they run, and a test keeps the two the same.
const REMOVE_BLOCK_COMMAND: &str = r"Remove-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name AllowClipboardHistory";
const RESTART_SERVICE_COMMAND: &str = "Get-Service cbdhsvc_* | Restart-Service -Force";
const ENABLE_SERVICE_COMMAND: &str = "Set-Service -Name cbdhsvc -StartupType Automatic";

/// ERROR_SERVICE_DISABLED. A disabled clipboard service makes Windows refuse history calls.
const SERVICE_CANNOT_START: windows::core::HRESULT = windows::core::HRESULT(0x8007_0422_u32 as i32);

const TEXT_FORMAT: &str = "Text";
const IMAGE_FORMAT: &str = "Bitmap";
const HTML_FORMAT: &str = "HTML Format";
const FILE_FORMATS: [&str; 2] = ["FileDrop", "Shell IDList Array"];
// Windows adds the first to anything it puts back from history, so that needs the second check.
const KEEP_OUT_FORMAT: &str = "ExcludeClipboardContentFromMonitorProcessing";
const FROM_HISTORY_FORMAT: &str = "ClipboardHistoryItemId";
const INCLUDE_FORMAT: &str = "CanIncludeInClipboardHistory";

/// Windows can hold 25 items of several MB each, and the page only needs enough to read and search.
const MAX_TEXT_UNITS: usize = 100_000;
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const APPLY_TIME_LIMIT: Duration = Duration::from_millis(1500);
const WINDOWS_TIME_LIMIT: Duration = Duration::from_secs(10);
const HELD_CHECK_GAP: Duration = Duration::from_millis(200);
/// Windows counts time in 100 ns steps from 1601.
const UNIX_EPOCH_IN_WINDOWS_TIME: i64 = 116_444_736_000_000_000;

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum OtherProgramKind {
    KeepsHistory,
    UsesWindowsHistory,
    SharesClipboard,
    ClearsClipboard,
}

use OtherProgramKind::{ClearsClipboard, KeepsHistory, SharesClipboard, UsesWindowsHistory};

const OTHER_PROGRAMS: &[(&str, &str, OtherProgramKind)] = &[
    ("ditto.exe", "Ditto", KeepsHistory),
    ("copyq.exe", "CopyQ", KeepsHistory),
    ("clipclip.exe", "ClipClip", KeepsHistory),
    ("clipboardfusion.exe", "ClipboardFusion", KeepsHistory),
    ("clipmate.exe", "ClipMate", KeepsHistory),
    ("clipdiary.exe", "Clipdiary", KeepsHistory),
    ("clipangel.exe", "ClipAngel", KeepsHistory),
    ("1clipboard.exe", "1Clipboard", KeepsHistory),
    ("clibor.exe", "Clibor", KeepsHistory),
    ("clcl.exe", "CLCL", KeepsHistory),
    ("arsclip.exe", "ArsClip", KeepsHistory),
    ("clipx.exe", "ClipX", KeepsHistory),
    ("ecopaste.exe", "EcoPaste", KeepsHistory),
    ("pastebar.exe", "PasteBar", KeepsHistory),
    ("clipboardmaster.exe", "Clipboard Master", KeepsHistory),
    ("powertoys.advancedpaste.exe", "PowerToys Advanced Paste", UsesWindowsHistory),
    ("rdpclip.exe", "Remote Desktop", SharesClipboard),
    ("vmtoolsd.exe", "VMware Tools", SharesClipboard),
    ("vboxtray.exe", "VirtualBox Guest Additions", SharesClipboard),
    ("powertoys.mousewithoutborders.exe", "PowerToys Mouse Without Borders", SharesClipboard),
    ("kdeconnectd.exe", "KDE Connect", SharesClipboard),
    ("synergy.exe", "Synergy", SharesClipboard),
    ("barrier.exe", "Barrier", SharesClipboard),
    ("input-leap.exe", "Input Leap", SharesClipboard),
    ("deskflow.exe", "Deskflow", SharesClipboard),
    ("1password.exe", "1Password", ClearsClipboard),
    ("bitwarden.exe", "Bitwarden", ClearsClipboard),
    ("keepass.exe", "KeePass", ClearsClipboard),
    ("keepassxc.exe", "KeePassXC", ClearsClipboard),
];

#[derive(Serialize, Clone, Debug)]
pub struct OtherProgram {
    pub label: &'static str,
    pub kind: OtherProgramKind,
    pub process: ProcessInfo,
}

#[derive(Serialize, Clone, Debug)]
pub struct ClipboardStatus {
    pub history_on: bool,
    /// None when the value was never set, which Windows treats as off.
    pub user_setting: Option<bool>,
    pub blocked_by_policy: bool,
    /// Set by a device management service, which would put it back if it were removed here.
    pub block_is_managed: bool,
    pub sync_on: bool,
    /// Windows is set not to start the clipboard service.
    pub service_disabled: bool,
    /// The service is not running and cannot start. A change to service_disabled only reaches
    /// the running session at the next sign-in, so the two can differ.
    pub service_stopped: bool,
    pub win_v_disabled: bool,
    /// A program that has kept the clipboard open, so others cannot copy or paste.
    pub held_by: Option<ProcessInfo>,
    pub other_programs: Vec<OtherProgram>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ItemContent {
    pub formats: Vec<String>,
    /// Cut to `MAX_TEXT_UNITS`.
    pub text: Option<String>,
    /// The whole text's length, in the same units as a JavaScript string.
    pub text_length: Option<usize>,
    pub has_image: bool,
    pub has_html: bool,
    pub has_files: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct HistoryEntry {
    pub id: String,
    /// Milliseconds since 1970.
    pub copied_at: i64,
    /// Left out for an item the page already has, because an item never changes and can be several MB.
    pub content: Option<ItemContent>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CurrentClipboard {
    #[serde(flatten)]
    pub content: ItemContent,
    /// The program that last copied. Not always known.
    pub owner: Option<ProcessInfo>,
    /// The program asked Windows to keep this out of history, as password managers do.
    pub kept_out_of_history: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct ClipboardRead {
    pub history_on: bool,
    pub entries: Vec<HistoryEntry>,
    /// Left out while the clipboard has not changed, or when another program has it open.
    pub current: Option<CurrentClipboard>,
    pub sequence: Option<u32>,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn read_dword(root: HKEY, key: &str, value: &str) -> Option<u32> {
    let (key, value) = (wide(key), wide(value));
    let mut data = 0u32;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&raw mut data).cast(), &mut size)
    };
    (status == ERROR_SUCCESS).then_some(data)
}

fn read_text_value(root: HKEY, key: &str, value: &str) -> Option<String> {
    let (key, value) = (wide(key), wide(value));
    let mut size = 0u32;
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), data.as_mut_ptr().cast(), &mut size)
    };
    (status == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&data).trim_end_matches('\0').to_string())
}

fn write_user_setting(on: bool) -> Result<(), AtlasError> {
    let (key, value) = (wide(USER_KEY), wide(USER_VALUE));
    let data = u32::from(on);
    let status = unsafe {
        RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), REG_DWORD, (&raw const data).cast(), size_of::<u32>() as u32)
    };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(AtlasError::new(ErrorKind::Permission, "Windows would not save the clipboard history setting.")
            .detail(std::io::Error::from_raw_os_error(status as i32).to_string()))
    }
}

/// get() from the windows crate blocks without running this thread's messages. The answer arrives as
/// one of those messages on a single-threaded apartment thread, so get() here never returns.
fn wait<T: windows::core::RuntimeType>(operation: &IAsyncOperation<T>) -> windows::core::Result<T> {
    let started = Instant::now();
    while operation.Status()? == AsyncStatus::Started {
        if started.elapsed() > WINDOWS_TIME_LIMIT {
            operation.Cancel().ok();
            return Err(windows::core::Error::new(windows::core::HRESULT(0x8007_05B4_u32 as i32), "Windows did not answer in time."));
        }
        unsafe {
            MsgWaitForMultipleObjects(0, std::ptr::null(), 0, 5, QS_ALLINPUT);
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    operation.GetResults()
}

fn load_bytes(reader: &DataReader, count: u32) -> windows::core::Result<u32> {
    wait(&reader.LoadAsync(count)?.cast::<IAsyncOperation<u32>>()?)
}

fn windows_failure(message: &str, error: &windows::core::Error) -> AtlasError {
    AtlasError::new(ErrorKind::Unknown, message).detail(format!("{} ({:#010X})", error.message(), error.code().0))
}

/// None when the clipboard service cannot start.
fn history_is_on() -> Result<Option<bool>, AtlasError> {
    match Clipboard::IsHistoryEnabled() {
        Ok(on) => Ok(Some(on)),
        Err(e) if e.code() == SERVICE_CANNOT_START => Ok(None),
        Err(e) => Err(windows_failure("Could not ask Windows whether clipboard history is on.", &e)),
    }
}

fn policy_blocks(value: Option<u32>) -> bool {
    value == Some(0)
}

fn win_v_is_disabled(disabled_hotkeys: &str) -> bool {
    disabled_hotkeys.chars().any(|c| c.eq_ignore_ascii_case(&'v'))
}

/// One row per program, however many copies of it are running.
fn known_programs<'a>(running: impl Iterator<Item = (u32, &'a str)>) -> Vec<(u32, &'static str, OtherProgramKind)> {
    let mut found: Vec<_> = running
        .filter_map(|(pid, name)| {
            let name = name.to_lowercase();
            OTHER_PROGRAMS.iter().find(|(exe, _, _)| *exe == name).map(|(_, label, kind)| (pid, *label, *kind))
        })
        .collect();
    found.sort_by_key(|(pid, label, _)| (*label, *pid));
    found.dedup_by_key(|(_, label, _)| *label);
    found
}

fn other_programs(system: &System) -> Vec<OtherProgram> {
    let names: Vec<(u32, String)> = system
        .processes()
        .iter()
        .map(|(pid, process)| (pid.as_u32(), process.name().to_string_lossy().to_string()))
        .collect();
    known_programs(names.iter().map(|(pid, name)| (*pid, name.as_str())))
        .into_iter()
        .map(|(pid, label, kind)| OtherProgram { label, kind, process: describe(system, pid) })
        .collect()
}

fn pid_of_window(window: HWND) -> Option<u32> {
    if window.is_null() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    (pid != 0).then_some(pid)
}

/// Programs open the clipboard for a moment all the time, so only the same window twice counts.
fn pid_holding_clipboard() -> Option<u32> {
    let window = unsafe { GetOpenClipboardWindow() };
    if window.is_null() {
        return None;
    }
    std::thread::sleep(HELD_CHECK_GAP);
    if unsafe { GetOpenClipboardWindow() } == window {
        pid_of_window(window)
    } else {
        None
    }
}

fn read_status() -> Result<ClipboardStatus, AtlasError> {
    let system = process_snapshot();
    let policy = read_dword(HKEY_LOCAL_MACHINE, POLICY_KEY, POLICY_VALUE);
    let managed_policy = read_dword(HKEY_LOCAL_MACHINE, MANAGED_POLICY_KEY, POLICY_VALUE);
    let history = history_is_on()?;
    Ok(ClipboardStatus {
        history_on: history == Some(true),
        service_stopped: history.is_none(),
        user_setting: read_dword(HKEY_CURRENT_USER, USER_KEY, USER_VALUE).map(|value| value != 0),
        blocked_by_policy: policy_blocks(policy) || policy_blocks(managed_policy),
        block_is_managed: policy_blocks(managed_policy),
        sync_on: Clipboard::IsRoamingEnabled().unwrap_or(false),
        service_disabled: read_dword(HKEY_LOCAL_MACHINE, SERVICE_KEY, "Start") == Some(SERVICE_DISABLED),
        win_v_disabled: read_text_value(HKEY_CURRENT_USER, EXPLORER_KEY, "DisabledHotkeys").is_some_and(|keys| win_v_is_disabled(&keys)),
        held_by: pid_holding_clipboard().map(|pid| describe(&system, pid)),
        other_programs: other_programs(&system),
    })
}

fn cut_text(text: &[u16]) -> (String, usize) {
    (String::from_utf16_lossy(&text[..text.len().min(MAX_TEXT_UNITS)]), text.len())
}

fn has_file_format(formats: &[String]) -> bool {
    formats.iter().any(|format| FILE_FORMATS.contains(&format.as_str()))
}

/// A part that cannot be read is left out, so one bad item does not lose the rest of the list.
fn read_content(view: &DataPackageView) -> ItemContent {
    let formats: Vec<String> = view
        .AvailableFormats()
        .map(|list| list.into_iter().map(|format| format.to_string()).collect())
        .unwrap_or_default();
    let has = |name: &str| formats.iter().any(|format| format == name);
    let text = has(TEXT_FORMAT)
        .then(|| view.GetTextAsync().and_then(|operation| wait(&operation)).ok())
        .flatten()
        .map(|text| cut_text(&text));
    ItemContent {
        has_image: has(IMAGE_FORMAT),
        has_html: has(HTML_FORMAT),
        has_files: has_file_format(&formats),
        text_length: text.as_ref().map(|(_, length)| *length),
        text: text.map(|(text, _)| text),
        formats,
    }
}

/// `CanIncludeInClipboardHistory` holds a DWORD: 0 keeps the item out, and 1 asks for it to be kept.
fn asks_to_stay_out(view: &DataPackageView, formats: &[String]) -> bool {
    let has = |name: &str| formats.iter().any(|format| format == name);
    if has(KEEP_OUT_FORMAT) && !has(FROM_HISTORY_FORMAT) {
        return true;
    }
    has(INCLUDE_FORMAT) && dword_format(view, INCLUDE_FORMAT).is_none_or(|value| value == 0)
}

fn dword_format(view: &DataPackageView, format: &str) -> Option<u32> {
    let stream = wait(&view.GetDataAsync(&HSTRING::from(format)).ok()?).ok()?.cast::<IRandomAccessStream>().ok()?;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    load_bytes(&reader, 4).ok()?;
    reader.SetByteOrder(windows::Storage::Streams::ByteOrder::LittleEndian).ok()?;
    reader.ReadUInt32().ok()
}

fn read_current(system_owner: impl FnOnce() -> Option<ProcessInfo>) -> Option<CurrentClipboard> {
    let view = Clipboard::GetContent().ok()?;
    let content = read_content(&view);
    Some(CurrentClipboard {
        kept_out_of_history: asks_to_stay_out(&view, &content.formats),
        owner: system_owner(),
        content,
    })
}

fn clipboard_owner() -> Option<ProcessInfo> {
    let pid = pid_of_window(unsafe { GetClipboardOwner() })?;
    Some(describe(&process_snapshot(), pid))
}

fn history_items() -> Result<Option<Vec<ClipboardHistoryItem>>, AtlasError> {
    let failed = |e: windows::core::Error| windows_failure("Could not read clipboard history from Windows.", &e);
    if history_is_on()?.is_none() {
        return Ok(None);
    }
    let result = wait(&Clipboard::GetHistoryItemsAsync().map_err(failed)?).map_err(failed)?;
    match result.Status().map_err(failed)? {
        ClipboardHistoryItemsResultStatus::ClipboardHistoryDisabled => Ok(None),
        ClipboardHistoryItemsResultStatus::Success => Ok(Some(result.Items().map_err(failed)?.into_iter().collect())),
        _ => Err(AtlasError::new(ErrorKind::Permission, "Windows would not share clipboard history with this app.")
            .hint("Click this window and try again.")),
    }
}

fn milliseconds_since_1970(windows_time: i64) -> i64 {
    (windows_time - UNIX_EPOCH_IN_WINDOWS_TIME) / 10_000
}

fn history_entry(item: &ClipboardHistoryItem, known: &HashSet<&str>) -> Option<HistoryEntry> {
    let id = item.Id().ok()?.to_string();
    let copied_at = milliseconds_since_1970(item.Timestamp().ok()?.UniversalTime);
    let content = if known.contains(id.as_str()) { None } else { Some(read_content(&item.Content().ok()?)) };
    Some(HistoryEntry { id, copied_at, content })
}

fn read_clipboard(known_ids: &[String], known_sequence: Option<u32>) -> Result<ClipboardRead, AtlasError> {
    let known: HashSet<&str> = known_ids.iter().map(String::as_str).collect();
    let entries = history_items()?
        .unwrap_or_default()
        .iter()
        .filter_map(|item| history_entry(item, &known))
        .collect();

    // Reading the clipboard opens it, which can make another program's copy fail, so only read it when it has changed.
    let sequence = unsafe { GetClipboardSequenceNumber() };
    let current = if known_sequence == Some(sequence) { None } else { read_current(clipboard_owner) };
    Ok(ClipboardRead {
        history_on: history_is_on()? == Some(true),
        entries,
        sequence: if current.is_some() { Some(sequence) } else { known_sequence },
        current,
    })
}

/// Windows has no call for this, so it writes the registry value and checks the clipboard service took it.
/// The service watches the key it opened at start, so it misses changes if that key was deleted and remade.
fn set_history(on: bool) -> Result<(), AtlasError> {
    // The service only looks again when the value changes, so writing the same value would do nothing.
    if on && history_is_on()? == Some(false) && read_dword(HKEY_CURRENT_USER, USER_KEY, USER_VALUE) == Some(1) {
        write_user_setting(false)?;
    }
    write_user_setting(on)?;
    let started = Instant::now();
    while started.elapsed() < APPLY_TIME_LIMIT {
        match history_is_on()? {
            None => return Err(AtlasError::new(ErrorKind::Unknown, "The clipboard service is disabled, so Windows cannot apply this setting.")),
            Some(state) if state == on => return Ok(()),
            Some(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    if on && policy_blocks(read_dword(HKEY_LOCAL_MACHINE, POLICY_KEY, POLICY_VALUE)) {
        return Err(AtlasError::new(ErrorKind::Permission, "A policy on this PC blocks clipboard history, so Windows did not turn it on."));
    }
    Err(AtlasError::new(ErrorKind::Unknown, "Windows saved the setting, but the clipboard service did not apply it.")
        .hint("Restart the clipboard service from this page, or sign out of Windows and back in."))
}

fn find_item(id: &str) -> Result<ClipboardHistoryItem, AtlasError> {
    history_items()?
        .unwrap_or_default()
        .into_iter()
        .find(|item| item.Id().is_ok_and(|item_id| item_id == id))
        .ok_or_else(|| AtlasError::new(ErrorKind::NotFound, "That item is no longer in clipboard history.").hint("Windows keeps the 25 newest items."))
}

fn copy_item(id: &str) -> Result<(), AtlasError> {
    let item = find_item(id)?;
    match Clipboard::SetHistoryItemAsContent(&item).map_err(|e| windows_failure("Could not put this item back on the clipboard.", &e))? {
        SetHistoryItemAsContentStatus::Success => Ok(()),
        SetHistoryItemAsContentStatus::ItemDeleted => Err(AtlasError::new(ErrorKind::NotFound, "That item is no longer in clipboard history.")),
        _ => Err(AtlasError::new(ErrorKind::Permission, "Windows would not put this item back on the clipboard.")
            .hint("Click this window and try again.")),
    }
}

fn delete_item(id: &str) -> Result<(), AtlasError> {
    let item = find_item(id)?;
    match Clipboard::DeleteItemFromHistory(&item) {
        Ok(true) => Ok(()),
        Ok(false) => Err(AtlasError::new(ErrorKind::Unknown, "Windows did not delete this item.")),
        Err(e) => Err(windows_failure("Could not delete this item.", &e)),
    }
}

fn clear_history() -> Result<(), AtlasError> {
    match Clipboard::ClearHistory() {
        Ok(true) => Ok(()),
        Ok(false) => Err(AtlasError::new(ErrorKind::Unknown, "Windows did not clear clipboard history.")),
        Err(e) => Err(windows_failure("Could not clear clipboard history.", &e)),
    }
}

fn item_image(id: &str) -> Result<Vec<u8>, AtlasError> {
    let failed = |e: windows::core::Error| windows_failure("Could not read this image.", &e);
    let view = find_item(id)?.Content().map_err(failed)?;
    let reference = wait(&view.GetBitmapAsync().map_err(failed)?).map_err(failed)?;
    let stream = wait(&reference.OpenReadAsync().map_err(failed)?).map_err(failed)?;
    let size = stream.Size().map_err(failed)?;
    if size > MAX_IMAGE_BYTES {
        return Err(AtlasError::invalid("This image is too large to preview."));
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(failed)?).map_err(failed)?;
    load_bytes(&reader, size as u32).map_err(failed)?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).map_err(failed)?;
    Ok(bytes)
}

fn run_as_admin(script: &str) -> Result<(), AtlasError> {
    let output = hidden("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &elevation_command(script)])
        .output()
        .map_err(|e| format!("Could not ask Windows for administrator approval: {}", e))?;
    match output.status.code() {
        Some(0) => Ok(()),
        Some(1223) => Err(AtlasError::new(ErrorKind::Elevation, "Administrator approval was not given, so nothing was changed.")),
        _ => Err(AtlasError::new(ErrorKind::Unknown, "The command that needed administrator approval failed.")
            .detail(String::from_utf8_lossy(&output.stderr))),
    }
}

/// Removing the policy is not enough: the clipboard service only looks again when the setting changes.
fn remove_block() -> Result<(), AtlasError> {
    run_as_admin(REMOVE_BLOCK_COMMAND)?;
    if policy_blocks(read_dword(HKEY_LOCAL_MACHINE, POLICY_KEY, POLICY_VALUE)) {
        return Err(AtlasError::new(ErrorKind::Unknown, "The policy is still there, so clipboard history stays blocked."));
    }
    set_history(true)
}

/// Windows refuses its clipboard class outside a single-threaded apartment (0x8000001D). A shared worker
/// thread may already be set up another way, so each call gets a new thread.
fn on_clipboard_thread<T: Send + 'static>(work: impl FnOnce() -> Result<T, AtlasError> + Send + 'static) -> Result<T, AtlasError> {
    std::thread::spawn(move || {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|e| windows_failure("Could not prepare a thread for the clipboard.", &e))?;
        let result = work();
        unsafe { CoUninitialize() };
        result
    })
    .join()
    .map_err(|_| AtlasError::new(ErrorKind::Unknown, "The clipboard call stopped unexpectedly."))?
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, AtlasError> + Send + 'static) -> Result<T, AtlasError> {
    tauri::async_runtime::spawn_blocking(move || on_clipboard_thread(work)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clipboard_status() -> Result<ClipboardStatus, AtlasError> {
    blocking(read_status).await
}

#[tauri::command]
pub async fn clipboard_read(known_ids: Vec<String>, known_sequence: Option<u32>) -> Result<ClipboardRead, AtlasError> {
    blocking(move || read_clipboard(&known_ids, known_sequence)).await
}

#[tauri::command]
pub async fn clipboard_set_history(on: bool) -> Result<(), AtlasError> {
    blocking(move || set_history(on)).await
}

#[tauri::command]
pub async fn clipboard_copy_item(id: String) -> Result<(), AtlasError> {
    blocking(move || copy_item(&id)).await
}

#[tauri::command]
pub async fn clipboard_delete_item(id: String) -> Result<(), AtlasError> {
    blocking(move || delete_item(&id)).await
}

#[tauri::command]
pub async fn clipboard_clear_history() -> Result<(), AtlasError> {
    blocking(clear_history).await
}

#[tauri::command]
pub async fn clipboard_clear_current() -> Result<(), AtlasError> {
    blocking(|| Clipboard::Clear().map_err(|e| windows_failure("Could not clear the clipboard.", &e))).await
}

#[tauri::command]
pub async fn clipboard_item_image(id: String) -> Result<tauri::ipc::Response, AtlasError> {
    blocking(move || item_image(&id)).await.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn clipboard_remove_block() -> Result<(), AtlasError> {
    blocking(remove_block).await
}

#[tauri::command]
pub async fn clipboard_restart_service() -> Result<(), AtlasError> {
    blocking(|| run_as_admin(RESTART_SERVICE_COMMAND)).await
}

#[tauri::command]
pub async fn clipboard_enable_service() -> Result<(), AtlasError> {
    blocking(|| run_as_admin(ENABLE_SERVICE_COMMAND)).await
}

#[tauri::command]
pub async fn clipboard_open_settings() -> Result<(), AtlasError> {
    tauri_plugin_opener::open_url("ms-settings:clipboard", None::<&str>).map_err(|e| {
        AtlasError::new(ErrorKind::Unknown, "Could not open Windows Settings.").detail(e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_zero_policy_blocks_history() {
        assert!(policy_blocks(Some(0)));
        assert!(!policy_blocks(Some(1)));
        assert!(!policy_blocks(None));
    }

    #[test]
    fn the_win_v_shortcut_is_off_when_v_is_in_the_disabled_keys() {
        assert!(win_v_is_disabled("V"));
        assert!(win_v_is_disabled("qv"));
        assert!(!win_v_is_disabled("Q"));
        assert!(!win_v_is_disabled(""));
    }

    #[test]
    fn known_programs_match_by_exact_name_and_appear_once() {
        let running = [(9, "Ditto.exe"), (4, "DITTO.EXE"), (5, "notditto.exe"), (6, "explorer.exe"), (7, "rdpclip.exe")];
        assert_eq!(
            known_programs(running.into_iter()),
            vec![(4, "Ditto", KeepsHistory), (7, "Remote Desktop", SharesClipboard)]
        );
    }

    #[test]
    fn every_known_program_name_is_lowercase_so_it_can_match() {
        for (exe, _, _) in OTHER_PROGRAMS {
            assert_eq!(*exe, exe.to_lowercase());
        }
    }

    #[test]
    fn long_text_is_cut_but_keeps_its_real_length() {
        let short: Vec<u16> = "hello".encode_utf16().collect();
        assert_eq!(cut_text(&short), ("hello".to_string(), 5));
        let long = vec![b'x' as u16; MAX_TEXT_UNITS + 7];
        let (text, length) = cut_text(&long);
        assert_eq!(text.len(), MAX_TEXT_UNITS);
        assert_eq!(length, MAX_TEXT_UNITS + 7);
    }

    #[test]
    fn windows_time_converts_to_milliseconds_since_1970() {
        assert_eq!(milliseconds_since_1970(UNIX_EPOCH_IN_WINDOWS_TIME), 0);
        assert_eq!(milliseconds_since_1970(UNIX_EPOCH_IN_WINDOWS_TIME + 15_000), 1);
    }

    #[test]
    fn the_commands_shown_on_the_page_are_the_ones_that_run() {
        let rules = include_str!("../../src/features/clipboard/rules.ts");
        assert!(rules.contains(&REMOVE_BLOCK_COMMAND.replace('\\', "\\\\")));
        assert!(rules.contains(RESTART_SERVICE_COMMAND));
        assert!(rules.contains(ENABLE_SERVICE_COMMAND));
    }

    fn powershell(script: &str) -> std::process::Output {
        hidden("powershell").args(["-NoProfile", "-NonInteractive", "-Sta", "-Command", script]).output().unwrap()
    }

    fn copy_text(text: &str) {
        assert!(powershell(&format!("Set-Clipboard -Value '{text}'")).status.success());
        std::thread::sleep(Duration::from_millis(900));
    }

    fn entry_with<'a>(read: &'a ClipboardRead, text: &str) -> Option<&'a HistoryEntry> {
        read.entries.iter().find(|entry| entry.content.as_ref().is_some_and(|content| content.text.as_deref() == Some(text)))
    }

    /// Changes clipboard settings and contents, so it refuses to run outside Windows Sandbox. To run it there:
    /// `workspace_atlas_lib-*.exe clipboard::tests::the_real_clipboard --ignored --nocapture`
    #[test]
    #[ignore = "changes clipboard settings, so it only runs inside Windows Sandbox"]
    fn the_real_clipboard_works() {
        assert_eq!(std::env::var("USERNAME").as_deref(), Ok("WDAGUtilityAccount"), "run this inside Windows Sandbox");
        on_clipboard_thread(|| {
            real_clipboard_steps();
            Ok(())
        })
        .unwrap();
    }

    fn real_clipboard_steps() {
        set_history(true).unwrap();
        assert!(read_status().unwrap().history_on);
        clear_history().unwrap();

        copy_text("alpha");
        copy_text("beta");
        let started = Instant::now();
        let read = read_clipboard(&[], None).unwrap();
        println!("read took {:?}", started.elapsed());
        let alpha = entry_with(&read, "alpha").expect("alpha is in history").id.clone();
        let beta = entry_with(&read, "beta").expect("beta is in history").id.clone();
        assert!(read.history_on);
        assert_eq!(read.current.as_ref().and_then(|current| current.content.text.as_deref()), Some("beta"));

        let again = read_clipboard(&[alpha.clone(), beta.clone()], read.sequence).unwrap();
        assert!(again.current.is_none(), "an unchanged clipboard is not read again");
        assert!(again.entries.iter().all(|entry| entry.content.is_none()), "known items are not read again");

        copy_item(&alpha).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let restored = read_clipboard(&[], None).unwrap().current.unwrap();
        assert_eq!(restored.content.text.as_deref(), Some("alpha"));
        assert!(!restored.kept_out_of_history, "an item put back from history is not a private one");
        println!("owner after a copy back: {:?}", restored.owner.map(|owner| owner.name));

        delete_item(&beta).unwrap();
        assert!(entry_with(&read_clipboard(&[], None).unwrap(), "beta").is_none());
        assert_eq!(copy_item(&beta).unwrap_err().kind, ErrorKind::NotFound);

        assert!(powershell("Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage((New-Object System.Drawing.Bitmap 64,48))").status.success());
        std::thread::sleep(Duration::from_millis(1500));
        let read = read_clipboard(&[], None).unwrap();
        let image = read.entries.iter().find(|entry| entry.content.as_ref().is_some_and(|content| content.has_image)).expect("the image is in history");
        let bytes = item_image(&image.id).unwrap();
        println!("image: {} bytes, starts {:02X?}", bytes.len(), &bytes[..bytes.len().min(8)]);
        assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']) || bytes.starts_with(b"BM"), "the webview can show it");

        let keep_out = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.DataObject; $d.SetText('private'); $d.SetData('CanIncludeInClipboardHistory', (New-Object System.IO.MemoryStream (,[byte[]](VALUE,0,0,0)))); [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)";
        assert!(powershell(&keep_out.replace("VALUE", "0")).status.success());
        std::thread::sleep(Duration::from_millis(900));
        assert!(read_clipboard(&[], None).unwrap().current.unwrap().kept_out_of_history);
        assert!(powershell(&keep_out.replace("VALUE", "1")).status.success());
        std::thread::sleep(Duration::from_millis(900));
        assert!(!read_clipboard(&[], None).unwrap().current.unwrap().kept_out_of_history);

        let fake_ditto = std::env::temp_dir().join("ditto.exe");
        std::fs::copy(r"C:\Windows\System32\ping.exe", &fake_ditto).unwrap();
        let mut ditto = hidden(fake_ditto.to_str().unwrap()).args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let programs = read_status().unwrap().other_programs;
        assert!(programs.iter().any(|program| program.label == "Ditto" && program.process.pid == ditto.id()), "{programs:?}");
        ditto.kill().ok();

        let holder = hidden("powershell")
            .args(["-NoProfile", "-Sta", "-Command", "Add-Type -AssemblyName System.Windows.Forms; Add-Type -Name C -Namespace N -MemberDefinition '[DllImport(\"user32\")] public static extern bool OpenClipboard(IntPtr h);'; $f = New-Object System.Windows.Forms.Form; [void][N.C]::OpenClipboard($f.Handle); Start-Sleep 30"])
            .spawn();
        let mut holder = holder.unwrap();
        let started = Instant::now();
        let mut held = None;
        while held.is_none() && started.elapsed() < Duration::from_secs(20) {
            held = read_status().unwrap().held_by;
        }
        println!("held by {:?} after {:?}", held.as_ref().map(|process| &process.name), started.elapsed());
        assert_eq!(held.map(|process| process.pid), Some(holder.id()));
        let during = read_clipboard(&[], None).unwrap();
        println!("read while held: current is {}", if during.current.is_some() { "there" } else { "left out" });
        holder.kill().ok();
        std::thread::sleep(Duration::from_millis(500));

        Clipboard::Clear().unwrap();
        assert!(read_clipboard(&[], None).unwrap().current.unwrap().content.formats.is_empty());
        clear_history().unwrap();
        assert!(read_clipboard(&[], None).unwrap().entries.is_empty());

        copy_text("before off");
        set_history(false).unwrap();
        let off = read_clipboard(&[], None).unwrap();
        assert!(!off.history_on && off.entries.is_empty());
        assert!(off.current.unwrap().content.formats.is_empty(), "turning history off empties the clipboard");
        set_history(true).unwrap();
        assert!(entry_with(&read_clipboard(&[], None).unwrap(), "before off").is_some(), "saved items come back");

        let policy_key = r"HKLM:\SOFTWARE\Policies\Microsoft\Windows\System";
        assert!(powershell(&format!("New-ItemProperty '{policy_key}' -Name AllowClipboardHistory -Value 0 -PropertyType DWord -Force")).status.success());
        set_history(false).unwrap();
        assert_eq!(set_history(true).unwrap_err().kind, ErrorKind::Permission);
        let blocked = read_status().unwrap();
        assert!(blocked.blocked_by_policy && !blocked.block_is_managed && !blocked.history_on);
        remove_block().unwrap();
        let unblocked = read_status().unwrap();
        assert!(!unblocked.blocked_by_policy && unblocked.history_on);

        run_as_admin(RESTART_SERVICE_COMMAND).unwrap();
        std::thread::sleep(Duration::from_secs(2));
        assert!(read_clipboard(&[], None).unwrap().entries.is_empty(), "a restart loses saved items");
        println!("all of it worked");
    }
}
