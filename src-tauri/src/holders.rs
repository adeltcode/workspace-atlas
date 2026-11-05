use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::error::{AtlasError, ErrorKind};
use crate::shell::hidden;
use crate::wsl::{output_within, run_in_distro_as, shell_quote};

const WINDOWS_PROCESSES: &[&str] = &[
    "system", "registry", "memory compression", "secure system", "smss.exe", "csrss.exe",
    "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "lsaiso.exe", "svchost.exe",
    "dwm.exe", "fontdrvhost.exe", "sihost.exe", "explorer.exe", "spoolsv.exe",
    "searchindexer.exe", "msmpeng.exe", "ctfmon.exe", "taskhostw.exe", "runtimebroker.exe",
];
const DOCKER_PROCESSES: &[&str] = &["docker desktop.exe", "dockerd.exe", "vpnkit.exe"];
const WSL_PROCESSES: &[&str] = &[
    "wsl.exe", "wslhost.exe", "wslrelay.exe", "wslservice.exe", "vmmem", "vmmemwsl",
    "vmcompute.exe", "vmwp.exe",
];

const SCAN_TIME_LIMIT: Duration = Duration::from_secs(20);
/// Docker and each distro are asked on every refresh, so one that is stuck cannot hold up the list.
const SOURCE_TIME_LIMIT: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessOwner {
    App,
    /// Windows hides this program's path from us, which means closing it needs more rights than we have.
    Admin,
    Docker,
    Wsl,
    DistroSystem,
    Windows,
    ThisApp,
    Unknown,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
    /// Seconds since 1970. With the PID, this tells a program from a later one that reused the PID.
    pub started_at: u64,
    pub owner: ProcessOwner,
    /// Set when the program runs inside a WSL distro, where `pid` is the Linux PID.
    pub distro: Option<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Reachable {
    ThisPc,
    Network,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum PortSource {
    Windows,
    Docker,
    Wsl,
}

#[derive(Serialize, Clone, Default, Debug)]
pub struct PortDetails {
    /// The command line. For a container, its image.
    pub command: Option<String>,
    /// The working folder. For a container, its Compose project's folder.
    pub folder: Option<String>,
    pub memory_bytes: Option<u64>,
    /// The program that started this one.
    pub parent: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PortEntry {
    pub port: u16,
    pub addresses: Vec<String>,
    pub reachable: Reachable,
    /// Seconds since 1970. When Windows opened the socket; for Docker and WSL, when the container or
    /// program started, because they do not record the socket's own time.
    pub listening_since: Option<u64>,
    pub source: PortSource,
    pub details: PortDetails,
    pub process: ProcessInfo,
}

struct Listener {
    address: IpAddr,
    port: u16,
    since: Option<u64>,
    source: PortSource,
    details: PortDetails,
    process: ProcessInfo,
}

#[derive(Serialize, Clone, Debug)]
pub struct PortList {
    pub entries: Vec<PortEntry>,
    /// Docker or distros that did not answer, so their ports may be missing.
    pub unchecked: Vec<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum HoldReason {
    OpenFile,
    FolderOpen,
    LoadedFile,
    RunningFromHere,
}

#[derive(Serialize, Clone, Debug)]
pub struct LockHolder {
    pub process: ProcessInfo,
    pub reason: HoldReason,
    /// One thing it holds, when the path checked is a folder.
    pub example: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct LockReport {
    pub path: String,
    pub is_folder: bool,
    /// False when the check ran out of time.
    pub complete: bool,
    pub holders: Vec<LockHolder>,
}

fn owner_of(pid: u32, name: &str, has_path: bool) -> ProcessOwner {
    let name = name.to_lowercase();
    if pid == std::process::id() {
        ProcessOwner::ThisApp
    } else if pid <= 4 || WINDOWS_PROCESSES.contains(&name.as_str()) {
        ProcessOwner::Windows
    } else if name.starts_with("com.docker.") || DOCKER_PROCESSES.contains(&name.as_str()) {
        ProcessOwner::Docker
    } else if WSL_PROCESSES.contains(&name.as_str()) {
        ProcessOwner::Wsl
    } else if !has_path {
        ProcessOwner::Admin
    } else {
        ProcessOwner::App
    }
}

fn distro_owner(pid: u32, name: Option<&str>) -> ProcessOwner {
    match name {
        Some(name) if pid > 1 && !name.starts_with("systemd") && name != "init" => ProcessOwner::Wsl,
        _ => ProcessOwner::DistroSystem,
    }
}

fn process_snapshot() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    system
}

fn describe(system: &System, pid: u32) -> ProcessInfo {
    match system.process(Pid::from_u32(pid)) {
        Some(process) => {
            let name = process.name().to_string_lossy().to_string();
            ProcessInfo {
                pid,
                owner: owner_of(pid, &name, process.exe().is_some()),
                name,
                path: process.exe().map(|p| p.to_string_lossy().to_string()),
                started_at: process.start_time(),
                distro: None,
            }
        }
        None => ProcessInfo {
            pid,
            name: "Unknown program".to_string(),
            path: None,
            started_at: 0,
            owner: ProcessOwner::Unknown,
            distro: None,
        },
    }
}

#[cfg(windows)]
fn tcp_rows<Row: Copy>(family: u32) -> Result<Vec<Row>, AtlasError> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, TCP_TABLE_OWNER_MODULE_LISTENER};
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    let mut size = 0u32;
    // u64s, because these rows hold a 64-bit time, so they start 8 bytes in, after the u32 count.
    let mut buffer: Vec<u64> = vec![0];
    for _ in 0..5 {
        buffer.resize((size as usize).div_ceil(8).max(1), 0);
        let code = unsafe {
            GetExtendedTcpTable(buffer.as_mut_ptr().cast(), &mut size, 0, family, TCP_TABLE_OWNER_MODULE_LISTENER, 0)
        };
        match code {
            0 => {
                let count = unsafe { buffer.as_ptr().cast::<u32>().read() } as usize;
                let rows = unsafe { buffer.as_ptr().add(1).cast::<Row>() };
                return Ok(unsafe { std::slice::from_raw_parts(rows, count) }.to_vec());
            }
            ERROR_INSUFFICIENT_BUFFER => continue,
            code => return Err(format!("Windows could not list open ports (error {}).", code).into()),
        }
    }
    Err("Windows could not list open ports: the list kept changing.".into())
}

/// Windows file times count 100 ns steps from 1601. Zero means it did not record one.
fn filetime_seconds(filetime: i64) -> Option<u64> {
    const SECONDS_FROM_1601_TO_1970: u64 = 11_644_473_600;
    u64::try_from(filetime).ok()?.checked_div(10_000_000)?.checked_sub(SECONDS_FROM_1601_TO_1970)
}

/// (address, port, PID, when the socket opened)
#[cfg(windows)]
fn tcp_listeners() -> Result<Vec<(IpAddr, u16, u32, Option<u64>)>, AtlasError> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{MIB_TCP6ROW_OWNER_MODULE, MIB_TCPROW_OWNER_MODULE};
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    // Port numbers sit in the low 16 bits, in network byte order.
    let port = |raw: u32| u16::from_be(raw as u16);

    let mut listeners = Vec::new();
    for row in tcp_rows::<MIB_TCPROW_OWNER_MODULE>(AF_INET)? {
        let address = IpAddr::from(row.dwLocalAddr.to_ne_bytes());
        listeners.push((address, port(row.dwLocalPort), row.dwOwningPid, filetime_seconds(row.liCreateTimestamp)));
    }
    for row in tcp_rows::<MIB_TCP6ROW_OWNER_MODULE>(AF_INET6)? {
        listeners.push((IpAddr::from(row.ucLocalAddr), port(row.dwLocalPort), row.dwOwningPid, filetime_seconds(row.liCreateTimestamp)));
    }
    Ok(listeners)
}

#[cfg(not(windows))]
fn tcp_listeners() -> Result<Vec<(IpAddr, u16, u32, Option<u64>)>, AtlasError> {
    Err(AtlasError::invalid("Listing ports is only available on Windows."))
}

fn to_entries(listeners: Vec<Listener>) -> Vec<PortEntry> {
    let mut grouped: BTreeMap<(u16, u32, String), (Listener, Vec<IpAddr>)> = BTreeMap::new();
    for listener in listeners {
        let key = (listener.port, listener.process.pid, listener.process.name.clone());
        let (address, since) = (listener.address, listener.since);
        let (kept, addresses) = grouped.entry(key).or_insert_with(|| (listener, Vec::new()));
        if !addresses.contains(&address) {
            addresses.push(address);
        }
        kept.since = match (kept.since, since) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
    }
    grouped
        .into_values()
        .map(|(listener, addresses)| PortEntry {
            port: listener.port,
            reachable: if addresses.iter().all(|a| a.to_canonical().is_loopback()) { Reachable::ThisPc } else { Reachable::Network },
            addresses: addresses.iter().map(ToString::to_string).collect(),
            listening_since: listener.since,
            source: listener.source,
            details: listener.details,
            process: listener.process,
        })
        .collect()
}

/// With `*`, `[::]`, and zone suffixes such as `127.0.0.53%lo`, as Docker and `ss` print them.
fn parse_address(text: &str) -> Option<IpAddr> {
    let text = text.split('%').next()?.trim_matches(['[', ']']);
    if text == "*" {
        return Some(IpAddr::from([0, 0, 0, 0]));
    }
    text.parse().ok()
}

/// Host side of a `docker ps` Ports column: `0.0.0.0:8000-8001->80-81/tcp, 9000/tcp`.
fn parse_docker_ports(ports: &str) -> Vec<(IpAddr, u16)> {
    let mut found = Vec::new();
    for mapping in ports.split(',') {
        let Some((host, target)) = mapping.trim().split_once("->") else { continue };
        let Some((address, port)) = host.rsplit_once(':') else { continue };
        let Some(address) = parse_address(address) else { continue };
        if !target.ends_with("/tcp") {
            continue;
        }
        let (first, last) = port.split_once('-').unwrap_or((port, port));
        if let (Ok(first), Ok(last)) = (first.parse::<u16>(), last.parse::<u16>()) {
            found.extend((first..=last).map(|port| (address, port)));
        }
    }
    found
}

/// One `ss -ltnpH` line: `LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=3))`.
fn parse_ss_line(line: &str) -> Option<(IpAddr, u16, Option<String>, Option<u32>)> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let (address, port) = fields.get(3)?.rsplit_once(':')?;
    let users = fields.get(5).copied().unwrap_or("");
    let name = users.split('"').nth(1).map(str::to_string);
    let pid = users.split("pid=").nth(1).and_then(|rest| {
        rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
    });
    Some((parse_address(address)?, port.parse().ok()?, name, pid))
}

fn output_of(command: &mut std::process::Command) -> Option<Option<std::process::Output>> {
    use std::process::Stdio;
    let child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).spawn().ok()?;
    output_within(child, SOURCE_TIME_LIMIT).ok()
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Seconds since 1970 for a UTC time as Docker prints it: `2026-11-05T08:52:37.628493201Z`.
fn utc_seconds(text: &str) -> Option<u64> {
    let (date, time) = text.trim_end_matches('Z').split_once('T')?;
    let mut date = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date.next()??, date.next()??, date.next()??);
    let mut time = time.split('.').next()?.split(':').map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (time.next()??, time.next()??, time.next()??);
    // Days from 1970 by the civil calendar, counting years from March so leap days fall last.
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * m + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    u64::try_from(days * 86_400 + hour * 3600 + minute * 60 + second).ok()
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `Err` means Docker did not answer in time. A missing or stopped Docker simply has no ports.
fn docker_listeners() -> Result<Vec<Listener>, ()> {
    const COLUMNS: &str = "{{.Names}}\t{{.Ports}}\t{{.Image}}\t{{.Label \"com.docker.compose.project.working_dir\"}}";
    let Some(output) = output_of(hidden("docker").args(["ps", "--format", COLUMNS])) else {
        return Ok(Vec::new());
    };
    let output = output.ok_or(())?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let published: Vec<Vec<&str>> = text
        .lines()
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .filter(|fields| fields.len() >= 2 && !parse_docker_ports(fields[1]).is_empty())
        .collect();
    if published.is_empty() {
        return Ok(Vec::new());
    }

    let mut inspect = hidden("docker");
    inspect.args(["inspect", "--format", "{{.Name}}\t{{.State.StartedAt}}"]);
    inspect.args(published.iter().map(|fields| fields[0]));
    let started: BTreeMap<String, u64> = output_of(&mut inspect)
        .flatten()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (name, time) = line.split_once('\t')?;
            Some((name.trim_start_matches('/').to_string(), utc_seconds(time)?))
        })
        .collect();

    let mut listeners = Vec::new();
    for fields in &published {
        let process = ProcessInfo {
            pid: 0,
            name: fields[0].to_string(),
            path: None,
            started_at: 0,
            owner: ProcessOwner::Docker,
            distro: None,
        };
        let details = PortDetails {
            command: fields.get(2).and_then(|t| non_empty(t)),
            folder: fields.get(3).and_then(|t| non_empty(t)),
            ..PortDetails::default()
        };
        for (address, port) in parse_docker_ports(fields[1]) {
            listeners.push(Listener {
                address,
                port,
                since: started.get(fields[0]).copied(),
                source: PortSource::Docker,
                details: details.clone(),
                process: process.clone(),
            });
        }
    }
    Ok(listeners)
}

fn running_distros() -> Result<Vec<String>, ()> {
    let Some(output) = output_of(hidden("wsl").env("WSL_UTF8", "1").args(["-l", "--running", "-q"])) else {
        return Ok(Vec::new());
    };
    let output = output.ok_or(())?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Listeners, then a line for each listening program: PID, seconds running, memory in KiB, parent's
/// name, working folder, command line.
const DISTRO_PORTS_SCRIPT: &str = r#"ss -ltnpH || exit 1
echo ---
for p in $(ss -ltnpH | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  set -- $(ps -o etimes=,rss=,ppid= -p "$p" 2>/dev/null)
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$1" "$2" "$(ps -o comm= -p "$3" 2>/dev/null)" "$(readlink "/proc/$p/cwd" 2>/dev/null)" "$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)"
done
true"#;

/// One program line of `DISTRO_PORTS_SCRIPT`: (PID, seconds running, details).
fn parse_distro_program(line: &str) -> Option<(u32, Option<u64>, PortDetails)> {
    let fields: Vec<&str> = line.split('\t').collect();
    let pid = fields.first()?.parse().ok()?;
    let details = PortDetails {
        memory_bytes: fields.get(2).and_then(|kib| kib.trim().parse::<u64>().ok()).map(|kib| kib * 1024),
        parent: fields.get(3).and_then(|t| non_empty(t)),
        folder: fields.get(4).and_then(|t| non_empty(t)),
        command: fields.get(5).and_then(|t| non_empty(t)),
    };
    Some((pid, fields.get(1).and_then(|s| s.trim().parse().ok()), details))
}

fn parse_distro_ports(distro: &str, output: &str, now: u64) -> Vec<Listener> {
    let (listeners, programs) = output.split_once("---\n").unwrap_or((output, ""));
    let programs: BTreeMap<u32, (Option<u64>, PortDetails)> = programs
        .lines()
        .filter_map(parse_distro_program)
        .map(|(pid, running, details)| (pid, (running, details)))
        .collect();
    listeners
        .lines()
        .filter_map(parse_ss_line)
        .map(|(address, port, name, pid)| {
            let pid = pid.unwrap_or(0);
            let (running, details) = programs.get(&pid).cloned().unwrap_or_default();
            Listener {
                address,
                port,
                since: running.and_then(|seconds| now.checked_sub(seconds)),
                source: PortSource::Wsl,
                details,
                process: ProcessInfo {
                    pid,
                    owner: distro_owner(pid, name.as_deref()),
                    name: name.unwrap_or_else(|| "System service".to_string()),
                    path: None,
                    started_at: 0,
                    distro: Some(distro.to_string()),
                },
            }
        })
        .collect()
}

fn distro_listeners(distro: &str) -> Result<Vec<Listener>, AtlasError> {
    let output = run_in_distro_as(distro, Some("root"), DISTRO_PORTS_SCRIPT, Some(SOURCE_TIME_LIMIT))?;
    Ok(parse_distro_ports(distro, &output, now_seconds()))
}

fn windows_details(system: &System, pid: u32) -> PortDetails {
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return PortDetails::default();
    };
    let command = process.cmd().iter().map(|part| part.to_string_lossy()).collect::<Vec<_>>().join(" ");
    PortDetails {
        command: non_empty(&command),
        folder: process.cwd().map(|folder| folder.to_string_lossy().to_string()),
        memory_bytes: Some(process.memory()).filter(|bytes| *bytes > 0),
        parent: process.parent().and_then(|id| system.process(id)).map(|parent| parent.name().to_string_lossy().to_string()),
    }
}

/// Each source wins over the one after it for the same port. Docker's published ports also show up
/// in a distro as nameless listeners, and on Windows as Docker or WSL relay programs.
fn merge_ports(docker: Vec<PortEntry>, distros: Vec<PortEntry>, windows: Vec<PortEntry>) -> Vec<PortEntry> {
    let has = |list: &[PortEntry], port: u16| list.iter().any(|e| e.port == port);
    let distros: Vec<PortEntry> = distros.into_iter().filter(|e| !has(&docker, e.port)).collect();
    let windows: Vec<PortEntry> = windows
        .into_iter()
        .filter(|e| {
            !matches!(e.process.owner, ProcessOwner::Docker | ProcessOwner::Wsl) || !(has(&docker, e.port) || has(&distros, e.port))
        })
        .collect();
    let mut merged: Vec<PortEntry> = docker.into_iter().chain(distros).chain(windows).collect();
    merged.sort_by_key(|e| (e.port, e.process.pid));
    merged
}

fn list_ports() -> Result<PortList, AtlasError> {
    let found = tcp_listeners()?;
    let mut system = process_snapshot();
    // Reading these takes a look inside each program, so only the ones holding a port are read.
    let pids: Vec<Pid> = found.iter().map(|(_, _, pid, _)| Pid::from_u32(*pid)).collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet),
    );
    let windows = to_entries(
        found
            .into_iter()
            .map(|(address, port, pid, since)| {
                let process = describe(&system, pid);
                Listener {
                    address,
                    port,
                    since: since.or(Some(process.started_at).filter(|t| *t > 0)),
                    source: PortSource::Windows,
                    details: windows_details(&system, pid),
                    process,
                }
            })
            .collect(),
    );

    let mut unchecked = Vec::new();
    let docker = docker_listeners().unwrap_or_else(|_| {
        unchecked.push("Docker".to_string());
        Vec::new()
    });
    let running = running_distros().unwrap_or_else(|_| {
        unchecked.push("WSL".to_string());
        Vec::new()
    });
    let mut in_distros = Vec::new();
    // Docker Desktop's own distros hold its internal ports, which are not the user's.
    for distro in running.iter().filter(|d| !d.starts_with("docker-desktop")) {
        match distro_listeners(distro) {
            Ok(listeners) => in_distros.extend(listeners),
            Err(_) => unchecked.push(distro.clone()),
        }
    }

    Ok(PortList {
        entries: merge_ports(to_entries(docker), to_entries(in_distros), windows),
        unchecked,
    })
}

/// Pasted paths often keep the quotes that "Copy as path" adds.
fn clean_path(raw: &str) -> &str {
    raw.trim().trim_matches('"').trim()
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    text.strip_prefix(r"\\?\").unwrap_or(&text).trim_end_matches('\\').to_lowercase()
}

fn is_inside(candidate: &Path, folder: &Path) -> bool {
    let (candidate, folder) = (path_key(candidate), path_key(folder));
    candidate == folder || candidate.starts_with(&format!("{}\\", folder))
}

/// Which programs have exactly this file or folder open, leaving out this app. This sees programs
/// running as administrator too, but one call costs about 100 ms, which rules it out for every file in
/// a tree. A program's working folder counts as an open folder.
#[cfg(windows)]
fn programs_using(path: &Path) -> std::io::Result<Vec<u32>> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Wdk::Storage::FileSystem::{FileProcessIdsUsingFileInformation, NtQueryInformationFile};
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_SHARE_ALL: u32 = 7;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000; // Required to open a folder.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;

    // A count padded to pointer size, then that many pointer-sized PIDs.
    let mut buffer = vec![0usize; 64];
    loop {
        let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        let status = unsafe {
            NtQueryInformationFile(
                file.as_raw_handle(),
                &mut status_block,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(buffer.as_slice()) as u32,
                FileProcessIdsUsingFileInformation,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH && buffer.len() < 1 << 16 {
            buffer.resize(buffer.len() * 4, 0);
        } else if status < 0 {
            return Err(std::io::Error::other(format!("Windows could not check this path (status {:#x}).", status)));
        } else {
            let count = buffer[0] as u32 as usize;
            return Ok(buffer.iter().skip(1).take(count).map(|pid| *pid as u32).filter(|pid| *pid != std::process::id()).collect());
        }
    }
}

#[cfg(not(windows))]
fn programs_using(_path: &Path) -> std::io::Result<Vec<u32>> {
    Err(std::io::Error::other("Finding file locks is only available on Windows."))
}

#[cfg(windows)]
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004u32 as i32;

/// One row of `SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX`, which Windows does not publish a type for.
#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
struct HandleEntry {
    object: usize,
    pid: usize,
    handle: usize,
    access: u32,
    backtrace_index: u16,
    object_type: u16,
    attributes: u32,
    reserved: u32,
}

#[cfg(windows)]
fn system_handles() -> std::io::Result<Vec<HandleEntry>> {
    use windows_sys::Wdk::System::SystemInformation::NtQuerySystemInformation;
    const SYSTEM_EXTENDED_HANDLE_INFORMATION: i32 = 64;
    const HEADER_WORDS: usize = 2; // The count and a reserved word.

    let mut buffer = vec![0usize; 1 << 16];
    loop {
        let bytes = std::mem::size_of_val(buffer.as_slice());
        let mut needed = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(SYSTEM_EXTENDED_HANDLE_INFORMATION, buffer.as_mut_ptr().cast(), bytes as u32, &mut needed)
        };
        if status == STATUS_INFO_LENGTH_MISMATCH && buffer.len() < 1 << 26 {
            buffer.resize(buffer.len() * 2, 0);
        } else if status < 0 {
            return Err(std::io::Error::other(format!("Windows could not list open files (status {:#x}).", status)));
        } else {
            let room = (bytes - HEADER_WORDS * std::mem::size_of::<usize>()) / std::mem::size_of::<HandleEntry>();
            let entries = unsafe { buffer.as_ptr().add(HEADER_WORDS).cast::<HandleEntry>() };
            return Ok(unsafe { std::slice::from_raw_parts(entries, buffer[0].min(room)) }.to_vec());
        }
    }
}

#[cfg(windows)]
fn open_process(pid: u32, access: u32) -> Option<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::System::Threading::OpenProcess;
    let handle = unsafe { OpenProcess(access, 0, pid) };
    (!handle.is_null()).then(|| unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) })
}

/// Pipes and devices are skipped first, because asking for a pipe's name can hang.
#[cfg(windows)]
fn disk_file_path(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::{GetFileType, GetFinalPathNameByHandleW, FILE_TYPE_DISK};
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return None;
    }
    let mut name = [0u16; 1024];
    let length = unsafe { GetFinalPathNameByHandleW(handle, name.as_mut_ptr(), name.len() as u32, 0) } as usize;
    (length > 0 && length < name.len()).then(|| PathBuf::from(String::from_utf16_lossy(&name[..length])))
}

/// Every file handle on the PC is checked once, so the size of the folder does not matter. Programs
/// running as administrator cannot be read this way.
#[cfg(windows)]
fn open_files_inside(root: &Path) -> std::io::Result<BTreeMap<u32, PathBuf>> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, PROCESS_DUP_HANDLE};

    // Handle type numbers vary between Windows versions, so read the one a file of ours has.
    let probe = std::fs::File::open(std::env::current_exe()?)?;
    let own_pid = std::process::id() as usize;
    let entries = system_handles()?;
    let file_type = entries
        .iter()
        .find(|e| e.pid == own_pid && e.handle == probe.as_raw_handle() as usize)
        .map(|e| e.object_type)
        .ok_or_else(|| std::io::Error::other("Windows did not list this app's own file."))?;

    let mut processes: BTreeMap<u32, Option<OwnedHandle>> = BTreeMap::new();
    let mut found = BTreeMap::new();
    for entry in entries.iter().filter(|e| e.object_type == file_type && e.pid != own_pid && e.pid > 4) {
        let pid = entry.pid as u32;
        if found.contains_key(&pid) {
            continue;
        }
        let Some(process) = processes.entry(pid).or_insert_with(|| open_process(pid, PROCESS_DUP_HANDLE)) else {
            continue;
        };
        let mut copy = std::ptr::null_mut();
        let copied = unsafe {
            DuplicateHandle(process.as_raw_handle(), entry.handle as _, GetCurrentProcess(), &mut copy, 0, 0, DUPLICATE_SAME_ACCESS)
        };
        if copied == 0 {
            continue;
        }
        let copy = unsafe { OwnedHandle::from_raw_handle(copy) };
        if let Some(path) = disk_file_path(copy.as_raw_handle()).filter(|path| is_inside(path, root)) {
            found.insert(pid, path);
        }
    }
    Ok(found)
}

/// A loaded DLL or native addon stays locked with no file handle open, such as a `.node` file.
#[cfg(windows)]
fn modules_inside(root: &Path, pids: impl Iterator<Item = u32>) -> BTreeMap<u32, PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HMODULE;
    use windows_sys::Win32::System::ProcessStatus::{EnumProcessModulesEx, GetModuleFileNameExW, LIST_MODULES_ALL};
    use windows_sys::Win32::System::Threading::{PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

    let mut found = BTreeMap::new();
    for pid in pids.filter(|pid| *pid != std::process::id()) {
        let Some(process) = open_process(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ) else {
            continue;
        };
        let mut modules: Vec<HMODULE> = vec![std::ptr::null_mut(); 2048];
        let mut needed = 0u32;
        let listed = unsafe {
            EnumProcessModulesEx(
                process.as_raw_handle(),
                modules.as_mut_ptr(),
                std::mem::size_of_val(modules.as_slice()) as u32,
                &mut needed,
                LIST_MODULES_ALL,
            )
        };
        if listed == 0 {
            continue;
        }
        modules.truncate(needed as usize / std::mem::size_of::<HMODULE>());
        let mut name = [0u16; 1024];
        for module in modules {
            let length = unsafe { GetModuleFileNameExW(process.as_raw_handle(), module, name.as_mut_ptr(), name.len() as u32) } as usize;
            let path = PathBuf::from(std::ffi::OsString::from_wide(&name[..length]));
            if length > 0 && is_inside(&path, root) {
                found.insert(pid, path);
                break;
            }
        }
    }
    found
}

fn find_locks(raw_path: &str, time_limit: Duration) -> Result<LockReport, AtlasError> {
    let cleaned = clean_path(raw_path);
    if cleaned.is_empty() {
        return Err(AtlasError::invalid("Enter a file or folder to check."));
    }
    let root = PathBuf::from(cleaned);
    let is_folder = std::fs::symlink_metadata(&root)
        .map_err(|_| {
            AtlasError::new(ErrorKind::NotFound, format!("Nothing exists at {}.", cleaned))
                .hint("Check the path, or pick the file or folder with Browse.")
        })?
        .is_dir();
    // Windows reports real paths, so a path through a junction has to be compared by where it leads.
    let target = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());

    let exact_reason = if is_folder { HoldReason::FolderOpen } else { HoldReason::OpenFile };
    let mut found: BTreeMap<u32, (HoldReason, Option<PathBuf>)> = programs_using(&root)?
        .into_iter()
        .map(|pid| (pid, (exact_reason, None)))
        .collect();

    let system = process_snapshot();

    // On its own thread: an open file's name can take long to read, and the page must not wait for it.
    #[cfg(windows)]
    let complete = {
        let (send, receive) = std::sync::mpsc::channel();
        let worker_target = target.clone();
        let pids: Vec<u32> = system.processes().keys().map(|pid| pid.as_u32()).collect();
        std::thread::spawn(move || {
            let files = open_files_inside(&worker_target);
            let modules = modules_inside(&worker_target, pids.into_iter());
            send.send((files, modules)).ok();
        });
        match receive.recv_timeout(time_limit) {
            Ok((files, modules)) => {
                for (pid, path) in files.map_err(|e| e.to_string())? {
                    let reason = if path.is_dir() { HoldReason::FolderOpen } else { HoldReason::OpenFile };
                    found.insert(pid, (reason, Some(path)));
                }
                for (pid, path) in modules {
                    found.entry(pid).or_insert((HoldReason::LoadedFile, Some(path)));
                }
                true
            }
            Err(_) => false,
        }
    };
    #[cfg(not(windows))]
    let complete = { let _ = (&target, time_limit); false };

    for (pid, process) in system.processes() {
        if pid.as_u32() != std::process::id() && process.exe().is_some_and(|exe| is_inside(exe, &target)) {
            found.insert(pid.as_u32(), (HoldReason::RunningFromHere, process.exe().map(Path::to_path_buf)));
        }
    }

    Ok(LockReport {
        path: cleaned.to_string(),
        is_folder,
        complete,
        holders: found
            .into_iter()
            .map(|(pid, (reason, held))| LockHolder {
                process: describe(&system, pid),
                reason,
                example: held.filter(|_| is_folder).map(|path| {
                    let text = path.to_string_lossy().to_string();
                    text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text)
                }),
            })
            .collect(),
    })
}

/// The webview's word is not enough: this checks the live process again right before closing it.
fn check_can_close(info: &ProcessInfo, expected_started_at: u64) -> Result<(), AtlasError> {
    if info.owner == ProcessOwner::Unknown {
        return Err(AtlasError::new(ErrorKind::NotFound, "That program has already closed.").hint("Refresh to see the current list."));
    }
    if info.started_at != expected_started_at {
        return Err(AtlasError::invalid(format!("PID {} now belongs to a different program, so nothing was closed.", info.pid))
            .hint("Refresh to see the current list."));
    }
    match info.owner {
        ProcessOwner::App => Ok(()),
        ProcessOwner::Admin => Err(AtlasError::invalid(format!("{} needs administrator rights to close.", info.name))
            .hint(format!("Run `taskkill /PID {} /F` in an administrator terminal.", info.pid))),
        ProcessOwner::DistroSystem => Err(AtlasError::invalid(format!("{} is part of the distro, so Workspace Atlas will not close it.", info.name))),
        ProcessOwner::Docker => Err(AtlasError::invalid(format!("{} belongs to Docker. Stop the container or Docker Desktop instead.", info.name))),
        ProcessOwner::Wsl => Err(AtlasError::invalid(format!("{} belongs to WSL. Stop the distro instead.", info.name))),
        ProcessOwner::Windows => Err(AtlasError::invalid(format!("{} is part of Windows, so Workspace Atlas will not close it.", info.name))),
        ProcessOwner::ThisApp => Err(AtlasError::invalid("Workspace Atlas cannot close itself.")),
        ProcessOwner::Unknown => unreachable!("handled above"),
    }
}

fn close_process(pid: u32, started_at: u64) -> Result<(), AtlasError> {
    let info = describe(&process_snapshot(), pid);
    check_can_close(&info, started_at)?;
    let output = hidden("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output()
        .map_err(|e| format!("Failed to run taskkill: {}", e))?;
    if output.status.success() {
        return Ok(());
    }
    Err(AtlasError::new(ErrorKind::Permission, format!("Windows would not close {}.", info.name))
        .hint(format!("It may be running as administrator. Close it yourself, or run `taskkill /PID {} /F` in an administrator terminal.", pid))
        .detail(String::from_utf8_lossy(&output.stderr)))
}

/// Asks the program inside the distro to stop, only if that PID is still the program the user saw.
fn close_in_distro(distro: &str, pid: u32, name: &str) -> Result<(), AtlasError> {
    if distro_owner(pid, Some(name)) != ProcessOwner::Wsl {
        return Err(AtlasError::invalid(format!("{} is part of the distro, so Workspace Atlas will not close it.", name)));
    }
    if !running_distros().unwrap_or_default().iter().any(|d| d == distro) {
        return Err(AtlasError::new(ErrorKind::NotFound, format!("{} is not running.", distro)).hint("Refresh to see the current list."));
    }
    let script = format!(
        "[ \"$(cat /proc/{pid}/comm 2>/dev/null)\" = {name} ] || {{ echo missing; exit 0; }}\nkill {pid} && echo closed",
        pid = pid,
        name = shell_quote(name),
    );
    let output = run_in_distro_as(distro, Some("root"), &script, Some(SOURCE_TIME_LIMIT))?;
    if output.trim() == "closed" {
        Ok(())
    } else {
        Err(AtlasError::new(ErrorKind::NotFound, "That program has already closed.").hint("Refresh to see the current list."))
    }
}

/// TCP ports with a program listening on them, on Windows, in Docker, and in running distros.
#[tauri::command]
pub async fn ports_list(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
) -> Result<PortList, AtlasError> {
    migration.inner().clone().run_operation(list_ports).await
}

/// Which programs hold a file, or anything inside a folder.
#[tauri::command]
pub async fn locks_find(path: String) -> Result<LockReport, AtlasError> {
    tauri::async_runtime::spawn_blocking(move || find_locks(&path, SCAN_TIME_LIMIT))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn process_close(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    pid: u32,
    started_at: u64,
    name: String,
    distro: Option<String>,
) -> Result<(), AtlasError> {
    migration.inner().clone().run_operation(move || match distro {
        Some(distro) => close_in_distro(&distro, pid, &name),
        None => close_process(pid, started_at),
    }).await
}

#[tauri::command]
pub async fn pick_any_file() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new().pick_file().and_then(|p| p.to_str().map(|s| s.to_string()))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(owner: ProcessOwner, started_at: u64) -> ProcessInfo {
        ProcessInfo { pid: 1234, name: "node.exe".to_string(), path: None, started_at, owner, distro: None }
    }

    fn entry(port: u16, owner: ProcessOwner, pid: u32) -> PortEntry {
        PortEntry {
            port,
            addresses: vec!["0.0.0.0".to_string()],
            reachable: Reachable::Network,
            listening_since: None,
            source: PortSource::Windows,
            details: PortDetails::default(),
            process: ProcessInfo { pid, ..process(owner, 1) },
        }
    }

    fn listener(address: IpAddr, port: u16, since: Option<u64>) -> Listener {
        Listener {
            address,
            port,
            since,
            source: PortSource::Windows,
            details: PortDetails::default(),
            process: process(ProcessOwner::App, 1),
        }
    }

    fn temp_folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("atlas-holders-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn owner_keeps_windows_docker_and_wsl_programs_apart_from_ordinary_ones() {
        assert_eq!(owner_of(5000, "node.exe", true), ProcessOwner::App);
        assert_eq!(owner_of(5000, "Code.exe", true), ProcessOwner::App);
        assert_eq!(owner_of(5000, "powershell.exe", true), ProcessOwner::App);
        assert_eq!(owner_of(5000, "vmware-authd.exe", false), ProcessOwner::Admin);
        assert_eq!(owner_of(4, "System", false), ProcessOwner::Windows);
        assert_eq!(owner_of(0, "anything", true), ProcessOwner::Windows);
        assert_eq!(owner_of(5000, "svchost.exe", false), ProcessOwner::Windows);
        assert_eq!(owner_of(5000, "EXPLORER.EXE", true), ProcessOwner::Windows);
        assert_eq!(owner_of(5000, "com.docker.backend.exe", true), ProcessOwner::Docker);
        assert_eq!(owner_of(5000, "Docker Desktop.exe", false), ProcessOwner::Docker);
        assert_eq!(owner_of(5000, "wslrelay.exe", true), ProcessOwner::Wsl);
        assert_eq!(owner_of(std::process::id(), "workspace-atlas.exe", true), ProcessOwner::ThisApp);
    }

    #[test]
    fn distro_programs_can_be_closed_but_its_own_services_cannot() {
        assert_eq!(distro_owner(4242, Some("node")), ProcessOwner::Wsl);
        assert_eq!(distro_owner(1, Some("node")), ProcessOwner::DistroSystem);
        assert_eq!(distro_owner(300, Some("systemd-resolve")), ProcessOwner::DistroSystem);
        assert_eq!(distro_owner(300, Some("init")), ProcessOwner::DistroSystem);
        assert_eq!(distro_owner(0, None), ProcessOwner::DistroSystem);
        assert_eq!(close_in_distro("any", 300, "systemd-resolve").unwrap_err().kind, ErrorKind::Invalid);
    }

    #[test]
    fn docker_ports_read_published_ports_only() {
        let v4 = IpAddr::from([0, 0, 0, 0]);
        let local = IpAddr::from([127, 0, 0, 1]);
        let any6: IpAddr = "::".parse().unwrap();
        assert_eq!(parse_docker_ports("9000/tcp"), vec![]);
        assert_eq!(parse_docker_ports("0.0.0.0:80->80/tcp, [::]:80->80/tcp"), vec![(v4, 80), (any6, 80)]);
        assert_eq!(parse_docker_ports("127.0.0.1:18081->80/tcp"), vec![(local, 18081)]);
        assert_eq!(parse_docker_ports("0.0.0.0:8000-8001->80-81/tcp"), vec![(v4, 8000), (v4, 8001)]);
        assert_eq!(parse_docker_ports("0.0.0.0:53->53/udp"), vec![]);
    }

    #[test]
    fn ss_lines_read_address_port_program_and_pid() {
        let any = IpAddr::from([0, 0, 0, 0]);
        assert_eq!(
            parse_ss_line(r#"LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=3),("node",pid=13,fd=3))"#),
            Some((IpAddr::from([127, 0, 0, 1]), 3000, Some("node".to_string()), Some(12))),
        );
        assert_eq!(parse_ss_line("LISTEN 0 4096 *:8081 *:*"), Some((any, 8081, None, None)));
        assert_eq!(
            parse_ss_line(r#"LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=9,fd=1))"#).map(|p| (p.0, p.1)),
            Some((IpAddr::from([127, 0, 0, 53]), 53)),
        );
        assert_eq!(parse_ss_line(r#"LISTEN 0 5 [::1]:631 [::]:*"#).map(|p| p.1), Some(631));
        assert_eq!(parse_ss_line("not a listener"), None);
    }

    #[test]
    fn a_port_shows_its_real_holder_not_the_relay_in_front_of_it() {
        let merged = merge_ports(
            vec![entry(8081, ProcessOwner::Docker, 0)],
            vec![entry(8081, ProcessOwner::DistroSystem, 0), entry(3000, ProcessOwner::Wsl, 42)],
            vec![
                entry(8081, ProcessOwner::Docker, 900),
                entry(3000, ProcessOwner::Wsl, 901),
                entry(5173, ProcessOwner::App, 902),
                entry(3000, ProcessOwner::App, 903),
            ],
        );
        let summary: Vec<(u16, u32)> = merged.iter().map(|e| (e.port, e.process.pid)).collect();
        assert_eq!(summary, vec![(3000, 42), (3000, 903), (5173, 902), (8081, 0)]);
    }

    #[test]
    fn only_an_ordinary_program_with_the_same_start_time_can_be_closed() {
        assert!(check_can_close(&process(ProcessOwner::App, 100), 100).is_ok());
        assert_eq!(check_can_close(&process(ProcessOwner::App, 100), 99).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(check_can_close(&process(ProcessOwner::Unknown, 0), 100).unwrap_err().kind, ErrorKind::NotFound);
        for owner in [ProcessOwner::Docker, ProcessOwner::Wsl, ProcessOwner::Windows, ProcessOwner::ThisApp] {
            assert_eq!(check_can_close(&process(owner, 100), 100).unwrap_err().kind, ErrorKind::Invalid);
        }
    }

    #[test]
    fn paths_compare_by_folder_not_by_text() {
        assert!(is_inside(Path::new(r"C:\Dev\App\src\a.js"), Path::new(r"c:\dev\app")));
        assert!(is_inside(Path::new(r"C:\Dev\App"), Path::new(r"C:\Dev\App\")));
        assert!(is_inside(Path::new("C:/Dev/App/a.js"), Path::new(r"C:\Dev\App")));
        assert!(!is_inside(Path::new(r"C:\Dev\App2\a.js"), Path::new(r"C:\Dev\App")));
        assert!(is_inside(Path::new(r"\\?\C:\Dev\App\a.js"), Path::new(r"C:\Dev\App")));
        assert_eq!(clean_path("  \"C:\\Dev\\App\" "), r"C:\Dev\App");
    }

    #[test]
    fn listeners_group_by_port_and_program_without_repeating_addresses() {
        let any4: IpAddr = "0.0.0.0".parse().unwrap();
        let any6: IpAddr = "::".parse().unwrap();
        let local: IpAddr = "127.0.0.1".parse().unwrap();
        let mapped: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        let entries = to_entries(vec![
            listener(any6, 3000, Some(200)),
            listener(any4, 3000, Some(100)),
            listener(any4, 3000, None),
            listener(local, 80, None),
            listener(mapped, 80, None),
        ]);
        assert_eq!(entries.iter().map(|e| e.port).collect::<Vec<_>>(), vec![80, 3000]);
        assert_eq!(entries[1].addresses, vec!["::".to_string(), "0.0.0.0".to_string()]);
        assert_eq!(entries[0].reachable, Reachable::ThisPc);
        assert_eq!(entries[1].reachable, Reachable::Network);
        assert_eq!(entries[1].listening_since, Some(100), "the earliest time of its addresses");
        assert_eq!(entries[0].listening_since, None);
    }

    #[test]
    fn times_convert_from_windows_and_docker_formats() {
        // 2026-11-05 08:52:37 UTC
        assert_eq!(utc_seconds("2026-11-05T08:52:37.628493201Z"), Some(1_793_868_757));
        assert_eq!(utc_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(utc_seconds("2024-03-01T00:00:00Z"), Some(1_709_251_200), "after a leap day");
        assert_eq!(utc_seconds("0001-01-01T00:00:00Z"), None, "Docker's value for never started");
        assert_eq!(utc_seconds("nonsense"), None);
        assert_eq!(filetime_seconds(116_444_736_000_000_000), Some(0));
        assert_eq!(filetime_seconds(116_444_736_000_000_000 + 50_000_000), Some(5));
        assert_eq!(filetime_seconds(0), None);
    }

    #[test]
    fn distro_output_joins_each_listener_to_its_program() {
        let output = "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=12,fd=3))\n\
                      LISTEN 0 4096 *:8081 *:*\n\
                      ---\n\
                      12\t60\t2048\tbash\t/home/me/app\tnode server.js --port 3000 \n";
        let listeners = parse_distro_ports("kali", output, 1000);
        assert_eq!(listeners.len(), 2);
        let node = &listeners[0];
        assert_eq!((node.port, node.process.pid), (3000, 12));
        assert_eq!(node.process.distro.as_deref(), Some("kali"));
        assert_eq!(node.since, Some(940));
        assert_eq!(node.source, PortSource::Wsl);
        assert_eq!(node.details.command.as_deref(), Some("node server.js --port 3000"));
        assert_eq!(node.details.folder.as_deref(), Some("/home/me/app"));
        assert_eq!(node.details.parent.as_deref(), Some("bash"));
        assert_eq!(node.details.memory_bytes, Some(2_097_152));
        assert_eq!(listeners[1].process.owner, ProcessOwner::DistroSystem);
        assert_eq!(listeners[1].since, None);
    }

    #[test]
    fn a_check_that_runs_out_of_time_says_so() {
        let folder = temp_folder("late");
        let report = find_locks(folder.to_str().unwrap(), Duration::ZERO).unwrap();
        assert!(!report.complete);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_missing_path_says_so() {
        let error = find_locks(r"C:\no\such\folder\for\this\test", SCAN_TIME_LIMIT).unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert_eq!(find_locks("  \"\" ", SCAN_TIME_LIMIT).unwrap_err().kind, ErrorKind::Invalid);
    }

    #[cfg(windows)]
    #[test]
    fn a_real_listener_shows_up_with_its_port_and_program() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let ports = list_ports().unwrap();
        let entry = ports.entries.iter().find(|e| e.port == port).expect("the port is listed");
        assert_eq!(entry.source, PortSource::Windows);
        let age = now_seconds().abs_diff(entry.listening_since.expect("Windows records when it opened"));
        assert!(age < 60, "opened {age} seconds from now");
        assert!(entry.details.memory_bytes.is_some());
        assert!(entry.details.command.is_some());
        assert!(entry.details.folder.is_some());
        assert!(entry.details.parent.is_some());
        assert_eq!(entry.process.pid, std::process::id());
        assert_eq!(entry.process.owner, ProcessOwner::ThisApp);
        assert_eq!(entry.reachable, Reachable::ThisPc);
        assert_eq!(entry.addresses, vec!["127.0.0.1".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn a_held_file_reports_its_holder_alone_and_inside_its_folder() {
        use std::os::windows::fs::OpenOptionsExt;
        let folder = temp_folder("locked");
        let file = folder.join("held.txt");
        std::fs::write(&file, "x").unwrap();
        std::fs::write(folder.join("free.txt"), "x").unwrap();

        let own = std::fs::File::open(&file).unwrap();
        let unheld = find_locks(file.to_str().unwrap(), SCAN_TIME_LIMIT).unwrap();
        assert!(unheld.complete);
        assert!(unheld.holders.is_empty(), "this app's own handles do not count");
        drop(own);

        let script = format!("$f = [IO.File]::Open('{}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 30", file.display());
        let mut child = hidden("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .spawn()
            .unwrap();
        let held = || std::fs::OpenOptions::new().read(true).share_mode(0).open(&file).is_err();
        let waited = std::time::Instant::now();
        while !held() && waited.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(held(), "the helper took the file");

        let single = find_locks(file.to_str().unwrap(), SCAN_TIME_LIMIT).unwrap();
        assert!(!single.is_folder);
        let holder = single.holders.iter().find(|h| h.process.pid == child.id()).expect("holder found");
        assert_eq!(holder.reason, HoldReason::OpenFile);
        assert_eq!(holder.process.name.to_lowercase(), "powershell.exe");

        let whole = find_locks(folder.to_str().unwrap(), SCAN_TIME_LIMIT).unwrap();
        assert!(whole.is_folder && whole.complete);
        let holder = whole.holders.iter().find(|h| h.process.pid == child.id()).expect("holder found");
        assert_eq!(holder.reason, HoldReason::OpenFile);
        assert!(holder.example.as_deref().unwrap().to_lowercase().ends_with("held.txt"));

        child.kill().unwrap();
        child.wait().unwrap();
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_program_working_inside_a_folder_counts_as_holding_it() {
        let folder = temp_folder("working");
        let mut child = hidden("ping")
            .args(["-n", "30", "127.0.0.1"])
            .current_dir(&folder)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let report = find_locks(folder.to_str().unwrap(), SCAN_TIME_LIMIT).unwrap();
        let holder = report.holders.iter().find(|h| h.process.pid == child.id()).expect("holder found");
        assert_eq!(holder.reason, HoldReason::FolderOpen);
        child.kill().unwrap();
        child.wait().unwrap();
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn closing_checks_the_start_time_then_ends_the_real_program() {
        let mut child = hidden("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let info = describe(&process_snapshot(), child.id());
        assert_eq!(info.owner, ProcessOwner::App);

        assert_eq!(close_process(child.id(), info.started_at + 1).unwrap_err().kind, ErrorKind::Invalid);
        assert!(child.try_wait().unwrap().is_none(), "a wrong start time closes nothing");

        close_process(child.id(), info.started_at).unwrap();
        assert!(child.wait().unwrap().code().is_some());
        assert_eq!(close_process(child.id(), info.started_at).unwrap_err().kind, ErrorKind::NotFound);
    }
}
