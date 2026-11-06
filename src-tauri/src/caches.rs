use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{classify, AtlasError, ErrorKind};
use crate::wsl::emit_line;

const PROGRESS_EVERY: Duration = Duration::from_millis(150);

/// Asks a running scan to stop.
#[derive(Default)]
pub struct CacheScanState(Arc<AtomicBool>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CacheKind {
    NodeModules,
    RustTarget,
    MavenTarget,
    GradleBuild,
    PythonVenv,
    PythonBytecode,
    Shared,
}

#[derive(Debug, Clone, Serialize)]
pub struct CacheItem {
    pub kind: CacheKind,
    /// The project folder's name, or the shared cache's name.
    pub name: String,
    /// What gets deleted. More than one for a project's `__pycache__` folders and for Cargo.
    pub paths: Vec<String>,
    pub size_bytes: u64,
    pub file_count: u64,
    /// Seconds since 1970: the newest file in the project or the cache.
    pub last_used: Option<u64>,
    /// How it comes back: a command, or that it comes back by itself.
    pub restore: Option<String>,
    /// Anything to know before clearing it.
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CacheScan {
    pub items: Vec<CacheItem>,
    /// Chosen folders that are gone, or that this page will not look inside.
    pub skipped_roots: Vec<String>,
    /// The user stopped the scan, so the list is not complete.
    pub stopped: bool,
}

#[derive(Debug, Serialize)]
pub struct ClearFailure {
    pub path: String,
    pub error: AtlasError,
}

#[derive(Debug, Serialize)]
pub struct DriveFreed {
    pub drive: String,
    pub freed_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ClearResult {
    pub removed: Vec<String>,
    pub failed: Vec<ClearFailure>,
    /// Measured from the drive, because shared files make a folder's size overstate what is freed.
    pub drives: Vec<DriveFreed>,
}

#[derive(Clone, Serialize)]
struct ScanProgress {
    folder: String,
    found: usize,
}

#[derive(Clone, Serialize)]
struct ClearProgress {
    done: usize,
    total: usize,
}

struct Found {
    kind: CacheKind,
    restore: Option<String>,
    note: Option<String>,
}

const LOCKFILES: [(&str, &str); 6] = [
    ("pnpm-lock.yaml", "pnpm install"),
    ("yarn.lock", "yarn install"),
    ("bun.lock", "bun install"),
    ("bun.lockb", "bun install"),
    ("package-lock.json", "npm install"),
    ("npm-shrinkwrap.json", "npm install"),
];

const PROJECT_MARKERS: [&str; 5] = [".git", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"];

/// Programs live here, and their own `node_modules` would break if cleared.
const OFF_LIMITS: [&str; 9] = [
    "appdata", "windows", "program files", "program files (x86)", "programdata",
    "system volume information", "recovery", "perflogs", "scoop",
];

/// Dot folders hold tools, such as VS Code's extensions, and these are the ones that are caches.
const CACHE_DOT_FOLDERS: [&str; 3] = [".venv", ".env", ".gradle"];

fn lower_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn is_off_limits_folder(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$') || OFF_LIMITS.contains(&name)
}

/// Whether anything on the way to this path is somewhere this page must stay out of.
fn inside_off_limits(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::Normal(name) if is_off_limits_folder(&name.to_string_lossy().to_lowercase())))
}

fn names_in(dir: &Path) -> HashSet<String> {
    fs::read_dir(dir)
        .map(|read| read.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
        .unwrap_or_default()
}

/// The install command, from the nearest lockfile. A `package.json` alone is not enough, because
/// installed programs carry one too, and clearing their `node_modules` would break them.
fn node_restore(project: &Path) -> Option<String> {
    for dir in project.ancestors() {
        for (lockfile, command) in LOCKFILES {
            if dir.join(lockfile).is_file() {
                return Some(command.to_string());
            }
        }
        if dir.join(".git").exists() {
            return Some("npm install".to_string());
        }
    }
    None
}

fn python_restore(siblings: &HashSet<String>) -> Option<&'static str> {
    [
        ("uv.lock", "uv sync"),
        ("poetry.lock", "poetry install"),
        ("pipfile", "pipenv install"),
        ("requirements.txt", "pip install -r requirements.txt"),
        ("pyproject.toml", "pip install ."),
    ]
    .into_iter()
    .find(|(file, _)| siblings.contains(*file))
    .map(|(_, command)| command)
}

fn only_bytecode(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|read| {
        read.flatten().all(|e| {
            e.file_type().is_ok_and(|t| t.is_file()) && e.file_name().to_string_lossy().to_lowercase().ends_with(".pyc")
        })
    })
}

/// A folder only counts when the files around it prove what it is. This decides what a scan lists
/// and also what a delete accepts, so the two cannot disagree.
fn classify_dir(path: &Path, siblings: &HashSet<String>) -> Option<Found> {
    let has = |names: &[&str]| names.iter().any(|n| siblings.contains(*n));
    let found = |kind, restore: &str| Some(Found { kind, restore: Some(restore.to_string()), note: None });
    match lower_name(path).as_str() {
        "node_modules" if has(&["package.json"]) => {
            let restore = node_restore(path.parent()?)?;
            let note = path.join(".pnpm").is_dir().then(|| {
                "pnpm hard-links these files from its store, so clearing this may free much less than the size shown.".to_string()
            });
            Some(Found { kind: CacheKind::NodeModules, restore: Some(restore), note })
        }
        "target" if has(&["cargo.toml"]) && (path.join(".rustc_info.json").is_file() || path.join("CACHEDIR.TAG").is_file()) => {
            found(CacheKind::RustTarget, "cargo build")
        }
        "target" if has(&["pom.xml"]) => found(CacheKind::MavenTarget, "mvn package"),
        ".gradle" | "build" if has(&["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) => {
            found(CacheKind::GradleBuild, "gradle build")
        }
        ".venv" | "venv" | "env" | ".env" | "virtualenv" if path.join("pyvenv.cfg").is_file() => {
            let restore = python_restore(siblings);
            Some(Found {
                kind: CacheKind::PythonVenv,
                restore: restore.map(str::to_string),
                note: restore.is_none().then(|| {
                    "No dependency manifest found. Packages must be reinstalled manually.".to_string()
                }),
            })
        }
        "__pycache__" if only_bytecode(path) => found(CacheKind::PythonBytecode, "Automatic"),
        _ => None,
    }
}

struct SharedCache {
    name: &'static str,
    paths: Vec<PathBuf>,
    restore: &'static str,
    note: Option<&'static str>,
}

fn shared_caches(env: &dyn Fn(&str) -> Option<String>) -> Vec<SharedCache> {
    let local = env("LOCALAPPDATA").map(PathBuf::from);
    let home = env("USERPROFILE").map(PathBuf::from);
    let override_or = |var: &str, fallback: Option<PathBuf>| env(var).map(PathBuf::from).or(fallback);
    let in_local = |sub: &str| local.as_ref().map(|d| d.join(sub));
    let in_home = |sub: &str| home.as_ref().map(|d| d.join(sub));
    let one = |path: Option<PathBuf>| path.into_iter().collect::<Vec<_>>();

    let cargo = override_or("CARGO_HOME", in_home(".cargo"));
    vec![
        SharedCache { name: "npm cache", paths: one(override_or("npm_config_cache", in_local("npm-cache"))), restore: "npm install", note: None },
        SharedCache {
            name: "pnpm store",
            paths: one(in_local("pnpm\\store")),
            restore: "pnpm install",
            note: Some("Files hard-linked into projects are not freed until those projects' node_modules folders are also cleared."),
        },
        SharedCache { name: "Yarn cache", paths: one(in_local("Yarn\\Cache")), restore: "yarn install", note: None },
        SharedCache { name: "pip cache", paths: one(override_or("PIP_CACHE_DIR", in_local("pip\\Cache"))), restore: "pip install", note: None },
        SharedCache { name: "uv cache", paths: one(override_or("UV_CACHE_DIR", in_local("uv\\cache"))), restore: "uv sync", note: None },
        SharedCache {
            name: "Cargo registry",
            paths: cargo.iter().flat_map(|d| [d.join("registry"), d.join("git")]).collect(),
            restore: "cargo build",
            note: None,
        },
        SharedCache { name: "Gradle cache", paths: one(override_or("GRADLE_USER_HOME", in_home(".gradle")).map(|d| d.join("caches"))), restore: "gradle build", note: None },
        SharedCache {
            name: "Maven local repository",
            paths: one(in_home(".m2\\repository")),
            restore: "mvn package",
            note: Some("Also contains artifacts installed with mvn install, which must be rebuilt."),
        },
        SharedCache { name: "NuGet global packages", paths: one(override_or("NUGET_PACKAGES", in_home(".nuget\\packages"))), restore: "dotnet restore", note: None },
    ]
}

/// pnpm keeps one store per drive when a project is not on the same drive as the home folder.
fn is_drive_pnpm_store(path: &Path) -> bool {
    lower_name(path) == ".pnpm-store" && path.parent().is_some_and(|p| p.parent().is_none())
}

fn pnpm_store_on(root: &Path) -> Option<PathBuf> {
    root.ancestors().last().map(|drive| drive.join(".pnpm-store"))
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().trim_end_matches('\\').eq_ignore_ascii_case(b.to_string_lossy().trim_end_matches('\\'))
}

fn is_shared_cache(path: &Path, env: &dyn Fn(&str) -> Option<String>) -> bool {
    is_drive_pnpm_store(path) || shared_caches(env).iter().any(|cache| cache.paths.iter().any(|p| same_path(p, path)))
}

/// Drops a folder that sits inside another chosen folder, so nothing is counted twice.
fn top_level_roots(roots: &[String]) -> Vec<String> {
    let mut sorted: Vec<String> = roots.iter().map(|r| r.trim_end_matches('\\').to_string()).collect();
    sorted.sort_by_key(|r| r.to_lowercase());
    let mut kept: Vec<String> = Vec::new();
    for root in sorted {
        let inside = kept.iter().any(|k| {
            let (k, r) = (k.to_lowercase(), root.to_lowercase());
            r == k || r.starts_with(&format!("{k}\\"))
        });
        if !inside {
            kept.push(root);
        }
    }
    kept
}

fn modified_seconds(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

struct Scanner<'a> {
    stop: &'a AtomicBool,
    on_progress: &'a mut dyn FnMut(&Path, usize),
    last_progress: Instant,
    items: Vec<CacheItem>,
    /// Where each project's `__pycache__` folders are gathered, because one project can have hundreds.
    bytecode: BTreeMap<String, usize>,
}

impl Scanner<'_> {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn report(&mut self, folder: &Path) {
        if self.last_progress.elapsed() >= PROGRESS_EVERY {
            self.last_progress = Instant::now();
            let found = self.items.len();
            (self.on_progress)(folder, found);
        }
    }

    /// Never follows a link or junction, because pnpm's `node_modules` is full of them.
    fn measure(&self, start: &Path) -> (u64, u64, u64) {
        let (mut bytes, mut files, mut newest) = (0, 0, 0);
        let mut folders = vec![start.to_path_buf()];
        while let Some(dir) = folders.pop() {
            if self.stopped() {
                break;
            }
            let Ok(read) = fs::read_dir(&dir) else { continue };
            for entry in read.flatten() {
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    folders.push(entry.path());
                } else if let Ok(meta) = entry.metadata() {
                    bytes += meta.len();
                    files += 1;
                    newest = newest.max(modified_seconds(&meta));
                }
            }
        }
        (bytes, files, newest)
    }

    fn add_project_cache(&mut self, path: &Path, found: Found, project: Option<&Path>) -> Option<usize> {
        self.report(path);
        let (size_bytes, file_count, newest) = self.measure(path);
        if self.stopped() {
            return None;
        }
        let path_text = path.to_string_lossy().to_string();
        if found.kind == CacheKind::PythonBytecode {
            let group = project.or(path.parent()).unwrap_or(path);
            if let Some(&index) = self.bytecode.get(&group.to_string_lossy().to_lowercase()) {
                let item = &mut self.items[index];
                item.paths.push(path_text);
                item.size_bytes += size_bytes;
                item.file_count += file_count;
                item.last_used = item.last_used.max(Some(newest));
                return Some(index);
            }
            self.bytecode.insert(group.to_string_lossy().to_lowercase(), self.items.len());
        }
        let owner = if found.kind == CacheKind::PythonBytecode { project.or(path.parent()) } else { path.parent() };
        self.items.push(CacheItem {
            kind: found.kind,
            name: owner.and_then(Path::file_name).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path_text.clone()),
            paths: vec![path_text],
            size_bytes,
            file_count,
            last_used: Some(newest),
            restore: found.restore,
            note: found.note,
        });
        Some(self.items.len() - 1)
    }

    /// Returns the newest file time in this folder, leaving out the caches inside it.
    fn walk(&mut self, dir: &Path, project: Option<&Path>) -> u64 {
        if self.stopped() {
            return 0;
        }
        self.report(dir);
        let Ok(read) = fs::read_dir(dir) else { return 0 };
        let entries: Vec<_> = read.flatten().collect();
        let siblings: HashSet<String> = entries.iter().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect();
        let project = project.or_else(|| PROJECT_MARKERS.iter().any(|m| siblings.contains(*m)).then_some(dir));

        let mut newest = 0;
        let mut caches_here = Vec::new();
        for entry in &entries {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_file() {
                if let Ok(meta) = entry.metadata() {
                    newest = newest.max(modified_seconds(&meta));
                }
                continue;
            }
            let path = entry.path();
            let name = lower_name(&path);
            if let Some(found) = classify_dir(&path, &siblings) {
                if !is_off_limits_folder(&name) || CACHE_DOT_FOLDERS.contains(&name.as_str()) {
                    caches_here.extend(self.add_project_cache(&path, found, project));
                }
            } else if !is_off_limits_folder(&name) {
                newest = newest.max(self.walk(&path, project));
            }
        }
        for index in caches_here {
            let item = &mut self.items[index];
            item.last_used = item.last_used.max(Some(newest));
        }
        newest
    }

    fn add_shared(&mut self, name: &str, paths: &[PathBuf], restore: &str, note: Option<&str>) {
        let existing: Vec<&PathBuf> = paths.iter().filter(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !m.is_symlink())).collect();
        if existing.is_empty() {
            return;
        }
        let (mut size_bytes, mut file_count, mut newest) = (0, 0, 0);
        for path in &existing {
            self.report(path);
            let (bytes, files, time) = self.measure(path);
            size_bytes += bytes;
            file_count += files;
            newest = newest.max(time);
        }
        if self.stopped() {
            return;
        }
        self.items.push(CacheItem {
            kind: CacheKind::Shared,
            name: name.to_string(),
            paths: existing.iter().map(|p| p.to_string_lossy().to_string()).collect(),
            size_bytes,
            file_count,
            last_used: Some(newest),
            restore: Some(restore.to_string()),
            note: note.map(str::to_string),
        });
    }
}

fn scan(roots: &[String], env: &dyn Fn(&str) -> Option<String>, stop: &AtomicBool, on_progress: &mut dyn FnMut(&Path, usize)) -> CacheScan {
    let mut scanner = Scanner { stop, on_progress, last_progress: Instant::now(), items: Vec::new(), bytecode: BTreeMap::new() };

    for cache in shared_caches(env) {
        scanner.add_shared(cache.name, &cache.paths, cache.restore, cache.note);
    }

    let mut skipped_roots = Vec::new();
    let mut stores_seen: Vec<PathBuf> = Vec::new();
    for root in top_level_roots(roots) {
        let path = PathBuf::from(&root);
        if !path.is_dir() || inside_off_limits(&path) {
            skipped_roots.push(root);
            continue;
        }
        if let Some(store) = pnpm_store_on(&path).filter(|s| !stores_seen.iter().any(|seen| same_path(seen, s))) {
            let note = shared_caches(env).into_iter().find(|c| c.name == "pnpm store").and_then(|c| c.note);
            let name = format!("pnpm store on {}", store.ancestors().last().map(|d| d.to_string_lossy().trim_end_matches('\\').to_string()).unwrap_or_default());
            scanner.add_shared(&name, std::slice::from_ref(&store), "pnpm install", note);
            stores_seen.push(store);
        }
        scanner.walk(&path, None);
    }

    let stopped = scanner.stopped();
    CacheScan { items: scanner.items, skipped_roots, stopped }
}

/// The webview's word is not enough: this checks a path again right before deleting it. `None`
/// means it is already gone.
fn check_can_clear(text: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<Option<PathBuf>, AtlasError> {
    let path = PathBuf::from(text);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AtlasError::invalid(format!("{text} is not an absolute path. Nothing was cleared.")));
    }
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if meta.is_symlink() || !meta.is_dir() {
        return Err(AtlasError::invalid(format!("{text} is a symbolic link or a file. Nothing was cleared.")));
    }
    if is_shared_cache(&path, env) {
        return Ok(Some(path));
    }
    let not_a_cache = || AtlasError::invalid(format!("{text} is no longer recognized as a cache. Nothing was cleared.")).hint("Rescan to refresh the list.");
    let parent = path.parent().ok_or_else(not_a_cache)?;
    if inside_off_limits(parent) || classify_dir(&path, &names_in(parent)).is_none() {
        return Err(not_a_cache());
    }
    Ok(Some(path))
}

fn powershell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// `F:` or `\\server\share`.
fn drive_of(path: &str) -> String {
    match Path::new(path).components().next() {
        Some(Component::Prefix(prefix)) => prefix.as_os_str().to_string_lossy().to_uppercase(),
        _ => String::new(),
    }
}

fn free_bytes_on(drive: &str) -> Option<u64> {
    crate::system::disk_space(&format!("{drive}\\")).map(|(free, _)| free)
}

fn clear(paths: &[String], env: &dyn Fn(&str) -> Option<String>, on_step: &mut dyn FnMut(&str, usize, Option<&AtlasError>)) -> ClearResult {
    let mut drives: Vec<(String, u64)> = Vec::new();
    for path in paths {
        let drive = drive_of(path);
        if !drives.iter().any(|(known, _)| *known == drive) {
            if let Some(free) = free_bytes_on(&drive) {
                drives.push((drive, free));
            }
        }
    }

    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let outcome = check_can_clear(path, env).and_then(|target| match target {
            Some(target) => fs::remove_dir_all(target).map_err(|e| {
                let mut error = classify(&e.to_string());
                if matches!(error.kind, ErrorKind::Busy | ErrorKind::Permission) {
                    error = error.hint("A dev server, editor, or terminal may be holding it open. Stop the process, then retry.");
                }
                error
            }),
            None => Ok(()),
        });
        on_step(path, index + 1, outcome.as_ref().err());
        match outcome {
            Ok(()) => removed.push(path.clone()),
            Err(error) => failed.push(ClearFailure { path: path.clone(), error }),
        }
    }

    let drives = drives
        .into_iter()
        .filter_map(|(drive, before)| {
            let after = free_bytes_on(&drive)?;
            Some(DriveFreed { drive, freed_bytes: after.saturating_sub(before), free_bytes: after })
        })
        .collect();
    ClearResult { removed, failed, drives }
}

fn real_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Reads only. Finds dependency and build folders in the chosen folders, plus the shared caches.
#[tauri::command]
pub async fn caches_scan(app: AppHandle, state: tauri::State<'_, CacheScanState>, roots: Vec<String>) -> Result<CacheScan, AtlasError> {
    let stop = state.0.clone();
    stop.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        scan(&roots, &real_env, &stop, &mut |folder, found| {
            app.emit("cache-scan-progress", ScanProgress { folder: folder.to_string_lossy().to_string(), found }).ok();
        })
    })
    .await
    .map_err(|e| AtlasError::from(e.to_string()))
}

#[tauri::command]
pub fn caches_scan_stop(state: tauri::State<'_, CacheScanState>) {
    state.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn caches_clear(
    app: AppHandle,
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    paths: Vec<String>,
) -> Result<ClearResult, AtlasError> {
    migration.inner().clone().run_operation(move || {
        let total = paths.len();
        Ok(clear(&paths, &real_env, &mut |path, done, error| {
            emit_line(&app, format!("$ Remove-Item -LiteralPath {} -Recurse -Force", powershell_quote(path)), false);
            match error {
                Some(error) => emit_line(&app, format!("  ✗ {error}"), true),
                None => emit_line(&app, "  ✓ removed", false),
            }
            app.emit("cache-clear-progress", ClearProgress { done, total }).ok();
        }))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// The Public folder, because the temp folder is inside AppData, and a lockfile or `.git` above
    /// the test folder would change what counts as a project.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let public = std::env::var("PUBLIC").expect("PUBLIC is set on Windows");
            let dir = PathBuf::from(public).join(format!("atlas-caches-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, relative: &str, bytes: usize) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, vec![b'x'; bytes]).unwrap();
            path
        }

        fn root(&self) -> String {
            self.0.to_string_lossy().to_string()
        }

        fn path(&self, relative: &str) -> String {
            self.0.join(relative).to_string_lossy().to_string()
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn run_scan(dir: &TestDir) -> CacheScan {
        scan(&[dir.root()], &no_env, &AtomicBool::new(false), &mut |_, _| {})
    }

    fn item<'a>(result: &'a CacheScan, name: &str, kind: CacheKind) -> Option<&'a CacheItem> {
        result.items.iter().find(|i| i.name == name && i.kind == kind)
    }

    fn junction(link: &Path, target: &Path) {
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J", &link.to_string_lossy().replace('/', "\\"), &target.to_string_lossy().replace('/', "\\")])
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn node_modules_needs_a_project_around_it() {
        let dir = TestDir::new();
        dir.file("shop/package.json", 10);
        dir.file("shop/pnpm-lock.yaml", 10);
        dir.file("shop/src/main.js", 10);
        dir.file("shop/node_modules/a/index.js", 1000);
        dir.file("shop/node_modules/a/more.js", 500);

        dir.file("mono/.git/HEAD", 10);
        dir.file("mono/packages/web/package.json", 10);
        dir.file("mono/packages/web/node_modules/a/index.js", 7);

        dir.file("installed-app/package.json", 10);
        dir.file("installed-app/node_modules/a/index.js", 10);
        dir.file("no-manifest/node_modules/a/index.js", 10);

        let result = run_scan(&dir);
        let shop = item(&result, "shop", CacheKind::NodeModules).expect("shop");
        assert_eq!(shop.size_bytes, 1500);
        assert_eq!(shop.file_count, 2);
        assert_eq!(shop.restore.as_deref(), Some("pnpm install"));
        assert!(shop.last_used.unwrap() > 0);
        assert_eq!(item(&result, "web", CacheKind::NodeModules).expect("a package in a repo").restore.as_deref(), Some("npm install"));
        assert!(item(&result, "installed-app", CacheKind::NodeModules).is_none(), "a package.json alone could be an installed program");
        assert!(item(&result, "no-manifest", CacheKind::NodeModules).is_none());
    }

    #[test]
    fn the_install_command_follows_the_lockfile() {
        for (lockfile, command) in [("yarn.lock", "yarn install"), ("package-lock.json", "npm install"), ("bun.lock", "bun install")] {
            let dir = TestDir::new();
            dir.file("p/package.json", 1);
            dir.file(&format!("p/{lockfile}"), 1);
            dir.file("p/node_modules/a.js", 1);
            assert_eq!(item(&run_scan(&dir), "p", CacheKind::NodeModules).unwrap().restore.as_deref(), Some(command));
        }
    }

    #[test]
    fn a_pnpm_project_warns_that_less_may_be_freed() {
        let dir = TestDir::new();
        dir.file("p/package.json", 1);
        dir.file("p/pnpm-lock.yaml", 1);
        dir.file("p/node_modules/.pnpm/lock.yaml", 1);
        assert!(item(&run_scan(&dir), "p", CacheKind::NodeModules).unwrap().note.as_deref().unwrap().contains("much less"));
    }

    #[test]
    fn build_folders_need_their_build_file_and_rust_needs_its_own_marker() {
        let dir = TestDir::new();
        dir.file("rusty/Cargo.toml", 1);
        dir.file("rusty/target/.rustc_info.json", 1);
        dir.file("rusty/target/debug/app.exe", 100);
        dir.file("not-built-by-cargo/Cargo.toml", 1);
        dir.file("not-built-by-cargo/target/my-file.txt", 1);
        dir.file("java/pom.xml", 1);
        dir.file("java/target/app.jar", 50);
        dir.file("droid/build.gradle.kts", 1);
        dir.file("droid/.gradle/x.bin", 3);
        dir.file("droid/build/out.apk", 4);
        dir.file("plain/target/keep.txt", 1);
        dir.file("plain/build/keep.txt", 1);

        let result = run_scan(&dir);
        assert_eq!(item(&result, "rusty", CacheKind::RustTarget).unwrap().size_bytes, 101);
        assert!(item(&result, "not-built-by-cargo", CacheKind::RustTarget).is_none());
        assert_eq!(item(&result, "java", CacheKind::MavenTarget).unwrap().restore.as_deref(), Some("mvn package"));
        assert_eq!(result.items.iter().filter(|i| i.kind == CacheKind::GradleBuild).count(), 2);
        assert!(result.items.iter().all(|i| i.name != "plain"));
    }

    #[test]
    fn a_virtual_environment_says_how_it_comes_back_or_warns() {
        let dir = TestDir::new();
        dir.file("api/requirements.txt", 1);
        dir.file("api/.venv/pyvenv.cfg", 1);
        dir.file("api/.venv/Lib/site.py", 5);
        dir.file("tool/venv/pyvenv.cfg", 1);
        dir.file("config/env/settings.txt", 1);

        let result = run_scan(&dir);
        let api = item(&result, "api", CacheKind::PythonVenv).unwrap();
        assert_eq!(api.restore.as_deref(), Some("pip install -r requirements.txt"));
        assert_eq!(api.note, None);
        let tool = item(&result, "tool", CacheKind::PythonVenv).unwrap();
        assert_eq!(tool.restore, None);
        assert!(tool.note.as_deref().unwrap().contains("manually"));
        assert!(result.items.iter().all(|i| i.name != "config"), "a folder named env is not always an environment");
    }

    #[test]
    fn a_projects_bytecode_folders_become_one_row() {
        let dir = TestDir::new();
        dir.file("app/pyproject.toml", 1);
        dir.file("app/pkg/__pycache__/a.cpython-312.pyc", 10);
        dir.file("app/pkg/sub/__pycache__/b.cpython-312.pyc", 20);
        dir.file("mixed/__pycache__/a.pyc", 1);
        dir.file("mixed/__pycache__/notes.txt", 1);

        let result = run_scan(&dir);
        let app = item(&result, "app", CacheKind::PythonBytecode).unwrap();
        assert_eq!(app.paths.len(), 2);
        assert_eq!(app.size_bytes, 30);
        assert!(result.items.iter().all(|i| i.name != "mixed"), "anything else inside means someone put it there");
    }

    #[test]
    fn the_scan_stays_out_of_tools_programs_and_links() {
        let dir = TestDir::new();
        for place in [".vscode/extensions/ext", "AppData/Local/tool", "Program Files/app", "scoop/apps/tool"] {
            dir.file(&format!("{place}/package.json"), 1);
            dir.file(&format!("{place}/package-lock.json"), 1);
            dir.file(&format!("{place}/node_modules/a.js"), 1);
        }
        dir.file("elsewhere/real/package.json", 1);
        dir.file("elsewhere/real/package-lock.json", 1);
        dir.file("elsewhere/real/node_modules/a.js", 1);
        junction(&dir.0.join("linked"), &dir.0.join("elsewhere"));

        let result = run_scan(&dir);
        assert_eq!(result.items.len(), 1, "{:?}", result.items);
        assert!(result.items[0].paths[0].contains("elsewhere"));
    }

    #[test]
    fn links_inside_a_cache_are_not_counted() {
        let dir = TestDir::new();
        dir.file("p/package.json", 1);
        dir.file("p/pnpm-lock.yaml", 1);
        dir.file("p/node_modules/own.js", 5);
        dir.file("big-store/huge.bin", 9000);
        junction(&dir.0.join("p/node_modules/linked"), &dir.0.join("big-store"));
        assert_eq!(item(&run_scan(&dir), "p", CacheKind::NodeModules).unwrap().size_bytes, 5);
    }

    #[test]
    fn last_used_comes_from_the_project_and_not_only_the_cache() {
        let dir = TestDir::new();
        dir.file("p/package.json", 1);
        dir.file("p/pnpm-lock.yaml", 1);
        dir.file("p/node_modules/a.js", 1);
        let old = fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_000_000));
        for file in ["p/package.json", "p/pnpm-lock.yaml", "p/node_modules/a.js"] {
            fs::File::options().write(true).open(dir.0.join(file)).unwrap().set_times(old).unwrap();
        }
        assert_eq!(item(&run_scan(&dir), "p", CacheKind::NodeModules).unwrap().last_used, Some(1_000_000));

        dir.file("p/src/new.js", 1);
        assert!(item(&run_scan(&dir), "p", CacheKind::NodeModules).unwrap().last_used.unwrap() > 1_000_000);
    }

    #[test]
    fn a_stopped_scan_says_so_and_keeps_no_half_measured_row() {
        let dir = TestDir::new();
        dir.file("p/package.json", 1);
        dir.file("p/pnpm-lock.yaml", 1);
        dir.file("p/node_modules/a.js", 1);
        let result = scan(&[dir.root()], &no_env, &AtomicBool::new(true), &mut |_, _| {});
        assert!(result.stopped);
        assert!(result.items.is_empty());
    }

    #[test]
    fn folders_that_are_gone_or_off_limits_are_reported_and_nested_ones_count_once() {
        let dir = TestDir::new();
        dir.file("p/package.json", 1);
        dir.file("p/pnpm-lock.yaml", 1);
        dir.file("p/node_modules/a.js", 1);
        let gone = dir.path("gone");
        let tool = dir.path(".vscode");
        fs::create_dir_all(&tool).unwrap();
        let result = scan(&[dir.root(), dir.path("p"), gone.clone(), tool.clone()], &no_env, &AtomicBool::new(false), &mut |_, _| {});
        assert_eq!(result.items.iter().filter(|i| i.kind == CacheKind::NodeModules).count(), 1);
        assert!(result.skipped_roots.is_empty(), "both sit inside the first folder, so they are not scanned separately");

        let alone = scan(std::slice::from_ref(&gone), &no_env, &AtomicBool::new(false), &mut |_, _| {});
        assert_eq!(alone.skipped_roots, vec![gone]);
        let alone = scan(std::slice::from_ref(&tool), &no_env, &AtomicBool::new(false), &mut |_, _| {});
        assert_eq!(alone.skipped_roots, vec![tool]);
    }

    #[test]
    fn nested_roots_collapse_to_the_outer_one() {
        let roots = ["F:\\Scripts\\a".to_string(), "f:\\scripts".to_string(), "F:\\Scripts2".to_string(), "F:\\Scripts\\".to_string()];
        assert_eq!(top_level_roots(&roots), vec!["f:\\scripts".to_string(), "F:\\Scripts2".to_string()]);
    }

    #[test]
    fn clearing_removes_real_caches_with_their_hard_parts() {
        let dir = TestDir::new();
        dir.file("p/package.json", 1);
        dir.file("p/pnpm-lock.yaml", 1);
        dir.file("p/src/keep.js", 1);
        dir.file("p/node_modules/plain.js", 1);

        let locked = dir.file("p/node_modules/readonly.js", 1);
        let mut permissions = fs::metadata(&locked).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&locked, permissions).unwrap();

        dir.file(&format!("p/node_modules/{}/deep.js", ["long-folder-name-here"; 20].join("/")), 1);
        assert!(dir.path("p/node_modules").len() + 20 * 22 > 260);

        let store = dir.file("store/shared.js", 1);
        junction(&dir.0.join("p/node_modules/linked"), store.parent().unwrap());

        let target = dir.path("p/node_modules");
        let result = clear(std::slice::from_ref(&target), &no_env, &mut |_, _, _| {});
        assert_eq!(result.failed.iter().map(|f| f.error.message.clone()).collect::<Vec<_>>(), Vec::<String>::new());
        assert_eq!(result.removed, vec![target.clone()]);
        assert!(!Path::new(&target).exists());
        assert!(dir.0.join("p/src/keep.js").exists(), "the project stays");
        assert!(store.exists(), "what a link points at stays");
        assert_eq!(result.drives.len(), 1);
    }

    #[test]
    fn clearing_refuses_anything_that_is_not_a_known_cache() {
        let dir = TestDir::new();
        dir.file("p/package.json", 1);
        dir.file("p/pnpm-lock.yaml", 1);
        dir.file("p/src/keep.js", 1);
        dir.file("p/node_modules/a.js", 1);
        dir.file("no-project/node_modules/a.js", 1);
        dir.file("tool/.vscode/ext/package.json", 1);
        dir.file("tool/.vscode/ext/package-lock.json", 1);
        dir.file("tool/.vscode/ext/node_modules/a.js", 1);
        dir.file("real/stuff.txt", 1);
        junction(&dir.0.join("p2/node_modules"), &dir.0.join("real"));
        dir.file("p2/package.json", 1);
        dir.file("p2/pnpm-lock.yaml", 1);

        let refused = [
            dir.path("p/src"),
            dir.path("p"),
            dir.root(),
            "C:\\Windows".to_string(),
            "C:\\".to_string(),
            dir.path("no-project/node_modules"),
            dir.path("tool/.vscode/ext/node_modules"),
            dir.path("p2/node_modules"),
            dir.path("p/package.json"),
            format!("{}\\p\\node_modules\\..\\src", dir.root()),
            "node_modules".to_string(),
        ];
        let result = clear(&refused, &no_env, &mut |_, _, _| {});
        assert!(result.removed.is_empty(), "{:?}", result.removed);
        assert_eq!(result.failed.len(), refused.len());
        assert!(dir.0.join("p/src/keep.js").exists());
        assert!(dir.0.join("real/stuff.txt").exists(), "a junction named node_modules is not followed");
        assert!(dir.0.join("tool/.vscode/ext/node_modules/a.js").exists());
    }

    #[test]
    fn a_cache_that_is_already_gone_counts_as_cleared() {
        let dir = TestDir::new();
        let gone = dir.path("p/node_modules");
        let result = clear(std::slice::from_ref(&gone), &no_env, &mut |_, _, _| {});
        assert_eq!(result.removed, vec![gone]);
        assert!(result.failed.is_empty());
    }

    #[test]
    fn a_file_in_use_is_reported_as_busy_and_the_next_path_still_clears() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TestDir::new();
        for project in ["held", "free"] {
            dir.file(&format!("{project}/package.json"), 1);
            dir.file(&format!("{project}/pnpm-lock.yaml"), 1);
        }
        let held = dir.file("held/node_modules/in-use.js", 1);
        dir.file("free/node_modules/a.js", 1);
        let open = fs::OpenOptions::new().read(true).share_mode(0).open(&held).unwrap();

        let paths = [dir.path("held/node_modules"), dir.path("free/node_modules")];
        let mut steps = Vec::new();
        let result = clear(&paths, &no_env, &mut |path, done, error| steps.push((path.to_string(), done, error.is_some())));
        drop(open);

        assert_eq!(result.removed, vec![paths[1].clone()]);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, paths[0]);
        assert_eq!(result.failed[0].error.kind, ErrorKind::Busy);
        assert!(result.failed[0].error.hint.as_deref().unwrap().contains("dev server"));
        assert_eq!(steps, vec![(paths[0].clone(), 1, true), (paths[1].clone(), 2, false)]);
    }

    #[test]
    fn shared_caches_are_found_where_the_tools_keep_them_and_nothing_else_there_is_touched() {
        let dir = TestDir::new();
        let local = dir.path("Local");
        let home = dir.path("Home");
        let env = |name: &str| match name {
            "LOCALAPPDATA" => Some(local.clone()),
            "USERPROFILE" => Some(home.clone()),
            _ => None,
        };
        dir.file("Local/npm-cache/_cacache/x", 10);
        dir.file("Local/pip/Cache/y", 20);
        dir.file("Home/.cargo/registry/z", 30);
        dir.file("Home/.cargo/git/w", 5);
        dir.file("Home/.cargo/bin/cargo.exe", 99);
        dir.file("Home/.gradle/gradle.properties", 1);

        let result = scan(&[], &env, &AtomicBool::new(false), &mut |_, _| {});
        let names: Vec<&str> = result.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["npm cache", "pip cache", "Cargo registry"]);
        assert_eq!(result.items[2].size_bytes, 35);
        assert_eq!(result.items[2].paths.len(), 2);

        let accepted = clear(&result.items[2].paths, &env, &mut |_, _, _| {});
        assert!(accepted.failed.is_empty());
        assert!(dir.0.join("Home/.cargo/bin/cargo.exe").exists());

        let refused = clear(&[dir.path("Home/.cargo/bin"), dir.path("Home/.cargo"), dir.path("Local/pip")], &env, &mut |_, _, _| {});
        assert_eq!(refused.failed.len(), 3);
    }

    #[test]
    fn a_tools_own_setting_moves_its_shared_cache() {
        let env = |name: &str| match name {
            "npm_config_cache" => Some("D:\\caches\\npm".to_string()),
            "CARGO_HOME" => Some("D:\\cargo".to_string()),
            _ => None,
        };
        let caches = shared_caches(&env);
        assert_eq!(caches[0].paths, vec![PathBuf::from("D:\\caches\\npm")]);
        assert!(caches.iter().find(|c| c.name == "Cargo registry").unwrap().paths.contains(&PathBuf::from("D:\\cargo\\registry")));
        assert!(is_shared_cache(Path::new("d:\\caches\\NPM\\"), &env));
        assert!(!is_shared_cache(Path::new("D:\\caches"), &env));
    }

    #[test]
    fn only_a_pnpm_store_at_the_top_of_a_drive_counts() {
        assert!(is_drive_pnpm_store(Path::new("F:\\.pnpm-store")));
        assert!(!is_drive_pnpm_store(Path::new("F:\\Scripts\\.pnpm-store")));
        assert_eq!(pnpm_store_on(Path::new("F:\\Scripts\\app")), Some(PathBuf::from("F:\\.pnpm-store")));
    }

    #[test]
    fn the_shown_command_quotes_awkward_paths() {
        assert_eq!(powershell_quote("C:\\it's\\here"), "'C:\\it''s\\here'");
    }

    #[test]
    fn a_path_names_its_drive() {
        assert_eq!(drive_of("f:\\Scripts"), "F:");
        assert!(free_bytes_on(&drive_of(&std::env::var("PUBLIC").unwrap())).unwrap() > 0);
    }

    /// Reads only. `cargo test real_scan -- --ignored --nocapture`, with ATLAS_SCAN_ROOT set.
    #[test]
    #[ignore]
    fn real_scan_of_this_pc() {
        let roots: Vec<String> = std::env::var("ATLAS_SCAN_ROOT").map(|r| vec![r]).unwrap_or_default();
        let started = Instant::now();
        let result = scan(&roots, &real_env, &AtomicBool::new(false), &mut |_, _| {});
        println!("{} rows in {:?}, skipped {:?}", result.items.len(), started.elapsed(), result.skipped_roots);
        let mut items = result.items;
        items.sort_by_key(|i| std::cmp::Reverse(i.size_bytes));
        for i in items.iter().take(25) {
            println!("{:>8.2} GB {:>8} files {:?} {} | {} | {:?}", i.size_bytes as f64 / 1e9, i.file_count, i.kind, i.name, i.paths[0], i.restore);
        }
    }
}
