//! Package Scanner: enumerates what is installed across the machine's package
//! managers.
//!
//! Read-only by design: every command in this module lists. Nothing here
//! installs, upgrades, or removes, and no user-supplied string ever reaches a
//! command line. The frontend selects sources by id, and the argv for each id
//! is a compile-time constant.

use std::process::Command;
use std::thread;

use tauri::Emitter;

use crate::docker::is_in_path;
use crate::shell::ShellOut;
use crate::error::AtlasError;

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
    /// the executable probed with `where.exe` to decide whether the source
    /// exists on this machine.
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
        argv: &["npm", "ls", "-g", "--depth=0", "--json"],
    },
    SourceSpec {
        id: "pip",
        label: "pip",
        argv: &["pip", "list", "--format=json"],
    },
    SourceSpec {
        id: "cargo",
        label: "Cargo",
        argv: &["cargo", "install", "--list"],
    },
    SourceSpec {
        id: "dotnet",
        label: ".NET tools",
        argv: &["dotnet", "tool", "list", "-g"],
    },
    SourceSpec {
        id: "powershell",
        label: "PowerShell",
        argv: &[
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            "Get-InstalledModule | Select-Object Name,Version | ConvertTo-Csv -NoTypeInformation",
        ],
    },
    SourceSpec {
        id: "vscode",
        label: "VS Code",
        argv: &["code", "--list-extensions", "--show-versions"],
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
             | Select-Object DisplayName,DisplayVersion,PSChildName | ConvertTo-Csv -NoTypeInformation",
        ],
    },
];

/// The argv as one line that pastes into PowerShell or cmd. Arguments with
/// spaces are double-quoted, which is also how Rust hands them to `cmd /C`.
fn command_line(argv: &[&str]) -> String {
    argv.iter()
        .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.to_string() })
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
    /// the registry key for installed apps). Equal to `name` elsewhere.
    pub id: String,
    pub version: String,
    /// Newer version the manager reports as installable. Empty when the source
    /// does not report it in a plain list (everything but winget) or nothing is
    /// available.
    pub available: String,
    /// Scanner source id, one of the `SOURCES` ids.
    pub source: String,
}

impl Package {
    fn new(source: &str, name: &str, id: &str, version: &str) -> Self {
        Package {
            name: name.to_string(),
            id: id.to_string(),
            version: version.to_string(),
            available: String::new(),
            source: source.to_string(),
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
    let mut c = Command::new("cmd");
    c.arg("/C").args(argv);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, no flashing console
    }
    let out = c
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
            // dotnet is on PATH with only a runtime, but global tools need an SDK.
            if spec.id == "dotnet" && stderr.contains("No .NET SDKs were found") {
                result.installed = false;
                return result;
            }
            result.packages = parse_packages(spec.id, &stdout);
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
        return Err("No known package sources selected".to_string().into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SourceResult>, AtlasError> {
        for spec in &specs {
            emit_line(&app, format!("$ {}", command_line(spec.argv)), false);
        }

        let results: Vec<SourceResult> = thread::scope(|scope| {
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
                        error: Some("scan thread panicked".to_string()),
                    })
                })
                .collect()
        });

        for r in &results {
            if !r.installed {
                emit_line(&app, format!("  # {} not found, skipped", r.label), false);
            } else if let Some(err) = &r.error {
                emit_line(&app, format!("  ✗ {}: {}", r.id, err), true);
            } else {
                emit_line(&app, format!("  ✓ {}: {} packages", r.id, r.packages.len()), false);
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
// Parsers
// ─────────────────────────────────────────────────────────────────────────────

fn parse_packages(source: &str, stdout: &str) -> Vec<Package> {
    match source {
        "winget" => parse_winget(stdout),
        "choco" => parse_choco(stdout),
        "scoop" => parse_scoop(stdout),
        "npm" => parse_npm(stdout),
        "pip" => parse_pip(stdout),
        "cargo" => parse_cargo(stdout),
        "dotnet" => parse_dotnet(stdout),
        "powershell" => parse_psmodules(stdout),
        "vscode" => parse_vscode(stdout),
        "registry" => parse_registry(stdout),
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
        .map(|cols| Package {
            available: if has_available { field(cols, 3).to_string() } else { String::new() },
            ..Package::new("winget", &cols[0], field(cols, 1), field(cols, 2))
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
/// binaries on indented lines.
fn parse_cargo(out: &str) -> Vec<Package> {
    out.lines()
        .filter(|line| !line.starts_with(char::is_whitespace))
        .filter_map(|line| {
            let (name, rest) = line.trim_end().strip_suffix(':')?.split_once(' ')?;
            let version = rest.split(' ').next()?.trim_start_matches('v');
            Some(Package::new("cargo", name, name, version))
        })
        .collect()
}

/// Parse `code --list-extensions --show-versions`: one `publisher.name@1.2.3`
/// per line.
fn parse_vscode(out: &str) -> Vec<Package> {
    out.lines()
        .filter_map(|line| {
            let (id, version) = line.trim().rsplit_once('@')?;
            id.contains('.').then(|| Package::new("vscode", id, id, version))
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

/// Parse the Name,Version CSV of `Get-InstalledModule`.
fn parse_psmodules(out: &str) -> Vec<Package> {
    parse_csv(out)
        .iter()
        .filter(|cols| !field(cols, 0).is_empty())
        .map(|cols| Package::new("powershell", &cols[0], &cols[0], field(cols, 1)))
        .collect()
}

/// Parse the DisplayName,DisplayVersion,PSChildName CSV of the uninstall keys.
/// The key name is the id: a product GUID or a plain name like `7-Zip`.
fn parse_registry(out: &str) -> Vec<Package> {
    parse_csv(out)
        .iter()
        .filter(|cols| !field(cols, 0).is_empty())
        .map(|cols| Package::new("registry", &cols[0], field(cols, 2), field(cols, 1)))
        .collect()
}

/// Parse `npm ls -g --depth=0 --json`: `{"dependencies": {name: {version}}}`.
fn parse_npm(out: &str) -> Vec<Package> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(out) else {
        return Vec::new();
    };
    let Some(deps) = root.get("dependencies").and_then(|d| d.as_object()) else {
        return Vec::new();
    };
    deps.iter()
        .map(|(name, info)| Package {
            name: name.clone(),
            id: name.clone(),
            version: info
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            available: String::new(),
            source: "npm".to_string(),
        })
        .collect()
}

/// Parse `pip list --format=json`: `[{"name": …, "version": …}]`.
fn parse_pip(out: &str) -> Vec<Package> {
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(out) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|p| {
            let name = p.get("name")?.as_str()?.to_string();
            Some(Package {
                id: name.clone(),
                version: p
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                available: String::new(),
                source: "pip".to_string(),
                name,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // The one package with an upgrade available.
        assert_eq!(pkgs[2].name, "Git");
        assert_eq!(pkgs[2].available, "2.51.0");
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
    fn cargo_reads_crate_lines_and_skips_binaries() {
        let pkgs = parse_cargo("\
ripgrep v14.1.0:
    rg.exe
tauri-cli v2.11.2:
    cargo-tauri.exe
mytool v0.1.0 (C:\\src\\my tool):
    mytool.exe
");
        assert_eq!(pkgs.len(), 3);
        assert_eq!(pkgs[0], Package::new("cargo", "ripgrep", "ripgrep", "14.1.0"));
        assert_eq!(pkgs[2].name, "mytool");
        assert_eq!(pkgs[2].version, "0.1.0");
    }

    #[test]
    fn vscode_splits_on_the_last_at_sign() {
        let pkgs = parse_vscode("anthropic.claude-code@2.1.314\r\nms-python.python@2026.1.0\r\n");
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0], Package::new("vscode", "anthropic.claude-code", "anthropic.claude-code", "2.1.314"));
        assert!(parse_vscode("Warning: 'list-extensions' is not in the list of known options").is_empty());
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
}
