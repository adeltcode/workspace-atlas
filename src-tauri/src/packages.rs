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
        id: "npm",
        label: "npm (global)",
        argv: &["npm", "ls", "-g", "--depth=0", "--json"],
    },
    SourceSpec {
        id: "pip",
        label: "pip",
        argv: &["pip", "list", "--format=json"],
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Package {
    pub name: String,
    /// Package id where the manager has one distinct from the name (winget).
    /// Equal to `name` for npm and pip.
    pub id: String,
    pub version: String,
    /// Newer version the manager reports as installable. Empty when the source
    /// does not report it in a plain list (npm, pip) or nothing is available.
    pub available: String,
    /// Scanner source id: "winget", "npm", "pip".
    pub source: String,
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
        command: spec.argv.join(" "),
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
            emit_line(&app, format!("$ {}", spec.argv.join(" ")), false);
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
                        command: spec.argv.join(" "),
                        installed: true,
                        packages: Vec::new(),
                        error: Some("scan thread panicked".to_string()),
                    })
                })
                .collect()
        });

        for r in &results {
            if !r.installed {
                emit_line(&app, format!("  # {} is not installed, skipped", r.id), false);
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
        "npm" => parse_npm(stdout),
        "pip" => parse_pip(stdout),
        _ => Vec::new(),
    }
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

/// Parse `winget list`: a fixed-width table under a solid rule of dashes.
///
/// The Available column only exists when at least one package has an upgrade,
/// so the layout is decided by how many columns the header actually has.
///
/// ponytail: slicing by character index assumes winget pads by character count.
/// A name containing double-width CJK glyphs will drift its row's later columns;
/// switch to a display-width measure if that shows up.
fn parse_winget(out: &str) -> Vec<Package> {
    let lines: Vec<&str> = out.lines().collect();
    let Some(rule) = lines
        .iter()
        .position(|l| l.len() >= 10 && l.chars().all(|c| c == '-'))
    else {
        return Vec::new();
    };
    if rule == 0 {
        return Vec::new();
    }

    let header: Vec<char> = lines[rule - 1].chars().collect();
    let starts = column_starts(&header);
    if starts.len() < 3 {
        return Vec::new();
    }
    // 5 columns: Name, Id, Version, Available, Source.
    // 4 columns: Name, Id, Version, Source. Nothing is upgradable.
    let has_available = starts.len() >= 5;

    lines[rule + 1..]
        .iter()
        .filter_map(|line| {
            let cols = slice_columns(&line.chars().collect::<Vec<char>>(), &starts);
            let name = cols.first()?.clone();
            if name.is_empty() {
                return None;
            }
            Some(Package {
                id: cols.get(1).cloned().unwrap_or_default(),
                version: cols.get(2).cloned().unwrap_or_default(),
                available: if has_available {
                    cols.get(3).cloned().unwrap_or_default()
                } else {
                    String::new()
                },
                source: "winget".to_string(),
                name,
            })
        })
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
}
