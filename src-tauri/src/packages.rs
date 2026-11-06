//! Package Scanner: enumerates what is installed across the machine's package
//! managers.
//!
//! Scanning is read-only and offline: every scan command lists, the frontend
//! selects sources by id, and the argv for each id is a compile-time constant.
//! `pkg_check_updates` is also read-only but needs the internet, so it runs only
//! when the user asks. The writes are `pkg_upgrade` and `pkg_uninstall`, each
//! acting on one package. A package id, and for winget a version, are the only
//! outside strings that reach a command line, and both are validated first.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::UNIX_EPOCH;

use tauri::Emitter;

use crate::shell::hidden;

use crate::docker::is_in_path;
use crate::shell::ShellOut;
use crate::error::{AtlasError, ErrorKind};

fn emit_line(app: &tauri::AppHandle, text: impl Into<String>, stderr: bool) {
    app.emit("shell-out", ShellOut { text: text.into(), stderr }).ok();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

struct SourceSpec {
    id: &'static str,
    label: &'static str,
    /// The exact command run, already split for `cmd /C`. `argv[0]` doubles as
    /// the executable looked up on PATH to decide whether the source exists on
    /// this machine.
    argv: &'static [&'static str],
}

/// Every source the scanner knows about. Adding one is a line here plus a
/// parser arm in `parse_packages`.
const SOURCES: &[SourceSpec] = &[
    SourceSpec {
        id: "winget",
        label: "winget",
        argv: &["winget", "list", "--disable-interactivity"],
    },
    SourceSpec {
        id: "choco",
        label: "Chocolatey",
        // --local-only is a no-op on Chocolatey 2 but keeps 1.x from searching
        // the online repository instead.
        argv: &["choco", "list", "--local-only", "--limit-output"],
    },
    SourceSpec {
        id: "scoop",
        label: "Scoop",
        argv: &["scoop", "export"],
    },
    SourceSpec {
        id: "npm",
        label: "npm (global)",
        // --long adds each package's folder and author.
        argv: &["npm", "ls", "-g", "--depth=0", "--json", "--long"],
    },
    SourceSpec {
        id: "pnpm",
        label: "pnpm (global)",
        argv: &["pnpm", "ls", "-g", "--depth=0", "--json"],
    },
    SourceSpec {
        id: "pip",
        label: "pip",
        // -v adds each package's install location.
        argv: &["pip", "list", "--format=json", "-v"],
    },
    SourceSpec {
        id: "pipx",
        label: "pipx",
        argv: &["pipx", "list", "--json"],
    },
    SourceSpec {
        id: "uv",
        label: "uv tools",
        argv: &["uv", "tool", "list"],
    },
    SourceSpec {
        id: "conda",
        label: "conda envs",
        argv: &["conda", "env", "list", "--json"],
    },
    SourceSpec {
        id: "cargo",
        label: "Cargo",
        argv: &["cargo", "install", "--list"],
    },
    SourceSpec {
        id: "rustup",
        label: "Rust toolchains",
        argv: &["rustup", "toolchain", "list"],
    },
    SourceSpec {
        id: "gem",
        label: "Ruby gems",
        argv: &["gem", "list"],
    },
    SourceSpec {
        id: "dotnet",
        label: ".NET tools",
        argv: &["dotnet", "tool", "list", "-g"],
    },
    SourceSpec {
        id: "dotnet-sdk",
        label: ".NET SDKs",
        argv: &["dotnet", "--list-sdks"],
    },
    SourceSpec {
        id: "dotnet-runtime",
        label: ".NET runtimes",
        argv: &["dotnet", "--list-runtimes"],
    },
    SourceSpec {
        id: "powershell",
        label: "PowerShell",
        argv: &[
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            "Get-InstalledModule | Select-Object Name,Version,Author,InstalledLocation | ConvertTo-Csv -NoTypeInformation",
        ],
    },
    SourceSpec {
        id: "vscode",
        label: "VS Code",
        argv: &["code", "--list-extensions", "--show-versions"],
    },
    SourceSpec {
        id: "code-insiders",
        label: "VS Code Insiders",
        argv: &["code-insiders", "--list-extensions", "--show-versions"],
    },
    SourceSpec {
        id: "cursor",
        label: "Cursor",
        argv: &["cursor", "--list-extensions", "--show-versions"],
    },
    SourceSpec {
        id: "codium",
        label: "VSCodium",
        argv: &["codium", "--list-extensions", "--show-versions"],
    },
    SourceSpec {
        id: "registry",
        label: "Installed apps",
        // The uninstall keys behind Settings > Installed apps, minus the entries
        // Windows itself hides (SystemComponent = 1).
        argv: &[
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, \
             HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, \
             HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue \
             | Where-Object DisplayName | Where-Object SystemComponent -ne 1 \
             | Select-Object DisplayName,DisplayVersion,PSChildName,Publisher,InstallLocation,InstallDate \
             | ConvertTo-Csv -NoTypeInformation",
        ],
    },
    SourceSpec {
        id: "store",
        label: "Microsoft Store",
        // Store-signed apps only, leaving out inbox system apps, frameworks
        // and sideloaded developer builds.
        argv: &[
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            "Get-AppxPackage -PackageTypeFilter Main | Where-Object SignatureKind -eq Store \
             | Select-Object Name,Version,PackageFamilyName | ConvertTo-Csv -NoTypeInformation",
        ],
    },
];

/// The argv as one line that pastes into PowerShell or cmd. Arguments with
/// spaces are double-quoted, which is also how Rust hands them to `cmd /C`.
fn command_line<S: AsRef<str>>(argv: &[S]) -> String {
    argv.iter()
        .map(|a| {
            let a = a.as_ref();
            if a.contains(' ') { format!("\"{a}\"") } else { a.to_string() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Package {
    pub name: String,
    /// Package id where the manager has one distinct from the name (winget,
    /// the registry key for installed apps, the Store package family, the
    /// conda environment path). Equal to `name` elsewhere.
    pub id: String,
    pub version: String,
    /// Newer version the manager reports as installable. Empty when nothing is
    /// available, and for every source but winget, whose list includes it.
    /// `pkg_check_updates` covers npm, pip and Chocolatey.
    pub available: String,
    /// Scanner source id, one of the `SOURCES` ids.
    pub source: String,
    /// The exact command `pkg_upgrade` would run, for winget packages with an
    /// upgrade available. None means the package cannot be upgraded here.
    pub upgrade_command: Option<String>,
    /// Whether `pkg_uninstall` accepts this package.
    pub uninstallable: bool,
    /// When it was installed or last updated, as Unix seconds. None when
    /// neither the source nor its files on disk say.
    pub updated: Option<u64>,
    /// Empty when the source does not name one.
    pub publisher: String,
    /// Install folder or file. Empty when unknown.
    pub location: String,
}

impl Package {
    fn new(source: &str, name: &str, id: &str, version: &str) -> Self {
        Package {
            name: name.to_string(),
            id: id.to_string(),
            version: version.to_string(),
            available: String::new(),
            source: source.to_string(),
            upgrade_command: None,
            uninstallable: false,
            updated: None,
            publisher: String::new(),
            location: String::new(),
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct SourceResult {
    pub id: String,
    pub label: String,
    /// The command that was run, copy-pasteable into PowerShell.
    pub command: String,
    /// False when the manager is not on PATH. Not an error, just absent.
    pub installed: bool,
    pub packages: Vec<Package>,
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Running
// ─────────────────────────────────────────────────────────────────────────────

/// Run a lister and capture its output as `(stdout, stderr, success)`.
///
/// A non-zero exit is deliberately not fatal here: `npm ls -g` exits non-zero
/// over unrelated dependency warnings while still printing perfectly valid JSON
/// on stdout. Callers decide, after parsing, whether the exit code mattered.
fn run_capture(argv: &[&str]) -> Result<(String, String, bool), AtlasError> {
    // Through `cmd /C` so PATHEXT resolves the `.cmd` shims npm and friends
    // ship as. `Command::new("npm")` only auto-appends `.exe` and would fail.
    let out = hidden("cmd")
        .arg("/C")
        .args(argv)
        .output()
        .map_err(|e| format!("Failed to run {}: {}", argv[0], e))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).trim_start_matches('\u{feff}').to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
        out.status.success(),
    ))
}

fn scan_one(spec: &SourceSpec) -> SourceResult {
    let mut result = SourceResult {
        id: spec.id.to_string(),
        label: spec.label.to_string(),
        command: command_line(spec.argv),
        installed: is_in_path(spec.argv[0]),
        packages: Vec::new(),
        error: None,
    };
    if !result.installed {
        return result;
    }

    // ponytail: no timeout, a wedged lister hangs its thread until the process
    // exits. Add a watchdog if a source turns out to hang in practice.
    match run_capture(spec.argv) {
        Ok((stdout, stderr, ok)) => {
            // The tool is on PATH but what this source lists is not set up:
            // global tools need a .NET SDK, and pnpm refuses to list globals
            // until `pnpm setup` puts its global bin directory on PATH.
            let unset = match spec.id {
                "dotnet" => stderr.contains("No .NET SDKs were found"),
                "pnpm" => stderr.contains("global bin directory"),
                _ => false,
            };
            if unset {
                result.installed = false;
                return result;
            }
            result.packages = parse_packages(spec.id, &stdout);
            add_file_details(spec.id, &mut result.packages);
            for p in &mut result.packages {
                p.uninstallable = uninstall_argv(&p.source, &p.id, None).is_some();
            }
            // Only surface the exit code when it cost us the listing; a warning
            // alongside a full package list is noise.
            if result.packages.is_empty() && !ok {
                result.error = Some(if stderr.is_empty() {
                    format!("{} exited with an error", spec.argv[0])
                } else {
                    stderr.lines().next().unwrap_or_default().to_string()
                });
            }
        }
        // This field is a plain string in the per-source result the UI renders
        // inline, so it takes the classified sentence and drops the rest.
        Err(e) => result.error = Some(e.message),
    }
    result
}

/// Scan the selected package managers and return one result per source.
///
/// Sources run concurrently, since winget alone takes seconds, so the commands
/// are echoed up front in the requested order and each result line names its
/// source, keeping the terminal readable despite the interleaving.
#[tauri::command]
pub async fn pkg_scan(
    app: tauri::AppHandle,
    sources: Vec<String>,
) -> Result<Vec<SourceResult>, AtlasError> {
    // Ids are matched against the constant table; anything unknown is dropped
    // rather than passed on to a command line.
    let specs: Vec<&SourceSpec> = SOURCES
        .iter()
        .filter(|s| sources.iter().any(|want| want == s.id))
        .collect();
    if specs.is_empty() {
        return Err("Select at least one package source.".to_string().into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SourceResult>, AtlasError> {
        for spec in &specs {
            emit_line(&app, format!("$ {}", command_line(spec.argv)), false);
        }

        let mut results: Vec<SourceResult> = thread::scope(|scope| {
            let handles: Vec<_> = specs
                .iter()
                .map(|spec| scope.spawn(move || scan_one(spec)))
                .collect();
            handles
                .into_iter()
                .zip(specs.iter())
                .map(|(handle, spec)| {
                    handle.join().unwrap_or_else(|_| SourceResult {
                        id: spec.id.to_string(),
                        label: spec.label.to_string(),
                        command: command_line(spec.argv),
                        installed: true,
                        packages: Vec::new(),
                        error: Some("The scan stopped unexpectedly.".to_string()),
                    })
                })
                .collect()
        });

        let apps = results.iter().find(|r| r.id == "registry").map(|r| r.packages.clone());
        if let (Some(apps), Some(winget)) = (apps, results.iter_mut().find(|r| r.id == "winget")) {
            borrow_from_installed_apps(&mut winget.packages, &apps);
        }

        for r in &results {
            if !r.installed {
                emit_line(&app, format!("  # {} not found, skipped", r.label), false);
            } else if let Some(err) = &r.error {
                emit_line(&app, format!("  ✗ {}: {}", r.id, err), true);
            } else {
                emit_line(&app, format!("  ✓ {}: {} package{}", r.id, r.packages.len(), if r.packages.len() == 1 { "" } else { "s" }), false);
            }
        }

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save a scan as CSV. The contents are built by the frontend; this only picks
/// a destination and writes it.
#[tauri::command]
pub async fn pkg_export_csv(
    app: tauri::AppHandle,
    contents: String,
) -> Result<Option<String>, AtlasError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, AtlasError> {
        let Some(path) = rfd::FileDialog::new()
            .set_file_name("installed-packages.csv")
            .add_filter("CSV", &["csv"])
            .save_file()
        else {
            return Ok(None);
        };
        let win = path.to_string_lossy().replace('/', "\\");
        emit_line(&app, format!("$ Set-Content -Path \"{}\" -Encoding utf8", win), false);
        match std::fs::write(&path, contents) {
            Ok(_) => {
                emit_line(&app, format!("  ✓ saved {}", win), false);
                Ok(Some(win))
            }
            Err(e) => {
                let msg = format!("Cannot write '{}': {}", win, e);
                emit_line(&app, format!("  ✗ {}", msg), true);
                Err(msg.into())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrading
// ─────────────────────────────────────────────────────────────────────────────

/// winget ids look like `Git.Git` or `Microsoft.VisualStudioCode`. The id
/// becomes a command-line argument, so anything outside this set is refused,
/// including the `ARP\...` ids of apps winget did not install.
fn valid_winget_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}

/// The upgrade command for a package, or None when Atlas cannot upgrade it.
/// npm ships as a `.cmd` shim, named in full so it runs without a `cmd /C`
/// wrapper. A global `npm install` with no version takes the latest.
fn upgrade_argv(source: &str, id: &str) -> Option<Vec<String>> {
    if !valid_id(source, id) {
        return None;
    }
    let argv = match source {
        "winget" => vec![
            "winget", "upgrade", "--id", id, "--exact",
            "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
        ],
        "pip" => vec!["pip", "install", "--upgrade", id],
        "npm" => vec!["npm.cmd", "install", "--global", id],
        // Chocolatey's default folder is admin-only.
        "choco" => return Some(as_admin(&["choco", "upgrade", id, "--yes"])),
        _ => return None,
    };
    Some(argv.into_iter().map(String::from).collect())
}

fn upgrade_command(source: &str, id: &str) -> Option<String> {
    upgrade_argv(source, id).map(|argv| command_line(&argv))
}

/// Wrap a command so Windows asks for approval and runs it in its own window,
/// since an elevated process cannot stream to this one. The exit code still
/// comes back. Validated ids keep quotes out of the string.
fn as_admin<S: AsRef<str>>(argv: &[S]) -> Vec<String> {
    let args: Vec<&str> = argv[1..].iter().map(AsRef::as_ref).collect();
    let script = format!(
        "exit (Start-Process {} -Verb RunAs -Wait -PassThru -ArgumentList '{}').ExitCode",
        argv[0].as_ref(),
        args.join(" ")
    );
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script.as_str()].map(String::from).to_vec()
}

/// Before replacing or removing a package, pip moves its files aside, and it
/// only undoes that if the later install fails. An all-users Python lets it move
/// site-packages but not `Scripts\*.exe`, so it stops halfway and leaves the
/// package broken as `~name`. pip therefore runs elevated when its own folder is
/// read-only.
fn needs_admin(source: &str) -> bool {
    if source != "pip" {
        return false;
    }
    let Ok((stdout, _, _)) = run_capture(&["where", "pip"]) else {
        return false;
    };
    stdout
        .lines()
        .next()
        .and_then(|exe| Path::new(exe.trim()).parent())
        .is_some_and(|folder| !can_create_files_in(folder))
}

fn can_create_files_in(folder: &Path) -> bool {
    let probe = folder.join(format!("~atlas-write-test-{}", std::process::id()));
    let created = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_ok();
    if created {
        std::fs::remove_file(&probe).ok();
    }
    created
}

/// One package with a newer version, from `pkg_check_updates`.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct PackageUpdate {
    pub id: String,
    pub available: String,
    pub upgrade_command: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct SourceUpdates {
    pub source: String,
    pub label: String,
    pub updates: Vec<PackageUpdate>,
    /// Set when the check failed, which does not mean nothing is outdated.
    pub error: Option<String>,
}

/// Each lister that asks the internet for newer versions. winget is absent
/// because its scan already reports them.
const UPDATE_CHECKS: &[(&str, &[&str])] = &[
    ("npm", &["npm", "outdated", "--global", "--json", "--fetch-retries=0"]),
    ("pip", &["pip", "list", "--outdated", "--format=json", "--disable-pip-version-check"]),
    ("choco", &["choco", "outdated", "--limit-output"]),
];

/// Offline, `pip list --outdated` spends minutes and then reports nothing
/// outdated with exit 0, so this asks about one package first.
const PIP_REACHABLE: &[&str] = &[
    "pip", "index", "versions", "pip", "--disable-pip-version-check", "--retries", "0", "--timeout", "10",
];

/// `(id, newer version)` for each outdated package, or why the check failed.
fn outdated(source: &str, argv: &[&str]) -> Result<Vec<(String, String)>, String> {
    if source == "pip" && !run_capture(PIP_REACHABLE).map_err(|e| e.message)?.2 {
        return Err("pip could not reach its package index.".to_string());
    }
    let (stdout, stderr, ok) = run_capture(argv).map_err(|e| e.message)?;
    let found = match source {
        "npm" => parse_npm_outdated(&stdout)?,
        "pip" => parse_pip_outdated(&stdout),
        // Chocolatey also exits 0 when offline.
        _ if stdout.contains("Unable to connect to source") => {
            return Err("Chocolatey could not reach its package source.".to_string());
        }
        _ => parse_choco_outdated(&stdout),
    };
    // npm exits 1 when it finds updates, so the exit code only counts when
    // nothing came back.
    if !ok && found.is_empty() {
        return Err(stderr.lines().next().unwrap_or("The check exited with an error.").to_string());
    }
    Ok(found)
}

/// Ask npm, pip and Chocolatey which packages have newer versions. Read-only,
/// but needs the internet. Tools that are not installed are left out.
#[tauri::command]
pub async fn pkg_check_updates(app: tauri::AppHandle) -> Result<Vec<SourceUpdates>, AtlasError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SourceUpdates>, AtlasError> {
        let checks: Vec<_> = UPDATE_CHECKS.iter().filter(|(_, argv)| is_in_path(argv[0])).collect();
        for (source, argv) in &checks {
            if *source == "pip" {
                emit_line(&app, format!("$ {}", command_line(PIP_REACHABLE)), false);
            }
            emit_line(&app, format!("$ {}", command_line(argv)), false);
        }

        let results: Vec<SourceUpdates> = thread::scope(|scope| {
            let handles: Vec<_> = checks
                .iter()
                .map(|(source, argv)| (*source, scope.spawn(move || outdated(source, argv))))
                .collect();
            handles
                .into_iter()
                .map(|(source, handle)| {
                    let outcome = handle.join().unwrap_or_else(|_| Err("The check stopped unexpectedly.".to_string()));
                    let (found, error) = match outcome {
                        Ok(found) => (found, None),
                        Err(e) => (Vec::new(), Some(e)),
                    };
                    let admin = needs_admin(source);
                    SourceUpdates {
                        source: source.to_string(),
                        label: SOURCES.iter().find(|s| s.id == source).map_or(source, |s| s.label).to_string(),
                        updates: found
                            .into_iter()
                            .map(|(id, available)| PackageUpdate {
                                upgrade_command: upgrade_argv(source, &id)
                                    .map(|argv| command_line(&if admin { as_admin(&argv) } else { argv })),
                                id,
                                available,
                            })
                            .collect(),
                        error,
                    }
                })
                .collect()
        });

        for r in &results {
            match &r.error {
                Some(err) => emit_line(&app, format!("  ✗ {}: {}", r.source, err), true),
                None => emit_line(&app, format!("  ✓ {}: {} update{}", r.source, r.updates.len(), if r.updates.len() == 1 { "" } else { "s" }), false),
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One package job (upgrade or uninstall) at a time, even if the view is
/// closed and reopened mid-run.
static PACKAGE_JOB: AtomicBool = AtomicBool::new(false);

async fn one_job<T: Send + 'static>(
    migration: &crate::wsl_migration::MigrationState,
    job: impl FnOnce() -> Result<T, AtlasError> + Send + 'static,
) -> Result<T, AtlasError> {
    if PACKAGE_JOB.swap(true, Ordering::SeqCst) {
        return Err(AtlasError::new(ErrorKind::Busy, "Wait for the current package upgrade or uninstall to finish."));
    }
    let result = migration.clone().run_operation(job).await;
    PACKAGE_JOB.store(false, Ordering::SeqCst);
    result
}

/// Upgrade one package, streaming the manager's output to the terminal. After a
/// pip upgrade, returns the `pip check` lines that name the package.
///
/// The manager runs directly, not through `cmd /C`, so no shell ever reads the
/// id. Installers that need administrator rights raise their own UAC prompt.
/// There is no cancel, because stopping an installer halfway can break the app.
#[tauri::command]
pub async fn pkg_upgrade(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    source: String,
    id: String,
) -> Result<Vec<String>, AtlasError> {
    let Some(argv) = upgrade_argv(&source, &id) else {
        return Err(AtlasError::invalid("This package cannot be upgraded here."));
    };
    one_job(&migration, move || {
        let argv = if needs_admin(&source) { as_admin(&argv) } else { argv };
        let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
        run_streamed(&app, &argv, &format!("{} could not upgrade {}.", source, id))?;
        emit_line(&app, format!("  ✓ {} upgraded {}", source, id), false);
        if source == "pip" { pip_check(&app, &id) } else { Ok(Vec::new()) }
    })
    .await
}

/// Run `pip check` and report the lines that name `id`.
fn pip_check(app: &tauri::AppHandle, id: &str) -> Result<Vec<String>, AtlasError> {
    let check = ["pip", "check"];
    emit_line(app, format!("$ {}", command_line(&check)), false);
    let (stdout, _, _) = run_capture(&check)?;
    let broken = broken_requirements(&stdout, id);
    for line in &broken {
        emit_line(app, format!("  ✗ {}", line), true);
    }
    if broken.is_empty() {
        emit_line(app, format!("  ✓ pip check found no problem with {}", id), false);
    }
    Ok(broken)
}

/// Run argv directly, streaming its output to the terminal as it arrives.
fn run_streamed(app: &tauri::AppHandle, argv: &[&str], failure: &str) -> Result<(), AtlasError> {
    emit_line(app, format!("$ {}", command_line(argv)), false);

    let mut child = hidden(argv[0])
        .args(&argv[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {}: {}", argv[0], e))?;

    let err_app = app.clone();
    let err_thread = child
        .stderr
        .take()
        .map(|pipe| thread::spawn(move || stream_lines(&err_app, pipe, true)));
    let tail = child
        .stdout
        .take()
        .map(|pipe| stream_lines(app, pipe, false))
        .unwrap_or_default();
    let err_tail = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let status = child.wait()?;
    if status.success() {
        return Ok(());
    }
    // `as_admin` has no error code to read, only Start-Process's message on stderr.
    if err_tail.to_lowercase().contains("canceled by the user") {
        return Err(AtlasError::new(ErrorKind::Elevation, "Administrator approval was not given, so nothing was changed.")
            .hint("To continue, run it again and approve the prompt."));
    }
    // Windows Installer's "worked, but restart to finish", which Chocolatey passes on.
    if matches!(status.code(), Some(1641 | 3010)) {
        emit_line(app, "  # restart Windows to finish", false);
        return Ok(());
    }
    // winget exits with an HRESULT, which is only recognisable in hex.
    let code = format!("0x{:08X}", status.code().unwrap_or(-1) as u32);
    emit_line(app, format!("  ✗ {} exited {}", argv[0], code), true);
    Err(AtlasError::new(ErrorKind::Unknown, failure)
        .hint("The terminal shows the tool's own error message. If the program being changed is open, close it and try again.")
        .detail(format!("Exit code {}\n{}", code, tail)))
}

/// Emit each line of a child's output as it arrives, and return the last few
/// for the error detail. winget redraws its progress bar with `\r`, so only
/// the final state of each line is kept.
fn stream_lines(app: &tauri::AppHandle, pipe: impl std::io::Read, stderr: bool) -> String {
    let mut tail: Vec<String> = Vec::new();
    for chunk in BufReader::new(pipe).split(b'\n').map_while(Result::ok) {
        let text = String::from_utf8_lossy(&chunk);
        let Some(line) = text.rsplit('\r').map(str::trim_end).find(|s| !s.trim().is_empty()) else {
            continue;
        };
        emit_line(app, line, stderr);
        tail.push(line.to_string());
        if tail.len() > 10 {
            tail.remove(0);
        }
    }
    tail.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Uninstalling
// ─────────────────────────────────────────────────────────────────────────────

/// Package names in these managers fit in letters, digits and `. _ - +`, and
/// npm adds one `@scope/` prefix. Like winget ids, they become command-line
/// arguments, so anything else is refused.
fn valid_id(source: &str, id: &str) -> bool {
    let plain = |s: &str| {
        !s.is_empty()
            && s.len() <= 214
            && !s.starts_with(['-', '.'])
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
    };
    match source {
        "winget" => valid_winget_id(id),
        "pip" | "choco" => plain(id),
        "npm" => match id.strip_prefix('@').and_then(|scoped| scoped.split_once('/')) {
            Some((scope, name)) => plain(scope) && plain(name),
            None => plain(id),
        },
        "vscode" => plain(id) && id.contains('.'),
        _ => false,
    }
}

fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && !v.starts_with('-')
        && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}

/// The uninstall command for a package, or None when Atlas cannot remove it.
/// `version` pins a winget uninstall to one of several installs sharing an id.
/// npm and VS Code ship as `.cmd` shims, named in full so they run without a
/// `cmd /C` wrapper.
fn uninstall_argv<'a>(source: &str, id: &'a str, version: Option<&'a str>) -> Option<Vec<&'a str>> {
    if !valid_id(source, id) {
        return None;
    }
    let mut argv = match source {
        "winget" => vec![
            "winget", "uninstall", "--id", id, "--exact",
            "--accept-source-agreements", "--disable-interactivity",
        ],
        "pip" => vec!["pip", "uninstall", "--yes", id],
        "npm" => vec!["npm.cmd", "uninstall", "--global", id],
        "vscode" => vec!["code.cmd", "--uninstall-extension", id],
        _ => return None,
    };
    if source == "winget" {
        if let Some(v) = version {
            if !valid_version(v) {
                return None;
            }
            argv.extend(["--version", v]);
        }
    }
    Some(argv)
}

/// The command that puts a removed package back at the version it had. Only
/// shown and logged, never run.
fn reinstall_command(source: &str, id: &str, installed: &str) -> String {
    let pinned = valid_version(installed);
    match (source, pinned) {
        ("winget", true) => format!("winget install --id {id} --exact --version {installed}"),
        ("winget", false) => format!("winget install --id {id} --exact"),
        ("pip", true) => format!("pip install {id}=={installed}"),
        ("npm", true) => format!("npm.cmd install --global {id}@{installed}"),
        ("vscode", true) => format!("code.cmd --install-extension {id}@{installed}"),
        ("pip", false) => format!("pip install {id}"),
        ("npm", false) => format!("npm.cmd install --global {id}"),
        _ => format!("code.cmd --install-extension {id}"),
    }
}

/// Tools that other tools stand on. Removing one needs its id typed out. An
/// entry also covers ids that continue it after a dot (`Python.Python.3.12`).
const CORE_TOOLS: &[(&str, &str)] = &[
    ("winget", "Git.Git"),
    ("winget", "Python.Python"),
    ("winget", "OpenJS.NodeJS"),
    ("winget", "Microsoft.PowerShell"),
    ("winget", "Microsoft.AppInstaller"),
    ("winget", "Microsoft.WSL"),
    ("winget", "Docker.DockerDesktop"),
    ("winget", "Microsoft.VCRedist"),
    ("winget", "Microsoft.DotNet"),
    ("winget", "Rustlang.Rustup"),
    ("pip", "pip"),
    ("pip", "setuptools"),
    ("npm", "npm"),
    ("npm", "pnpm"),
    ("npm", "corepack"),
];

fn is_core(source: &str, id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    CORE_TOOLS.iter().any(|(s, core)| {
        let core = core.to_ascii_lowercase();
        *s == source && (id == core || id.starts_with(&format!("{core}.")))
    })
}

/// What removing a package would break, gathered before anything runs.
#[derive(serde::Serialize, Default, Debug, PartialEq)]
pub struct UninstallCheck {
    pub command: String,
    pub reinstall_command: String,
    pub core: bool,
    /// Installed packages that require this one. None when the manager does
    /// not record it (winget).
    pub needed_by: Option<Vec<String>>,
    /// Commands on PATH that disappear with the package.
    pub commands: Vec<String>,
    /// Processes running from the app's install folder. None when that folder
    /// is unknown or the question does not apply.
    pub running: Option<Vec<String>>,
    /// Files pip would delete. None for other managers.
    pub files: Option<usize>,
    /// What the check could not see, one sentence each.
    pub limits: Vec<String>,
}

/// Look before uninstalling: who depends on the package, which commands go
/// with it, and whether it is running. Read-only.
#[tauri::command]
pub async fn pkg_uninstall_check(
    app: tauri::AppHandle,
    source: String,
    id: String,
    name: String,
    installed: String,
    version: Option<String>,
) -> Result<UninstallCheck, AtlasError> {
    let argv = uninstall_argv(&source, &id, version.as_deref())
        .ok_or_else(|| AtlasError::invalid("This package cannot be uninstalled here."))?;
    let mut check = UninstallCheck {
        command: command_line(&argv),
        reinstall_command: reinstall_command(&source, &id, &installed),
        core: is_core(&source, &id),
        ..Default::default()
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<UninstallCheck, AtlasError> {
        match source.as_str() {
            "pip" => {
                if needs_admin("pip") {
                    check.command = command_line(&as_admin(&["pip", "uninstall", "--yes", id.as_str()]));
                }
                let show = ["pip", "show", "--files", id.as_str()];
                emit_line(&app, format!("$ {}", command_line(&show)), false);
                let (stdout, _, _) = run_capture(&show)?;
                let (needed_by, commands, files) = parse_pip_show(&stdout);
                check.needed_by = Some(needed_by);
                check.commands = commands;
                check.files = Some(files);
            }
            "npm" => {
                // Global npm packages each carry their own dependencies, so
                // none can need another.
                check.needed_by = Some(Vec::new());
                let root = ["npm.cmd", "root", "--global"];
                emit_line(&app, format!("$ {}", command_line(&root)), false);
                let (stdout, _, _) = run_capture(&root)?;
                let manifest = std::path::Path::new(stdout.trim()).join(&id).join("package.json");
                match std::fs::read_to_string(&manifest) {
                    Ok(json) => check.commands = npm_bin_commands(&json, &id),
                    Err(_) => check.limits.push(format!(
                        "Could not read {}, so the commands it adds are unknown.",
                        manifest.display()
                    )),
                }
            }
            "vscode" => {
                let dir = std::env::var("USERPROFILE")
                    .map(|home| std::path::Path::new(&home).join(".vscode").join("extensions"))
                    .ok()
                    .and_then(|dir| std::fs::read_dir(dir).ok());
                match dir {
                    Some(entries) => {
                        let manifests = entries
                            .flatten()
                            .filter_map(|e| std::fs::read_to_string(e.path().join("package.json")).ok());
                        check.needed_by = Some(vscode_dependents(manifests, &id));
                    }
                    None => check.limits.push(
                        "Could not read VS Code's extensions folder, so dependent extensions are unknown."
                            .to_string(),
                    ),
                }
            }
            "winget" => {
                check.limits.push("winget does not record which programs depend on this one.".to_string());
                emit_line(&app, format!("$ {}", command_line(INSTALL_LOCATIONS_ARGV)), false);
                let (stdout, _, _) = run_capture(INSTALL_LOCATIONS_ARGV)?;
                let locations: Vec<String> = parse_csv(&stdout)
                    .into_iter()
                    .filter(|cols| field(cols, 0).eq_ignore_ascii_case(name.trim()))
                    .map(|cols| field(&cols, 1).to_string())
                    .collect();
                if locations.is_empty() {
                    check.limits.push(
                        "Could not find where this app is installed, so Atlas cannot tell whether it is running."
                            .to_string(),
                    );
                } else {
                    check.running = Some(processes_under(&running_executables(), &locations));
                }
            }
            _ => {}
        }
        Ok(check)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Uninstall one package, streaming the manager's output to the terminal.
/// A core tool needs its id typed as `confirm`. After a pip uninstall,
/// returns the `pip check` lines that name the removed package.
#[tauri::command]
pub async fn pkg_uninstall(
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    source: String,
    id: String,
    version: Option<String>,
    confirm: Option<String>,
) -> Result<Vec<String>, AtlasError> {
    if uninstall_argv(&source, &id, version.as_deref()).is_none() {
        return Err(AtlasError::invalid("This package cannot be uninstalled here."));
    }
    if is_core(&source, &id) && confirm.as_deref().map(str::trim) != Some(id.as_str()) {
        return Err(AtlasError::invalid(format!("Type {} to confirm removing a core tool.", id)));
    }
    one_job(&migration, move || {
        let Some(argv) = uninstall_argv(&source, &id, version.as_deref()) else {
            return Err(AtlasError::invalid("This package cannot be uninstalled here."));
        };
        let tool = argv[0].trim_end_matches(".cmd");
        let admin_argv = if needs_admin(&source) { as_admin(&argv) } else { Vec::new() };
        let argv = if admin_argv.is_empty() { argv } else { admin_argv.iter().map(String::as_str).collect() };
        run_streamed(&app, &argv, &format!("{} could not uninstall {}.", tool, id))?;
        emit_line(&app, format!("  ✓ {} uninstalled {}", tool, id), false);
        if source == "pip" { pip_check(&app, &id) } else { Ok(Vec::new()) }
    })
    .await
}

/// DisplayName and InstallLocation of every uninstall key that has one. A
/// fixed command, so no package name ever reaches PowerShell.
const INSTALL_LOCATIONS_ARGV: &[&str] = &[
    "powershell", "-NoProfile", "-NonInteractive", "-Command",
    "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, \
     HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, \
     HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue \
     | Where-Object InstallLocation | Select-Object DisplayName,InstallLocation | ConvertTo-Csv -NoTypeInformation",
];

/// `(process name, executable path)` for every running process Windows lets
/// an unprivileged app read the path of.
fn running_executables() -> Vec<(String, String)> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System, UpdateKind};
    let system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet)),
    );
    system
        .processes()
        .values()
        .filter_map(|p| Some((p.name().to_string_lossy().into_owned(), p.exe()?.to_string_lossy().into_owned())))
        .collect()
}

/// Names of processes whose executable sits inside one of the folders.
fn processes_under(processes: &[(String, String)], folders: &[String]) -> Vec<String> {
    let folders: Vec<String> = folders
        .iter()
        .map(|f| f.trim().trim_matches('"').trim_end_matches('\\').to_ascii_lowercase())
        .filter(|f| f.len() > 3) // never a bare drive root like `c:`
        .map(|f| f + "\\")
        .collect();
    let mut names: Vec<String> = processes
        .iter()
        .filter(|(_, exe)| folders.iter().any(|f| exe.to_ascii_lowercase().starts_with(f)))
        .map(|(name, _)| name.clone())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// From `pip show --files`: who requires the package, the commands it puts in
/// `Scripts`, and how many files it owns.
fn parse_pip_show(out: &str) -> (Vec<String>, Vec<String>, usize) {
    let mut needed_by = Vec::new();
    let mut commands = Vec::new();
    let mut files = 0;
    let mut in_files = false;
    for line in out.lines() {
        if let Some(list) = line.strip_prefix("Required-by:") {
            needed_by = list.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect();
        } else if line.starts_with("Files:") {
            in_files = true;
        } else if in_files && line.starts_with(char::is_whitespace) {
            files += 1;
            let path = line.trim().replace('\\', "/");
            if let Some(exe) = path.split_once("Scripts/").map(|(_, f)| f).and_then(|f| f.strip_suffix(".exe")) {
                commands.push(exe.to_string());
            }
        } else {
            in_files = false;
        }
    }
    (needed_by, commands, files)
}

/// The commands an npm package's `bin` field adds: one named after the
/// package when `bin` is a string, one per key when it is a map.
fn npm_bin_commands(manifest: &str, id: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(manifest) else {
        return Vec::new();
    };
    match root.get("bin") {
        Some(serde_json::Value::String(_)) => vec![id.rsplit('/').next().unwrap_or(id).to_string()],
        Some(serde_json::Value::Object(map)) => map.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Installed extensions that list `id` in `extensionDependencies` or
/// `extensionPack`. VS Code keeps old versions beside new ones until it
/// cleans up, so the same dependent can appear twice and is deduplicated.
fn vscode_dependents(manifests: impl Iterator<Item = String>, id: &str) -> Vec<String> {
    let mut dependents: Vec<String> = manifests
        .filter_map(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .filter(|m| {
            ["extensionDependencies", "extensionPack"].iter().any(|key| {
                m.get(key)
                    .and_then(|v| v.as_array())
                    .is_some_and(|deps| deps.iter().any(|d| d.as_str().is_some_and(|d| d.eq_ignore_ascii_case(id))))
            })
        })
        .filter_map(|m| Some(format!("{}.{}", m.get("publisher")?.as_str()?, m.get("name")?.as_str()?)))
        .filter(|dependent| !dependent.eq_ignore_ascii_case(id))
        .collect();
    dependents.sort_by_key(|d| d.to_ascii_lowercase());
    dependents.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    dependents
}

/// The lines of `pip check` that name `id`: either "a requires id, which is not
/// installed" or "a has requirement id<2, but you have id 3". pip treats `-`,
/// `_` and `.` in names as the same, and `requests` must not match
/// `requests-oauthlib`.
fn broken_requirements(out: &str, id: &str) -> Vec<String> {
    let norm = |s: &str| s.to_ascii_lowercase().replace(['_', '.'], "-");
    let part_of_name = |c: char| c.is_ascii_alphanumeric() || c == '-';
    let needle = norm(id);
    out.lines()
        .filter(|line| {
            let line = norm(line);
            line.match_indices(&needle).any(|(i, _)| {
                !line[..i].ends_with(part_of_name) && !line[i + needle.len()..].starts_with(part_of_name)
            })
        })
        .map(|line| line.trim().to_string())
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────────────────────

fn parse_packages(source: &str, stdout: &str) -> Vec<Package> {
    match source {
        "winget" => parse_winget(stdout),
        "choco" => parse_choco(stdout),
        "scoop" => parse_scoop(stdout),
        "npm" => parse_npm(stdout),
        "pnpm" => parse_pnpm(stdout),
        "pip" => parse_pip(stdout),
        "pipx" => parse_pipx(stdout),
        "uv" => parse_uv(stdout),
        "conda" => parse_conda(stdout),
        "cargo" => parse_cargo(stdout, &cargo_bin()),
        "rustup" => parse_rustup(stdout),
        "gem" => parse_gem(stdout),
        "dotnet" => parse_dotnet(stdout),
        "dotnet-sdk" | "dotnet-runtime" => parse_dotnet_list(source, stdout),
        "powershell" => parse_psmodules(stdout),
        "vscode" | "code-insiders" | "cursor" | "codium" => parse_vscode(source, stdout),
        "registry" => parse_registry(stdout),
        "store" => parse_store(stdout),
        _ => Vec::new(),
    }
}

fn field(cols: &[String], i: usize) -> &str {
    cols.get(i).map_or("", String::as_str)
}

/// Start offset of each column in a fixed-width header line: a column begins at
/// the first non-space character that follows two or more spaces (or at the
/// start of the line). Reading the layout off the header instead of matching
/// header text keeps this working under a localized winget.
fn column_starts(header: &[char]) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut gap = 2; // the line start counts as a gap
    for (i, c) in header.iter().enumerate() {
        if *c == ' ' {
            gap += 1;
        } else {
            if gap >= 2 {
                starts.push(i);
            }
            gap = 0;
        }
    }
    starts
}

/// Cut one row of a fixed-width table at the given column starts.
fn slice_columns(line: &[char], starts: &[usize]) -> Vec<String> {
    starts
        .iter()
        .enumerate()
        .map(|(i, &start)| {
            if start >= line.len() {
                return String::new();
            }
            let end = starts.get(i + 1).copied().unwrap_or(line.len()).min(line.len());
            line[start..end].iter().collect::<String>().trim().to_string()
        })
        .collect()
}

/// Read a fixed-width table under a solid rule of dashes, as printed by
/// `winget list` and `dotnet tool list`. Returns the header's column count and
/// every row with a non-empty first column.
fn parse_table(out: &str) -> (usize, Vec<Vec<String>>) {
    let lines: Vec<&str> = out.lines().collect();
    let Some(rule) = lines
        .iter()
        .position(|l| l.len() >= 10 && l.chars().all(|c| c == '-'))
    else {
        return (0, Vec::new());
    };
    if rule == 0 {
        return (0, Vec::new());
    }

    let header: Vec<char> = lines[rule - 1].chars().collect();
    let starts = column_starts(&header);
    let rows = lines[rule + 1..]
        .iter()
        .map(|line| slice_columns(&line.chars().collect::<Vec<char>>(), &starts))
        .filter(|cols| cols.first().is_some_and(|name| !name.is_empty()))
        .collect();
    (starts.len(), rows)
}

/// Parse `winget list`.
///
/// The Available column only exists when at least one package has an upgrade,
/// so the layout is decided by how many columns the header actually has.
///
/// ponytail: slicing by character index assumes winget pads by character count.
/// A name containing double-width CJK glyphs will drift its row's later columns;
/// switch to a display-width measure if that shows up.
fn parse_winget(out: &str) -> Vec<Package> {
    let (columns, rows) = parse_table(out);
    if columns < 3 {
        return Vec::new();
    }
    // 5 columns: Name, Id, Version, Available, Source.
    // 4 columns: Name, Id, Version, Source. Nothing is upgradable.
    let has_available = columns >= 5;

    rows.iter()
        .map(|cols| {
            let id = field(cols, 1);
            let available = if has_available { field(cols, 3) } else { "" };
            Package {
                available: available.to_string(),
                upgrade_command: if available.is_empty() { None } else { upgrade_command("winget", id) },
                ..Package::new("winget", &cols[0], id, field(cols, 2))
            }
        })
        .collect()
}

/// Parse `dotnet tool list -g`: a Package Id, Version, Commands table.
fn parse_dotnet(out: &str) -> Vec<Package> {
    parse_table(out)
        .1
        .iter()
        .map(|cols| Package::new("dotnet", &cols[0], &cols[0], field(cols, 1)))
        .collect()
}

/// Parse `choco list --limit-output`: one `name|version` per line.
fn parse_choco(out: &str) -> Vec<Package> {
    out.lines()
        .filter_map(|line| {
            let (name, version) = line.trim().split_once('|')?;
            (!name.is_empty()).then(|| Package::new("choco", name, name, version))
        })
        .collect()
}

/// Parse `choco outdated --limit-output`: `name|current|available|pinned`.
/// Pinned packages stay put on upgrade, and a package Chocolatey could not look
/// up comes back with available equal to current.
fn parse_choco_outdated(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.trim().split('|').collect();
            let [name, current, available, pinned] = cols[..] else {
                return None;
            };
            (current != available && pinned != "true").then(|| (name.to_string(), available.to_string()))
        })
        .collect()
}

/// Parse `npm outdated --json`: `{"name": {"current": …, "latest": …}}`, or
/// `{"error": {"summary": …}}` when the registry cannot be reached. A package
/// can be named `error`, but it has no summary.
fn parse_npm_outdated(out: &str) -> Result<Vec<(String, String)>, String> {
    let Ok(root) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(out) else {
        return Ok(Vec::new());
    };
    if let Some(summary) = root.get("error").and_then(|e| e.get("summary")).and_then(|s| s.as_str()) {
        return Err(summary.to_string());
    }
    Ok(root
        .iter()
        .filter_map(|(name, info)| {
            let latest = info.get("latest")?.as_str()?;
            (info.get("current")?.as_str()? != latest).then(|| (name.clone(), latest.to_string()))
        })
        .collect())
}

/// Parse `pip list --outdated --format=json`: `[{"name": …, "latest_version": …}]`.
fn parse_pip_outdated(out: &str) -> Vec<(String, String)> {
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(out) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|p| Some((p.get("name")?.as_str()?.to_string(), p.get("latest_version")?.as_str()?.to_string())))
        .collect()
}

/// Parse `scoop export`: `{"apps": [{"Name": …, "Version": …}], …}`.
fn parse_scoop(out: &str) -> Vec<Package> {
    // Scoop prints warnings such as "Scoop is out of date" ahead of the JSON.
    let json = out.find('{').map_or("", |start| &out[start..]);
    let Ok(root) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(apps) = root.get("apps").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    apps.iter()
        .filter_map(|app| {
            let name = app.get("Name")?.as_str()?;
            let version = app.get("Version").and_then(|v| v.as_str()).unwrap_or_default();
            Some(Package::new("scoop", name, name, version))
        })
        .collect()
}

/// Parse `cargo install --list`: a `name v1.2.3:` line per crate, or
/// `name v1.2.3 (source):` for git and path installs, each followed by its
/// binaries on indented lines. A crate's location is its first binary in `bin`.
fn parse_cargo(out: &str, bin: &Path) -> Vec<Package> {
    let mut pkgs: Vec<Package> = Vec::new();
    for line in out.lines() {
        if line.starts_with(char::is_whitespace) {
            if let Some(p) = pkgs.last_mut().filter(|p| p.location.is_empty()) {
                p.location = bin.join(line.trim()).display().to_string();
            }
            continue;
        }
        let Some((name, rest)) = line.trim_end().strip_suffix(':').and_then(|l| l.split_once(' ')) else {
            continue;
        };
        if let Some(version) = rest.split(' ').next() {
            pkgs.push(Package::new("cargo", name, name, version.trim_start_matches('v')));
        }
    }
    pkgs
}

/// Parse `rustup toolchain list`: one toolchain per line, the default one
/// marked `(active, default)`. The version is the channel ahead of the
/// four-part host triple: `stable`, `1.98.0` or `nightly-2026-01-01`.
fn parse_rustup(out: &str) -> Vec<Package> {
    out.lines()
        .filter_map(|line| {
            let name = line.split(" (").next()?.trim();
            // Also drops the "no installed toolchains" message.
            if name.is_empty() || name.contains(' ') {
                return None;
            }
            let channel = name.rsplitn(5, '-').nth(4).unwrap_or_default();
            Some(Package::new("rustup", name, name, channel))
        })
        .collect()
}

/// Parse `gem list`: `name (1.2.3, 1.1.0)` per gem, newest version first.
/// Gems bundled with Ruby read `(default: 1.2.3)` and native ones add a
/// platform, as in `(1.15.4 x64-mingw-ucrt)`.
fn parse_gem(out: &str) -> Vec<Package> {
    out.lines()
        .filter_map(|line| {
            let (name, versions) = line.trim().strip_suffix(')')?.split_once(" (")?;
            let version = versions.trim_start_matches("default: ").split([',', ' ']).next()?;
            Some(Package::new("gem", name, name, version))
        })
        .collect()
}

/// Parse `uv tool list`: a `name v1.2.3` line per tool, each followed by the
/// commands it adds on `- name.exe` lines.
fn parse_uv(out: &str) -> Vec<Package> {
    out.lines()
        .filter(|line| !line.starts_with('-'))
        .filter_map(|line| {
            let (name, rest) = line.trim().split_once(' ')?;
            let version = rest.split(' ').next()?.strip_prefix('v')?;
            Some(Package::new("uv", name, name, version))
        })
        .collect()
}

/// Parse `dotnet --list-sdks` (`8.0.100 [path]`) and `dotnet --list-runtimes`
/// (`Microsoft.NETCore.App 8.0.25 [path]`).
fn parse_dotnet_list(source: &str, out: &str) -> Vec<Package> {
    out.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let first = words.next()?;
            let (name, version) = if first.starts_with(|c: char| c.is_ascii_digit()) {
                (".NET SDK", first)
            } else {
                (first, words.next()?)
            };
            Some(Package::new(source, name, name, version))
        })
        .collect()
}

/// Parse `--list-extensions --show-versions` from VS Code or a fork: one
/// `publisher.name@1.2.3` per line.
fn parse_vscode(source: &str, out: &str) -> Vec<Package> {
    out.lines()
        .filter_map(|line| {
            let (id, version) = line.trim().rsplit_once('@')?;
            id.contains('.').then(|| Package::new(source, id, id, version))
        })
        .collect()
}

/// Rows of PowerShell 5.1's `ConvertTo-Csv -NoTypeInformation`, header
/// dropped. Every field is double-quoted with inner quotes doubled.
fn parse_csv(out: &str) -> Vec<Vec<String>> {
    out.lines()
        .skip_while(|line| !line.starts_with('"'))
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut fields = Vec::new();
            let mut field = String::new();
            let mut quoted = false;
            let mut chars = line.chars().peekable();
            while let Some(c) = chars.next() {
                match c {
                    '"' if quoted && chars.peek() == Some(&'"') => {
                        field.push('"');
                        chars.next();
                    }
                    '"' => quoted = !quoted,
                    ',' if !quoted => fields.push(std::mem::take(&mut field)),
                    _ => field.push(c),
                }
            }
            fields.push(field);
            fields
        })
        .collect()
}

/// Parse the Name,Version,Author,InstalledLocation CSV of `Get-InstalledModule`.
fn parse_psmodules(out: &str) -> Vec<Package> {
    parse_csv(out)
        .iter()
        .filter(|cols| !field(cols, 0).is_empty())
        .map(|cols| Package {
            publisher: field(cols, 2).to_string(),
            location: field(cols, 3).to_string(),
            ..Package::new("powershell", &cols[0], &cols[0], field(cols, 1))
        })
        .collect()
}

/// Parse the DisplayName,DisplayVersion,PSChildName,Publisher,InstallLocation,
/// InstallDate CSV of the uninstall keys. The key name is the id: a product
/// GUID or a plain name like `7-Zip`.
fn parse_registry(out: &str) -> Vec<Package> {
    parse_csv(out)
        .iter()
        .filter(|cols| !field(cols, 0).is_empty())
        .map(|cols| Package {
            publisher: field(cols, 3).trim().to_string(),
            location: field(cols, 4).trim().trim_matches('"').to_string(),
            updated: install_date(field(cols, 5)),
            ..Package::new("registry", &cols[0], field(cols, 2), field(cols, 1))
        })
        .collect()
}

/// Parse the Name,Version,PackageFamilyName CSV of `Get-AppxPackage`. The
/// name is the package name, like `Microsoft.WindowsCalculator`: the display
/// name lives in each app's manifest and is not read.
fn parse_store(out: &str) -> Vec<Package> {
    parse_csv(out)
        .iter()
        .filter(|cols| !field(cols, 0).is_empty())
        .map(|cols| Package::new("store", &cols[0], field(cols, 2), field(cols, 1)))
        .collect()
}

/// Parse `npm ls -g --depth=0 --json --long`:
/// `{"dependencies": {name: {version, path, author}}}`.
fn parse_npm(out: &str) -> Vec<Package> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(out) else {
        return Vec::new();
    };
    let Some(deps) = root.get("dependencies").and_then(|d| d.as_object()) else {
        return Vec::new();
    };
    deps.iter()
        .map(|(name, info)| {
            let text = |key: &str| info.get(key).and_then(|v| v.as_str()).unwrap_or_default();
            // `author` is "Name <email> (url)" or {"name": …}; only the name is kept.
            let author = info
                .get("author")
                .and_then(|a| a.as_str().or_else(|| a.get("name")?.as_str()))
                .and_then(|a| a.split(['<', '(']).next())
                .unwrap_or_default();
            Package {
                publisher: author.trim().to_string(),
                location: text("path").to_string(),
                ..Package::new("npm", name, name, text("version"))
            }
        })
        .collect()
}

/// Parse `pnpm ls -g --depth=0 --json`: an array of global projects, each
/// with the same `dependencies` map as npm.
fn parse_pnpm(out: &str) -> Vec<Package> {
    let Ok(projects) = serde_json::from_str::<Vec<serde_json::Value>>(out) else {
        return Vec::new();
    };
    projects
        .iter()
        .filter_map(|p| p.get("dependencies")?.as_object())
        .flatten()
        .map(|(name, info)| {
            let version = info.get("version").and_then(|v| v.as_str()).unwrap_or_default();
            Package::new("pnpm", name, name, version)
        })
        .collect()
}

/// Parse `pipx list --json`: `{"venvs": {name: {"metadata": {"main_package":
/// {"package": …, "package_version": …}}}}}`.
fn parse_pipx(out: &str) -> Vec<Package> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(out) else {
        return Vec::new();
    };
    let Some(venvs) = root.get("venvs").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    venvs
        .values()
        .filter_map(|venv| {
            let main = venv.pointer("/metadata/main_package")?;
            let name = main.get("package")?.as_str()?;
            let version = main.get("package_version").and_then(|v| v.as_str()).unwrap_or_default();
            Some(Package::new("pipx", name, name, version))
        })
        .collect()
}

/// Parse `conda env list --json`: `{"envs": [path, …]}`. An environment is
/// named after its folder and has no version of its own.
fn parse_conda(out: &str) -> Vec<Package> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(out) else {
        return Vec::new();
    };
    let Some(envs) = root.get("envs").and_then(|e| e.as_array()) else {
        return Vec::new();
    };
    envs.iter()
        .filter_map(|e| e.as_str())
        .map(|path| {
            let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
            Package::new("conda", name, path, "")
        })
        .collect()
}

/// Parse `pip list --format=json -v`: `[{"name": …, "version": …, "location": …}]`.
fn parse_pip(out: &str) -> Vec<Package> {
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(out) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|p| {
            let text = |key: &str| p.get(key).and_then(|v| v.as_str()).unwrap_or_default();
            let name = p.get("name")?.as_str()?;
            Some(Package { location: text("location").to_string(), ..Package::new("pip", name, name, text("version")) })
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates, publishers and install folders
// ─────────────────────────────────────────────────────────────────────────────

/// Anything before 2000 is a placeholder, such as the fixed 1985 date npm
/// writes into package tarballs.
fn plausible(secs: u64) -> Option<u64> {
    (secs >= 946_684_800).then_some(secs)
}

/// Last-modified time as Unix seconds. Reads a link itself rather than its
/// target, because Scoop re-points its `current` junction on every update.
fn modified(path: &Path) -> Option<u64> {
    let time = std::fs::symlink_metadata(path).ok()?.modified().ok()?;
    plausible(time.duration_since(UNIX_EPOCH).ok()?.as_secs())
}

/// An uninstall key's `InstallDate` as Unix seconds. Installers write
/// `YYYYMMDD`, and some write the US `M/D/YYYY`. Noon UTC keeps the calendar
/// day the same in every time zone.
fn install_date(s: &str) -> Option<u64> {
    let s = s.trim();
    let (y, m, d): (i64, i64, i64) = if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
        (s[..4].parse().ok()?, s[4..6].parse().ok()?, s[6..].parse().ok()?)
    } else {
        let mut parts = s.split('/').map(|p| p.parse::<i64>().ok());
        let (m, d, y) = (parts.next()??, parts.next()??, parts.next()??);
        if parts.next().is_some() {
            return None;
        }
        (y, m, d)
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    plausible(u64::try_from(days_from_civil(y, m, d)).ok()? * 86_400 + 43_200)
}

/// Days since 1970-01-01 for a Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn home() -> Option<PathBuf> {
    env_dir("USERPROFILE")
}

fn cargo_bin() -> PathBuf {
    env_dir("CARGO_HOME")
        .or_else(|| home().map(|h| h.join(".cargo")))
        .unwrap_or_default()
        .join("bin")
}

fn set_location(p: &mut Package, path: PathBuf) {
    if path.exists() {
        p.location = path.display().to_string();
    }
}

/// Fill in what a list command does not print, from the folders each manager
/// leaves on disk. Only file metadata is read, plus VS Code's extensions.json.
fn add_file_details(source: &str, pkgs: &mut [Package]) {
    match source {
        "pip" => return pip_details(pkgs),
        "vscode" | "code-insiders" | "cursor" | "codium" => vscode_details(source, pkgs),
        // An environment's id is its folder.
        "conda" => pkgs.iter_mut().for_each(|p| p.location = p.id.clone()),
        "choco" => {
            let lib = env_dir("ChocolateyInstall")
                .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData\chocolatey"))
                .join("lib");
            for p in pkgs.iter_mut() {
                let dir = lib.join(&p.id);
                set_location(p, dir);
            }
        }
        "scoop" => {
            let roots = [
                env_dir("SCOOP").or_else(|| home().map(|h| h.join("scoop"))),
                env_dir("SCOOP_GLOBAL").or_else(|| env_dir("ProgramData").map(|d| d.join("scoop"))),
            ];
            for p in pkgs.iter_mut() {
                let current = roots.iter().flatten().map(|r| r.join("apps").join(&p.id).join("current"));
                if let Some(dir) = current.into_iter().find(|c| c.exists()) {
                    p.location = dir.display().to_string();
                }
            }
        }
        "dotnet" => {
            if let Some(store) = home().map(|h| h.join(".dotnet").join("tools").join(".store")) {
                for p in pkgs.iter_mut() {
                    let dir = store.join(p.id.to_lowercase()).join(&p.version);
                    set_location(p, dir);
                }
            }
        }
        _ => {}
    }
    // Whatever has a folder and no date of its own takes the folder's.
    for p in pkgs.iter_mut().filter(|p| p.updated.is_none() && !p.location.is_empty()) {
        p.updated = modified(Path::new(&p.location));
    }
}

/// pip's location is the shared site-packages folder, so a package's own date
/// is its `.dist-info` folder there. An egg install points at the egg itself.
fn pip_details(pkgs: &mut [Package]) {
    let mut sites: HashMap<String, HashMap<String, PathBuf>> = HashMap::new();
    for p in pkgs.iter_mut().filter(|p| !p.location.is_empty()) {
        if p.location.to_ascii_lowercase().ends_with(".egg") {
            p.updated = modified(Path::new(&p.location));
            continue;
        }
        let infos = sites.entry(p.location.clone()).or_insert_with(|| dist_infos(Path::new(&p.location)));
        p.updated = infos.get(&pip_key(&p.name)).and_then(|dir| modified(dir));
    }
}

/// pip normalizes `-` and `.` in folder names to `_`, and case varies.
fn pip_key(name: &str) -> String {
    name.to_ascii_lowercase().replace(['-', '.'], "_")
}

/// `name-version.dist-info` (and older `.egg-info`) folders by normalized name.
fn dist_infos(site: &Path) -> HashMap<String, PathBuf> {
    std::fs::read_dir(site)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().into_string().ok()?;
            let stem = file.strip_suffix(".dist-info").or_else(|| file.strip_suffix(".egg-info"))?;
            Some((pip_key(stem.split_once('-')?.0), e.path()))
        })
        .collect()
}

/// VS Code and its forks record each extension's install time, publisher name
/// and folder in extensions.json beside the extension folders.
fn vscode_details(source: &str, pkgs: &mut [Package]) {
    let profile = match source {
        "code-insiders" => ".vscode-insiders",
        "cursor" => ".cursor",
        "codium" => ".vscode-oss",
        _ => ".vscode",
    };
    let custom = if source == "vscode" { env_dir("VSCODE_EXTENSIONS") } else { None };
    let Some(dir) = custom.or_else(|| home().map(|h| h.join(profile).join("extensions"))) else {
        return;
    };
    let entries: Vec<serde_json::Value> = std::fs::read_to_string(dir.join("extensions.json"))
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    for p in pkgs.iter_mut() {
        let entry = entries.iter().find(|e| {
            e.pointer("/identifier/id").and_then(|v| v.as_str()).is_some_and(|id| id.eq_ignore_ascii_case(&p.id))
                && e.get("version").and_then(|v| v.as_str()) == Some(p.version.as_str())
        });
        let meta = |key: &str| entry.and_then(|e| e.get("metadata")?.get(key));
        p.publisher = meta("publisherDisplayName")
            .and_then(|v| v.as_str())
            .or_else(|| p.id.split('.').next())
            .unwrap_or_default()
            .to_string();
        p.updated = meta("installedTimestamp").and_then(|v| v.as_u64()).and_then(|ms| plausible(ms / 1000));
        let folder = entry
            .and_then(|e| e.get("relativeLocation")?.as_str())
            .map_or_else(|| format!("{}-{}", p.id, p.version), str::to_string);
        set_location(p, dir.join(folder));
    }
}

/// winget reads the same uninstall keys as Installed apps but prints no date,
/// publisher or folder, so a winget row takes them from its matching key: by
/// key name for `ARP\…` ids, otherwise by name and version.
fn borrow_from_installed_apps(winget: &mut [Package], apps: &[Package]) {
    for w in winget.iter_mut() {
        let key = w.id.strip_prefix("ARP\\").and_then(|rest| rest.rsplit('\\').next());
        let Some(app) = apps.iter().find(|a| match key {
            Some(key) => a.id.eq_ignore_ascii_case(key),
            None => a.name.eq_ignore_ascii_case(&w.name) && a.version == w.version,
        }) else {
            continue;
        };
        if w.updated.is_none() {
            w.updated = app.updated;
        }
        if w.publisher.is_empty() {
            w.publisher = app.publisher.clone();
        }
        if w.location.is_empty() {
            w.location = app.location.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "runs where.exe for every source"]
    fn path_lookup_agrees_with_where_exe_on_this_pc() {
        for spec in SOURCES {
            let by_where = hidden("where.exe").arg(spec.argv[0]).output().unwrap().status.success();
            assert_eq!(is_in_path(spec.argv[0]), by_where, "{}", spec.argv[0]);
        }
    }

    // Real `winget list` output, trimmed. Note the blank Available cells and the
    // ARP entries whose Source column is empty.
    const WINGET_5COL: &str = "\
Name                           Id                        Version       Available   Source
-------------------------------------------------------------------------------------------
7-Zip 26.02 (x64)              7zip.7zip                 26.02                     winget
Adobe Photoshop 2022           ARP\\Machine\\X86\\PHSP_23   23.1.1.202
Git                            Git.Git                   2.44.0        2.51.0      winget
";

    // Same command when nothing has an upgrade. winget drops the Available column.
    const WINGET_4COL: &str = "\
Name                           Id                        Version       Source
-----------------------------------------------------------------------------
7-Zip 26.02 (x64)              7zip.7zip                 26.02         winget
";

    #[test]
    fn winget_columns_come_from_the_header_not_the_header_text() {
        let pkgs = parse_winget(WINGET_5COL);
        assert_eq!(pkgs.len(), 3);
        assert_eq!(pkgs[0].name, "7-Zip 26.02 (x64)");
        assert_eq!(pkgs[0].id, "7zip.7zip");
        assert_eq!(pkgs[0].version, "26.02");
        assert_eq!(pkgs[0].available, "");
        // A short row missing its trailing columns must not panic or bleed.
        assert_eq!(pkgs[1].name, "Adobe Photoshop 2022");
        assert_eq!(pkgs[1].version, "23.1.1.202");
        assert_eq!(pkgs[1].available, "");
        // The one package with an upgrade available, and the only one that
        // carries an upgrade command.
        assert_eq!(pkgs[2].name, "Git");
        assert_eq!(pkgs[2].available, "2.51.0");
        assert_eq!(
            pkgs[2].upgrade_command.as_deref(),
            Some("winget upgrade --id Git.Git --exact --accept-package-agreements --accept-source-agreements --disable-interactivity")
        );
        assert!(pkgs[0].upgrade_command.is_none());
        assert!(pkgs[1].upgrade_command.is_none());
    }

    #[test]
    fn only_plain_winget_ids_reach_the_upgrade_command() {
        for ok in ["Git.Git", "Microsoft.VisualStudioCode", "7zip.7zip", "Python.Python.3.12", "Notepad++.Notepad++", "JanDeDobbeleer.Oh-My-Posh"] {
            assert!(valid_winget_id(ok), "{ok}");
        }
        for bad in [
            "", "Git.Git & calc", "Git.Git|calc", "Git.Git\" --override \"x", "--source", "-x",
            "ARP\\Machine\\X64\\Foo", "Git Git", "Git.Git;calc", "%PATH%", "Gít.Git",
        ] {
            assert!(!valid_winget_id(bad), "{bad}");
        }
        assert!(!valid_winget_id(&"a".repeat(129)));
        // A row whose id fails the check gets no upgrade button, even with an update.
        let pkgs = parse_winget("\
Name        Id                     Version  Available  Source
-------------------------------------------------------------
Odd         ARP\\Machine\\X64\\Odd    1.0      2.0        winget
");
        assert_eq!(pkgs[0].available, "2.0");
        assert!(pkgs[0].upgrade_command.is_none());
    }

    #[test]
    fn winget_without_an_available_column_does_not_read_source_as_a_version() {
        let pkgs = parse_winget(WINGET_4COL);
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].version, "26.02");
        assert_eq!(pkgs[0].available, "", "Source must not be mistaken for Available");
    }

    #[test]
    fn winget_garbage_yields_nothing_rather_than_rows() {
        assert!(parse_winget("").is_empty());
        assert!(parse_winget("Failed when searching source; results will not be included").is_empty());
    }

    #[test]
    fn npm_reads_the_global_dependency_map() {
        let pkgs = parse_npm(r#"{"name":"local","dependencies":{"pnpm":{"version":"11.5.0"},"typescript":{"version":"5.8.2"}}}"#);
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0].name, "pnpm");
        assert_eq!(pkgs[0].version, "11.5.0");
        assert_eq!(pkgs[0].id, "pnpm");
        // npm exits non-zero with an error payload and no dependencies, so no rows,
        // which is what lets scan_one surface the exit code instead.
        assert!(parse_npm(r#"{"error":{"code":"ELSPROBLEMS"}}"#).is_empty());
    }

    #[test]
    fn pip_reads_the_json_list() {
        let pkgs = parse_pip(r#"[{"name": "requests", "version": "2.32.3"}, {"name": "pip", "version": "26.1.1"}]"#);
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[1].name, "pip");
        assert_eq!(pkgs[1].version, "26.1.1");
        assert!(parse_pip("WARNING: pip is being invoked by an old script wrapper").is_empty());
    }

    #[test]
    fn every_command_pastes_into_powershell_and_cmd_unchanged() {
        // `$` and backtick expand inside PowerShell's double quotes, `%` expands
        // under cmd, and a `"` would break the quoting command_line adds.
        for spec in SOURCES {
            for arg in spec.argv {
                assert!(!arg.contains(['$', '`', '%', '"']), "{}: {arg}", spec.id);
            }
        }
        assert_eq!(
            command_line(&["powershell", "-Command", "Get-InstalledModule | ConvertTo-Csv"]),
            r#"powershell -Command "Get-InstalledModule | ConvertTo-Csv""#
        );
    }

    #[test]
    fn uninstall_ids_are_checked_per_manager() {
        for (source, ok) in [
            ("pip", "charset-normalizer"), ("pip", "zope.interface"), ("npm", "pnpm"),
            ("npm", "@anthropic-ai/claude-code"), ("vscode", "ms-python.python"), ("winget", "Ditto.Ditto"),
        ] {
            assert!(valid_id(source, ok), "{source} {ok}");
        }
        for (source, bad) in [
            ("pip", "requests & calc"), ("pip", "-r"), ("pip", "x;y"), ("npm", "@scope"), ("npm", "@/x"),
            ("npm", "@a/b/c"), ("npm", "%PATH%"), ("vscode", "nodot"), ("vscode", "a.b c"),
            ("cargo", "ripgrep"), ("registry", "7-Zip"), ("winget", "ARP\\Machine\\X64\\Foo"),
        ] {
            assert!(!valid_id(source, bad), "{source} {bad}");
        }
    }

    #[test]
    fn uninstall_commands_are_fixed_and_pin_a_version_only_for_winget() {
        assert_eq!(
            uninstall_argv("winget", "Ditto.Ditto", Some("3.24.238.0")).map(|a| command_line(&a)).as_deref(),
            Some("winget uninstall --id Ditto.Ditto --exact --accept-source-agreements --disable-interactivity --version 3.24.238.0")
        );
        assert_eq!(uninstall_argv("pip", "certifi", Some("1.0")), Some(vec!["pip", "uninstall", "--yes", "certifi"]));
        assert_eq!(uninstall_argv("npm", "pnpm", None), Some(vec!["npm.cmd", "uninstall", "--global", "pnpm"]));
        assert_eq!(uninstall_argv("vscode", "a.b", None), Some(vec!["code.cmd", "--uninstall-extension", "a.b"]));
        // A truncated or odd winget version is refused rather than passed on.
        assert_eq!(uninstall_argv("winget", "Ditto.Ditto", Some("3.24…")), None);
        assert_eq!(uninstall_argv("winget", "Ditto.Ditto", Some("< 1.0")), None);
        assert_eq!(uninstall_argv("cargo", "ripgrep", None), None);
        for argv in [
            uninstall_argv("winget", "Git.Git", Some("2.51.0")),
            uninstall_argv("npm", "@scope/name", None),
        ] {
            assert!(argv.unwrap().iter().all(|a| !a.contains(['$', '`', '%', '"', ' ', '&', '|'])));
        }
    }

    #[test]
    fn reinstall_commands_restore_the_removed_version() {
        assert_eq!(reinstall_command("pip", "certifi", "2024.8.30"), "pip install certifi==2024.8.30");
        assert_eq!(reinstall_command("npm", "@a/b", "1.2.3"), "npm.cmd install --global @a/b@1.2.3");
        assert_eq!(reinstall_command("vscode", "a.b", "0.4.5"), "code.cmd --install-extension a.b@0.4.5");
        assert_eq!(reinstall_command("winget", "Ditto.Ditto", "3.24.238.0"), "winget install --id Ditto.Ditto --exact --version 3.24.238.0");
        assert_eq!(reinstall_command("winget", "X.Y", "< 1.0"), "winget install --id X.Y --exact");
    }

    #[test]
    fn core_tools_match_whole_id_segments() {
        assert!(is_core("winget", "Python.Python.3.12"));
        assert!(is_core("winget", "git.git"));
        assert!(is_core("npm", "pnpm"));
        assert!(!is_core("winget", "Git.GitLFS"));
        assert!(!is_core("pip", "pipx"));
        assert!(!is_core("npm", "pip"));
    }

    #[test]
    fn running_processes_are_matched_by_install_folder() {
        let procs = vec![
            ("Ditto.exe".to_string(), r"C:\Program Files\Ditto\Ditto.exe".to_string()),
            ("Ditto.exe".to_string(), r"c:\program files\ditto\Ditto.exe".to_string()),
            ("DittoX.exe".to_string(), r"C:\Program Files\DittoX\DittoX.exe".to_string()),
            ("explorer.exe".to_string(), r"C:\Windows\explorer.exe".to_string()),
        ];
        assert_eq!(processes_under(&procs, &[r#""C:\Program Files\Ditto\""#.to_string()]), vec!["Ditto.exe"]);
        // A drive root as InstallLocation would match everything, so it is ignored.
        assert!(processes_under(&procs, &["C:\\".to_string()]).is_empty());
    }

    #[test]
    fn pip_show_yields_dependents_commands_and_file_count() {
        let (needed_by, commands, files) = parse_pip_show("\
Name: charset-normalizer
Version: 3.4.1
Location: C:\\Python311\\Lib\\site-packages
Requires:
Required-by: reportlab, requests
Files:
  ..\\..\\Scripts\\normalizer.exe
  charset_normalizer-3.4.1.dist-info\\INSTALLER
  charset_normalizer\\__init__.py
");
        assert_eq!(needed_by, vec!["reportlab", "requests"]);
        assert_eq!(commands, vec!["normalizer"]);
        assert_eq!(files, 3);
        let (needed_by, _, _) = parse_pip_show("Name: pip\nRequired-by: \nFiles:\n  pip\\__init__.py\n");
        assert!(needed_by.is_empty());
    }

    #[test]
    fn npm_bin_names_the_commands_a_package_adds() {
        assert_eq!(npm_bin_commands(r#"{"bin":{"pnpm":"bin/pnpm.cjs","pnpx":"bin/pnpx.cjs"}}"#, "pnpm"), vec!["pnpm", "pnpx"]);
        assert_eq!(npm_bin_commands(r#"{"bin":"cli.js"}"#, "@anthropic-ai/claude-code"), vec!["claude-code"]);
        assert!(npm_bin_commands(r#"{"name":"lib-only"}"#, "lib-only").is_empty());
    }

    #[test]
    fn vscode_dependents_come_from_dependencies_and_packs() {
        let manifests = [
            r#"{"publisher":"ms-python","name":"debugpy","extensionDependencies":["ms-python.python"]}"#,
            r#"{"publisher":"ms-python","name":"debugpy","extensionDependencies":["MS-Python.Python"]}"#,
            r#"{"publisher":"x","name":"pack","extensionPack":["ms-python.python","y.z"]}"#,
            r#"{"publisher":"ms-python","name":"python","extensionPack":["ms-python.python"]}"#,
            r#"{"publisher":"a","name":"unrelated"}"#,
        ];
        let deps = vscode_dependents(manifests.iter().map(|m| m.to_string()), "ms-python.python");
        assert_eq!(deps, vec!["ms-python.debugpy", "x.pack"]);
    }

    #[test]
    fn pip_check_lines_are_matched_on_the_whole_name() {
        let out = "\
requests 2.32.3 requires charset_normalizer, which is not installed.
requests-toolbelt 1.0.0 requires requests, which is not installed.
oauth 1.0 requires requests-oauthlib, which is not installed.
";
        assert_eq!(broken_requirements(out, "charset-normalizer"), vec!["requests 2.32.3 requires charset_normalizer, which is not installed."]);
        assert_eq!(
            broken_requirements(out, "requests"),
            vec![
                "requests 2.32.3 requires charset_normalizer, which is not installed.",
                "requests-toolbelt 1.0.0 requires requests, which is not installed.",
            ]
        );
        assert!(broken_requirements("No broken requirements found.", "requests").is_empty());
        // What an upgrade breaks: another package's version limit, or its own.
        let conflict = "reportlab 4.4 has requirement charset-normalizer<4, but you have charset-normalizer 5.0.";
        assert_eq!(broken_requirements(conflict, "charset_normalizer"), vec![conflict]);
        assert_eq!(broken_requirements(conflict, "reportlab"), vec![conflict]);
        assert!(broken_requirements(conflict, "charset").is_empty());
    }

    #[test]
    fn upgrade_commands_are_exact_and_refuse_odd_ids() {
        assert_eq!(upgrade_command("pip", "certifi").as_deref(), Some("pip install --upgrade certifi"));
        assert_eq!(upgrade_command("npm", "@scope/tool").as_deref(), Some("npm.cmd install --global @scope/tool"));
        assert_eq!(
            upgrade_command("choco", "git.install").as_deref(),
            Some("powershell -NoProfile -NonInteractive -Command \"exit (Start-Process choco -Verb RunAs -Wait -PassThru -ArgumentList 'upgrade git.install --yes').ExitCode\"")
        );
        // These would break out of the quoted string that runs elevated.
        for bad in ["a'b", "a b", "a;calc", "--force", "a$b", "a`b", ""] {
            assert!(upgrade_command("choco", bad).is_none(), "{bad}");
        }
        assert!(upgrade_command("vscode", "ms-python.python").is_none());
        assert!(upgrade_command("nope", "certifi").is_none());
    }

    #[test]
    fn admin_commands_keep_the_exact_arguments() {
        assert_eq!(
            command_line(&as_admin(&["pip", "install", "--upgrade", "ninja"])),
            "powershell -NoProfile -NonInteractive -Command \"exit (Start-Process pip -Verb RunAs -Wait -PassThru -ArgumentList 'install --upgrade ninja').ExitCode\""
        );
        assert!(!needs_admin("npm"));
        assert!(!needs_admin("choco"));
    }

    #[test]
    fn the_write_test_reports_access_and_leaves_nothing_behind() {
        let folder = std::env::temp_dir().join(format!("atlas-write-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        assert!(can_create_files_in(&folder));
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
        std::fs::remove_dir(&folder).unwrap();
        assert!(!can_create_files_in(&folder));
    }

    #[test]
    fn choco_outdated_skips_pinned_and_packages_it_could_not_look_up() {
        let out = "\
visualstudio2019buildtools|16.11.61|16.11.62|false
chocolatey|2.7.5|2.7.5|false
git|2.40.0|2.51.0|true
Some warning without columns
";
        assert_eq!(
            parse_choco_outdated(out),
            vec![("visualstudio2019buildtools".to_string(), "16.11.62".to_string())]
        );
    }

    #[test]
    fn npm_outdated_reads_updates_and_reports_a_network_error() {
        let out = r#"{
            "pnpm": {"current": "11.5.0", "wanted": "12.16.1", "latest": "12.16.1"},
            "error": {"current": "1.0.0", "latest": "2.0.0"},
            "same": {"current": "1.0.0", "latest": "1.0.0"},
            "missing": {"wanted": "1.0.0", "latest": "1.0.0"}
        }"#;
        assert_eq!(
            parse_npm_outdated(out),
            Ok(vec![("error".to_string(), "2.0.0".to_string()), ("pnpm".to_string(), "12.16.1".to_string())])
        );
        assert_eq!(parse_npm_outdated(""), Ok(Vec::new()));
        assert_eq!(
            parse_npm_outdated(r#"{"error": {"code": "ENOTFOUND", "summary": "request failed"}}"#),
            Err("request failed".to_string())
        );
    }

    #[test]
    fn pip_outdated_reads_name_and_latest_version() {
        let out = r#"[{"name": "ImageIO", "version": "2.37.3", "latest_version": "2.38.1", "latest_filetype": "wheel"}]"#;
        assert_eq!(parse_pip_outdated(out), vec![("ImageIO".to_string(), "2.38.1".to_string())]);
        assert!(parse_pip_outdated("[]").is_empty());
        assert!(parse_pip_outdated("not json").is_empty());
    }

    #[test]
    fn dotnet_reads_the_same_table_shape_as_winget() {
        let pkgs = parse_dotnet("\
Package Id      Version      Commands
-------------------------------------
dotnet-ef       8.0.0        dotnet-ef
");
        assert_eq!(pkgs, vec![Package::new("dotnet", "dotnet-ef", "dotnet-ef", "8.0.0")]);
        // No tools installed: header and rule only.
        assert!(parse_dotnet("Package Id      Version      Commands\n-------------------------------------\n").is_empty());
    }

    #[test]
    fn choco_reads_limit_output_lines() {
        let pkgs = parse_choco("chocolatey|2.7.5\r\nchocolatey-core.extension|1.4.0\r\n");
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0], Package::new("choco", "chocolatey", "chocolatey", "2.7.5"));
        assert!(parse_choco("Chocolatey v2.7.5\n0 packages installed.").is_empty());
    }

    #[test]
    fn scoop_reads_the_export_json_after_any_warning() {
        let pkgs = parse_scoop(r#"WARN  Scoop is out of date. Run 'scoop update' to get the latest changes.
{"buckets":[{"Name":"main"}],"apps":[{"Info":"","Source":"main","Name":"7zip","Version":"26.00","Updated":"2026-01-01"}]}"#);
        assert_eq!(pkgs, vec![Package::new("scoop", "7zip", "7zip", "26.00")]);
        assert!(parse_scoop("7zip 19.00 [main]").is_empty());
    }

    #[test]
    fn cargo_reads_crate_lines_and_locates_the_first_binary() {
        let pkgs = parse_cargo("\
ripgrep v14.1.0:
    rg.exe
tauri-cli v2.11.2:
    cargo-tauri.exe
mytool v0.1.0 (C:\\src\\my tool):
    mytool.exe
    mytool-helper.exe
", Path::new(r"C:\cargo\bin"));
        assert_eq!(pkgs.len(), 3);
        assert_eq!(pkgs[0], Package { location: r"C:\cargo\bin\rg.exe".into(), ..Package::new("cargo", "ripgrep", "ripgrep", "14.1.0") });
        assert_eq!(pkgs[2].name, "mytool");
        assert_eq!(pkgs[2].version, "0.1.0");
        assert_eq!(pkgs[2].location, r"C:\cargo\bin\mytool.exe");
    }

    #[test]
    fn vscode_splits_on_the_last_at_sign() {
        let pkgs = parse_vscode("vscode", "anthropic.claude-code@2.1.314\r\nms-python.python@2026.1.0\r\n");
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0], Package::new("vscode", "anthropic.claude-code", "anthropic.claude-code", "2.1.314"));
        assert!(parse_vscode("vscode", "Warning: 'list-extensions' is not in the list of known options").is_empty());
    }

    #[test]
    fn vscode_forks_keep_their_own_source_and_cannot_be_uninstalled() {
        for fork in ["code-insiders", "cursor", "codium"] {
            let pkgs = parse_packages(fork, "ms-python.python@2026.1.0\r\n");
            assert_eq!(pkgs, vec![Package::new(fork, "ms-python.python", "ms-python.python", "2026.1.0")]);
            assert!(uninstall_argv(fork, "ms-python.python", None).is_none());
        }
        // VSCodium with no extensions prints nothing and exits 0.
        assert!(parse_packages("codium", "").is_empty());
    }

    #[test]
    fn pnpm_collects_dependencies_from_every_global_project() {
        // Real pnpm 11 output with no global packages.
        let empty = r#"[
  {
    "path": "C:\\Users\\me\\AppData\\Local\\pnpm\\global\\v11",
    "private": true,
    "dependencies": {}
  }
]"#;
        assert!(parse_pnpm(empty).is_empty());
        let pkgs = parse_pnpm(r#"[{"path":"a","dependencies":{"typescript":{"from":"typescript","version":"5.8.2"}}},
            {"path":"b","dependencies":{"@biomejs/biome":{"version":"2.1.0"}}}]"#);
        assert_eq!(pkgs, vec![
            Package::new("pnpm", "typescript", "typescript", "5.8.2"),
            Package::new("pnpm", "@biomejs/biome", "@biomejs/biome", "2.1.0"),
        ]);
        assert!(parse_pnpm("[ERROR] The configured global bin directory is not in PATH").is_empty());
    }

    #[test]
    fn pipx_reads_each_venv_main_package() {
        let pkgs = parse_pipx(r#"{"pipx_spec_version": "0.1", "venvs": {"black": {"metadata": {
            "injected_packages": {}, "main_package": {"app_paths": [], "package": "black",
            "package_or_url": "black", "package_version": "24.2.0"}, "python_version": "Python 3.12.1"}}}}"#);
        assert_eq!(pkgs, vec![Package::new("pipx", "black", "black", "24.2.0")]);
        assert!(parse_pipx(r#"{"pipx_spec_version": "0.1", "venvs": {}}"#).is_empty());
    }

    #[test]
    fn uv_reads_tool_lines_and_skips_their_commands() {
        let pkgs = parse_uv("black v24.2.0\n- black.exe\n- blackd.exe\nruff v0.6.9\n- ruff.exe\n");
        assert_eq!(pkgs, vec![
            Package::new("uv", "black", "black", "24.2.0"),
            Package::new("uv", "ruff", "ruff", "0.6.9"),
        ]);
        assert!(parse_uv("No tools installed").is_empty());
    }

    #[test]
    fn conda_names_environments_after_their_folder() {
        let pkgs = parse_conda(r#"{"envs": ["C:\\Users\\me\\miniconda3", "C:\\Users\\me\\miniconda3\\envs\\ml"]}"#);
        assert_eq!(pkgs, vec![
            Package::new("conda", "miniconda3", "C:\\Users\\me\\miniconda3", ""),
            Package::new("conda", "ml", "C:\\Users\\me\\miniconda3\\envs\\ml", ""),
        ]);
        assert!(parse_conda("").is_empty());
    }

    #[test]
    fn gem_takes_the_newest_version_without_default_or_platform() {
        let pkgs = parse_gem("\n*** LOCAL GEMS ***\n\nbundler (default: 2.5.11, 2.4.10)\nnokogiri (1.16.7 x64-mingw-ucrt)\nrake (13.2.1)\n");
        assert_eq!(pkgs, vec![
            Package::new("gem", "bundler", "bundler", "2.5.11"),
            Package::new("gem", "nokogiri", "nokogiri", "1.16.7"),
            Package::new("gem", "rake", "rake", "13.2.1"),
        ]);
    }

    #[test]
    fn rustup_reads_the_channel_ahead_of_the_host_triple() {
        // Real output.
        let pkgs = parse_rustup("stable-x86_64-pc-windows-msvc (active, default)\n1.98.0-x86_64-pc-windows-msvc\n");
        assert_eq!(pkgs, vec![
            Package::new("rustup", "stable-x86_64-pc-windows-msvc", "stable-x86_64-pc-windows-msvc", "stable"),
            Package::new("rustup", "1.98.0-x86_64-pc-windows-msvc", "1.98.0-x86_64-pc-windows-msvc", "1.98.0"),
        ]);
        assert_eq!(parse_rustup("nightly-2026-01-01-aarch64-pc-windows-msvc")[0].version, "nightly-2026-01-01");
        // A linked custom toolchain has no triple, so no channel.
        assert_eq!(parse_rustup("mytc")[0].version, "");
        assert!(parse_rustup("no installed toolchains\n").is_empty());
    }

    #[test]
    fn dotnet_lists_name_sdks_and_runtimes() {
        // Real `dotnet --list-runtimes` output, trimmed.
        let pkgs = parse_dotnet_list("dotnet-runtime", "\
Microsoft.NETCore.App 8.0.25 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]
Microsoft.WindowsDesktop.App 10.0.14 [C:\\Program Files\\dotnet\\shared\\Microsoft.WindowsDesktop.App]
");
        assert_eq!(pkgs, vec![
            Package::new("dotnet-runtime", "Microsoft.NETCore.App", "Microsoft.NETCore.App", "8.0.25"),
            Package::new("dotnet-runtime", "Microsoft.WindowsDesktop.App", "Microsoft.WindowsDesktop.App", "10.0.14"),
        ]);
        let sdks = parse_dotnet_list("dotnet-sdk", "8.0.100 [C:\\Program Files\\dotnet\\sdk]\r\n");
        assert_eq!(sdks, vec![Package::new("dotnet-sdk", ".NET SDK", ".NET SDK", "8.0.100")]);
        // A machine with only runtimes prints nothing for --list-sdks.
        assert!(parse_dotnet_list("dotnet-sdk", "").is_empty());
    }

    #[test]
    fn store_uses_the_package_family_as_the_id() {
        // Real output, trimmed.
        let pkgs = parse_store("\
\"Name\",\"Version\",\"PackageFamilyName\"
\"Microsoft.MicrosoftStickyNotes\",\"4.0.6104.0\",\"Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe\"
\"Microsoft.Xbox.TCUI\",\"1.24.10001.0\",\"Microsoft.Xbox.TCUI_8wekyb3d8bbwe\"
");
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0], Package::new(
            "store", "Microsoft.MicrosoftStickyNotes", "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe", "4.0.6104.0",
        ));
        assert!(parse_store("").is_empty());
    }

    #[test]
    fn csv_handles_quotes_commas_and_empty_fields() {
        let rows = parse_csv("\
\"DisplayName\",\"DisplayVersion\",\"PSChildName\"
\"7-Zip 26.05 (x64)\",\"26.05\",\"7-Zip\"
\"Example, Inc. \"\"Pro\"\" Tools\",\"\",\"{00000000-0000-0000-0000-000000000000}\"
");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1], vec!["Example, Inc. \"Pro\" Tools", "", "{00000000-0000-0000-0000-000000000000}"]);
    }

    #[test]
    fn registry_uses_the_key_name_as_the_id() {
        let pkgs = parse_registry("\"DisplayName\",\"DisplayVersion\",\"PSChildName\"\r\n\"7-Zip 26.05 (x64)\",\"26.05\",\"7-Zip\"\r\n");
        assert_eq!(pkgs, vec![Package::new("registry", "7-Zip 26.05 (x64)", "7-Zip", "26.05")]);
    }

    #[test]
    fn psmodules_read_name_and_version_and_nothing_from_an_empty_list() {
        let pkgs = parse_psmodules("\"Name\",\"Version\"\r\n\"PSReadLine\",\"2.3.6\"\r\n");
        assert_eq!(pkgs, vec![Package::new("powershell", "PSReadLine", "PSReadLine", "2.3.6")]);
        // Get-InstalledModule with nothing installed prints nothing at all.
        assert!(parse_psmodules("").is_empty());
    }

    #[test]
    fn psmodules_read_author_and_folder() {
        let pkgs = parse_psmodules("\
\"Name\",\"Version\",\"Author\",\"InstalledLocation\"
\"Pester\",\"5.6.1\",\"Pester Team\",\"C:\\Program Files\\WindowsPowerShell\\Modules\\Pester\\5.6.1\"
");
        assert_eq!(pkgs[0].publisher, "Pester Team");
        assert_eq!(pkgs[0].location, r"C:\Program Files\WindowsPowerShell\Modules\Pester\5.6.1");
    }

    #[test]
    fn registry_reads_publisher_folder_and_install_date() {
        let pkgs = parse_registry("\
\"DisplayName\",\"DisplayVersion\",\"PSChildName\",\"Publisher\",\"InstallLocation\",\"InstallDate\"
\"ShareX\",\"21.0.0\",\"ShareX_is1\",\"ShareX Team\",\"C:\\Program Files\\ShareX\\\",\"20240105\"
\"Odd App\",\"1.0\",\"OddApp\",,\"\"\"C:\\Odd App\"\"\",\"Thu Dec 15 22:47:03 2022\"
");
        assert_eq!(pkgs[0].publisher, "ShareX Team");
        assert_eq!(pkgs[0].location, r"C:\Program Files\ShareX\");
        assert_eq!(pkgs[0].updated, Some(1_704_456_000));
        // Quoted paths lose their quotes; an unreadable date is no date.
        assert_eq!(pkgs[1].location, r"C:\Odd App");
        assert_eq!(pkgs[1].updated, None);
        assert_eq!(pkgs[1].publisher, "");
    }

    #[test]
    fn install_dates_read_both_formats_at_noon_utc() {
        assert_eq!(install_date("20240105"), Some(1_704_456_000));
        assert_eq!(install_date("1/14/2023"), Some(1_673_697_600));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        for bad in ["", "2024", "20241301", "14/1/2023", "1/2/3/4", "19850101", "Thu Dec 15 22:47:03 2022"] {
            assert_eq!(install_date(bad), None, "{bad}");
        }
    }

    #[test]
    fn npm_reads_folder_and_author_name_only() {
        let pkgs = parse_npm(r#"{"dependencies":{
            "npm":{"version":"11.7.0","path":"C:\\usr\\local\\node_modules\\npm","author":"GitHub Inc."},
            "np":{"version":"10.0.0","path":"C:\\n\\np","author":"Jane Doe <jane@example.com> (https://example.com)"},
            "x":{"version":"1.0.0","author":{"name":"Someone","email":"someone@example.com"}}}}"#);
        let by = |name: &str| pkgs.iter().find(|p| p.name == name).unwrap();
        assert_eq!(by("npm").location, r"C:\usr\local\node_modules\npm");
        assert_eq!(by("npm").publisher, "GitHub Inc.");
        assert_eq!(by("np").publisher, "Jane Doe");
        assert_eq!(by("x").publisher, "Someone");
        assert_eq!(by("x").location, "");
    }

    #[test]
    fn pip_keys_match_normalized_dist_info_names() {
        let pkgs = parse_pip(r#"[{"name": "Jinja2", "version": "3.1.6", "location": "C:\\Python311\\Lib\\site-packages"}]"#);
        assert_eq!(pkgs[0].location, r"C:\Python311\Lib\site-packages");
        assert_eq!(pip_key("Jinja2"), pip_key("jinja2"));
        assert_eq!(pip_key("zope.interface"), pip_key("zope_interface"));
        assert_eq!(pip_key("typing-extensions"), "typing_extensions");
    }

    #[test]
    fn winget_rows_borrow_from_their_installed_app() {
        let mut winget = vec![
            Package::new("winget", "Adobe Photoshop 2022", r"ARP\Machine\X86\PHSP_23_1_1", "23.1.1.202"),
            Package::new("winget", "Discord", "Discord.Discord", "1.0.9261"),
            Package::new("winget", "Git", "Git.Git", "2.47.0"),
        ];
        let app = |name: &str, id: &str, version: &str| Package {
            updated: Some(1_704_456_000),
            publisher: format!("{name} Inc."),
            location: format!(r"C:\Apps\{name}"),
            ..Package::new("registry", name, id, version)
        };
        let apps = vec![
            app("Photoshop", "phsp_23_1_1", "23.1"),
            app("Discord", "Discord", "1.0.9261"),
            app("Git", "Git_is1", "2.51.0"),
        ];
        borrow_from_installed_apps(&mut winget, &apps);
        // The ARP key matches regardless of name, case or version.
        assert_eq!(winget[0].publisher, "Photoshop Inc.");
        assert_eq!(winget[1].updated, Some(1_704_456_000));
        assert_eq!(winget[1].location, r"C:\Apps\Discord");
        // A different version is a different install.
        assert_eq!(winget[2].updated, None);
        assert_eq!(winget[2].publisher, "");
    }
}
