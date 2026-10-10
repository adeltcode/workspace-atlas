use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::{AtlasError, ErrorKind};
use crate::wsl::WslDistro;

#[derive(Clone, Default)]
pub struct MigrationState(pub Arc<RwLock<()>>);

impl MigrationState {
    pub async fn run_operation<T: Send + 'static>(
        self,
        operation: impl FnOnce() -> Result<T, AtlasError> + Send + 'static,
    ) -> Result<T, AtlasError> {
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = self.0.try_read().map_err(|_| {
                AtlasError::new(ErrorKind::Busy, "Wait for the WSL migration to finish.")
            })?;
            operation()
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

pub fn require_docker_stopped() -> Result<(), AtlasError> {
    let system = sysinfo::System::new_all();
    if system.processes().values().any(|process| {
        let name = process.name().to_string_lossy();
        name.eq_ignore_ascii_case("Docker Desktop.exe")
            || name.eq_ignore_ascii_case("com.docker.backend.exe")
    }) {
        return Err(AtlasError::new(ErrorKind::Busy, "Docker Desktop must be fully quit before migrating a WSL distribution.")
            .hint("Save container work and quit Docker Desktop from its tray menu. Stopping containers alone does not stop WSL integration."));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct MigrateResult {
    pub backup_path: String,
    pub recovery_path: String,
}

const SPACE_RESERVE: u64 = 1024 * 1024 * 1024;
const HEALTH_CHECK: &str = r#"set -eu
root_writable=false
while read -r device mount filesystem options rest; do
    if [ "$mount" = / ]; then
        case ",$options," in *,rw,*) root_writable=true ;; esac
        break
    fi
done < /proc/mounts
if [ "$root_writable" != true ]; then
    printf '%s\n' 'The Linux root filesystem is not writable.' >&2
    exit 1
fi
umask 077
probe=$(mktemp "$HOME/.atlas-migration-check.XXXXXX")
trap 'rm -f "$probe"' EXIT HUP INT TERM
printf '%s\n' 'atlas-migration-check' > "$probe"
read -r contents < "$probe"
test "$contents" = 'atlas-migration-check'
rm -f "$probe"
trap - EXIT HUP INT TERM
"#;
#[cfg(windows)]
const FILE_SHARE_READ_DELETE: u32 = 1 | 4;

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string()
}

fn path_key(path: &Path) -> PathBuf {
    PathBuf::from(path_text(path).replace('/', "\\").to_lowercase())
}

pub fn source_distro<'a>(
    name: &str,
    distros: &'a [WslDistro],
) -> Result<&'a WslDistro, AtlasError> {
    if name.starts_with('-') || name.chars().any(char::is_control) {
        return Err(AtlasError::invalid("Choose a registered distribution."));
    }
    let distro = distros.iter().find(|d| d.name == name).ok_or_else(|| {
        AtlasError::invalid("The distribution is no longer registered. Refresh and try again.")
    })?;
    if name.to_lowercase().starts_with("docker-desktop") {
        return Err(AtlasError::invalid(
            "Move Docker's disk through Docker Desktop's settings.",
        ));
    }
    if distro.version != 2 {
        return Err(AtlasError::invalid(
            "This migration requires a WSL 2 distribution.",
        ));
    }
    if distro.vhd_path.is_empty()
        || !Path::new(&distro.vhd_path).is_file()
        || fs::metadata(&distro.vhd_path)?.len() == 0
    {
        return Err(AtlasError::invalid(
            "The distribution's virtual disk is missing. Repair it before migrating.",
        ));
    }
    Ok(distro)
}

fn require_empty(path: &Path) -> Result<(), AtlasError> {
    if !path.is_dir() || fs::read_dir(path)?.next().transpose()?.is_some() {
        return Err(AtlasError::invalid(
            "Choose an empty destination folder. Existing files will not be overwritten.",
        ));
    }
    Ok(())
}

pub fn destination(input: &Path, distros: &[WslDistro]) -> Result<PathBuf, AtlasError> {
    if !input.is_absolute() {
        return Err(AtlasError::invalid(
            "Choose an absolute destination folder on a local drive.",
        ));
    }
    #[cfg(windows)]
    if !is_local_path(input) {
        return Err(AtlasError::invalid(
            "Choose a folder on a local drive, rather than a network share.",
        ));
    }
    let path = input.canonicalize()?;
    #[cfg(windows)]
    if !is_local_path(&path) {
        return Err(AtlasError::invalid(
            "Choose a folder on a local drive, rather than a network share.",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        AtlasError::invalid("Choose a dedicated folder, rather than the drive root.")
    })?;
    let key = path_key(&path);
    let parent_key = path_key(parent);
    for distro in distros {
        if distro.base_path.is_empty() {
            continue;
        }
        let base = Path::new(&distro.base_path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&distro.base_path));
        let base_key = path_key(&base);
        if key.starts_with(&base_key)
            || parent_key.starts_with(&base_key)
            || base_key.starts_with(&key)
        {
            return Err(AtlasError::invalid("Choose a folder outside all registered distributions. The backup must also remain outside them."));
        }
    }
    require_empty(&path)?;
    Ok(path)
}

#[cfg(windows)]
fn is_local_path(path: &Path) -> bool {
    matches!(path.components().next(), Some(std::path::Component::Prefix(p))
        if matches!(p.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
}

fn required_space(size: u64, copies: u64) -> Result<u64, AtlasError> {
    size.checked_mul(copies)
        .and_then(|n| n.checked_add(SPACE_RESERVE))
        .ok_or_else(|| AtlasError::invalid("The virtual disk size could not be estimated safely."))
}

fn check_space(available: u64, required: u64) -> Result<(), AtlasError> {
    if available < required {
        return Err(AtlasError::new(ErrorKind::DiskFull, "The destination does not have enough free space for migration.")
            .hint(format!("Free at least {:.1} GiB for the disk, retained backup, and working space. {:.1} GiB is available.",
                required as f64 / 1073741824.0, available as f64 / 1073741824.0)));
    }
    Ok(())
}

pub fn ensure_space(path: &Path, size: u64, copies: u64) -> Result<(), AtlasError> {
    check_space(available_space(path)?, required_space(size, copies)?)
}

#[cfg(windows)]
fn available_space(path: &Path) -> Result<u64, AtlasError> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    let success = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        return Err(AtlasError::invalid(
            "Could not read free space on the destination drive. Migration was stopped.",
        )
        .detail(std::io::Error::last_os_error().to_string()));
    }
    Ok(available)
}

#[cfg(not(windows))]
fn available_space(_: &Path) -> Result<u64, AtlasError> {
    Err(AtlasError::invalid("WSL migration requires Windows."))
}

fn save_new(path: &Path, text: &str) -> Result<(), AtlasError> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn recovery_guide(source: &WslDistro, dest: &Path, backup_dir: &Path, backup: &Path) -> String {
    let archive = path_text(backup);
    let restored = path_text(&backup_dir.join("restored-distro"));
    let suffix = backup_dir.file_name().unwrap().to_string_lossy();
    let recovered = format!(
        "atlas-recovered-{}",
        suffix.trim_start_matches("atlas-migration-backup-")
    );
    format!("WSL migration recovery\n\nDistribution: {}\nOriginal folder: {}\nDestination: {}\nBackup: {}\n\n\
        Save your work and keep other tools from starting this distribution during migration.\n\
        If the app closes, wait for its WSL command to finish before retrying. Do not delete either disk or unregister any distribution.\n\n\
        If the disk stays locked after stopping this distribution, save work in ALL distributions and quit Docker Desktop.\n\
        Then run the following command before retrying. It stops ALL WSL workloads:\n\
        wsl --shutdown\n\n\
        The backup is usable only when BACKUP-COMPLETE.txt exists beside this guide.\n\
        Without that marker, export or byte verification did not finish. Preserve the original disk and any partial files.\n\n\
        Check the registered location in PowerShell:\n\
        wsl --list --verbose\n\
        Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | ForEach-Object {{ Get-ItemProperty -LiteralPath $_.PSPath }} | Select-Object DistributionName, BasePath, VhdFileName\n\n\
        If the disk moved but boot failed, preserve both folders and inspect the reported WSL error.\n\
        If moving back is appropriate, use Atlas migration again and select the original empty folder.\n\
        Atlas must establish private destination permissions before moving the disk back. A raw cross-drive move can inherit broad permissions.\n\n\
        Restore a completed backup as a separate distribution, without deleting the current one:\n\
        wsl --import {} {} {} --vhd --version 2\n\
        wsl -d {} -u root --cd / -- true\n\n\
        If that recovery name or folder already exists, choose a new name and empty folder. Never unregister an existing distribution to make room.\n\
        An imported backup may log in as root. Set its default user after confirming the correct Linux username.\n\
        If this was your default distribution, make the recovered copy default only after verifying your files.\n\
        The recovered copy has a new distribution name. Enable Docker Desktop WSL integration for that name after recovery.\n\
        Update Windows Terminal profiles, editor connections, and any \\\\wsl.localhost paths that should use the recovered copy.\n\
        Docker Desktop images, containers, and named volumes are stored separately and are not included in this backup.\n\
        Windows files mounted under /mnt are also outside this backup. Keep their own backups and mount configuration.\n\
        Avoid running services in the original and recovered copies together until you have checked ports and shared external data.\n\
        Verify that the Linux filesystem and your home directory are writable, then restart your applications and check Docker and project mounts.\n\
        Keep the backup until you have checked your files and applications. Do not delete recovery files on a failed run.\n",
        source.name, source.base_path, path_text(dest), archive,
        quote(&recovered), quote(&restored), quote(&archive), quote(&recovered))
}

fn recovery_error(error: AtlasError, message: &str, guide: &Path) -> AtlasError {
    let next_step = error.hint.unwrap_or_default();
    let detail = match error.detail {
        Some(detail) => format!("{}\n{}", error.message, detail),
        None => error.message,
    };
    AtlasError::new(error.kind, message)
        .hint(format!("{} Keep all migration files. Recovery instructions: {}. Refresh the distribution list before retrying.", next_step, path_text(guide)).trim().to_string())
        .detail(detail)
}

fn at_step(error: AtlasError, step: &str) -> AtlasError {
    let mut result = AtlasError::new(error.kind, format!("{}: {}", step, error.message))
        .detail(error.detail.unwrap_or_default());
    result.hint = error.hint;
    result
}

fn wait_for_disk_release(path: &Path, timeout: Duration) -> Result<fs::File, AtlasError> {
    let started = Instant::now();
    loop {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const GENERIC_READ: u32 = 0x80000000;
            const DELETE: u32 = 0x00010000;
            const READ_CONTROL: u32 = 0x00020000;
            const WRITE_DAC: u32 = 0x00040000;
            options
                .access_mode(GENERIC_READ | DELETE | READ_CONTROL | WRITE_DAC)
                .share_mode(FILE_SHARE_READ_DELETE);
        }
        let error = match options.open(path) {
            Ok(file) => return Ok(file),
            Err(error) => error,
        };
        if !matches!(error.raw_os_error(), Some(32 | 33)) {
            return Err(error.into());
        }
        if started.elapsed() >= timeout {
            return Err(AtlasError::new(ErrorKind::Busy, "The virtual disk is still open in another process. It was not moved.")
                .hint("Save work in all WSL distributions, quit Docker Desktop, and run wsl --shutdown before retrying."));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn migrate(
    source: &WslDistro,
    dest: &Path,
    mut run: impl FnMut(&[&str]) -> Result<(), AtlasError>,
    mut inspect: impl FnMut() -> Result<Vec<WslDistro>, AtlasError>,
    mut log: impl FnMut(String),
) -> Result<MigrateResult, AtlasError> {
    #[cfg(windows)]
    let _destination_guard = crate::wsl_migration_acl::secure_destination(dest)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let backup_dir = dest
        .parent()
        .ok_or_else(|| AtlasError::invalid("Choose a dedicated destination folder."))?
        .join(format!("atlas-migration-backup-{}", nonce));
    #[cfg(windows)]
    let _backup_guard = crate::wsl_migration_acl::create_private_directory(&backup_dir)?;
    #[cfg(not(windows))]
    fs::create_dir(&backup_dir)?;
    let guide = backup_dir.join("RECOVERY.txt");
    let extension = Path::new(&source.vhd_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("vhdx");
    let backup = backup_dir.join(format!("backup.{}", extension));
    save_new(&guide, &recovery_guide(source, dest, &backup_dir, &backup))?;
    log(format!("# Recovery instructions: {}", path_text(&guide)));
    let result = migrate_with_backup(source, dest, &backup, &mut run, &mut inspect, &mut log);
    result.map_err(|error| {
        recovery_error(
            error,
            "Migration did not finish. Check the recovery guide before continuing.",
            &guide,
        )
    })?;
    Ok(MigrateResult {
        backup_path: path_text(&backup),
        recovery_path: path_text(&guide),
    })
}

fn verify_copy(source: &Path, backup: &Path) -> Result<(), AtlasError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(FILE_SHARE_READ_DELETE);
    }
    let mut original = options.open(source)?;
    let mut copied = OpenOptions::new().read(true).write(true).open(backup)?;
    let size = original.metadata()?.len();
    if size == 0 || size != copied.metadata()?.len() {
        return Err(AtlasError::invalid(
            "The backup size does not match the original disk. The disk was not moved.",
        ));
    }
    let mut original_buf = vec![0; 1024 * 1024];
    let mut copied_buf = vec![0; 1024 * 1024];
    loop {
        let count = original.read(&mut original_buf)?;
        if count == 0 {
            break;
        }
        copied.read_exact(&mut copied_buf[..count])?;
        if original_buf[..count] != copied_buf[..count] {
            return Err(AtlasError::invalid(
                "The backup contents do not match the original disk. The disk was not moved.",
            ));
        }
    }
    copied.sync_all()?;
    Ok(())
}

fn migrate_with_backup(
    source: &WslDistro,
    dest: &Path,
    backup: &Path,
    run: &mut impl FnMut(&[&str]) -> Result<(), AtlasError>,
    inspect: &mut impl FnMut() -> Result<Vec<WslDistro>, AtlasError>,
    log: &mut impl FnMut(String),
) -> Result<(), AtlasError> {
    let backup_text = path_text(backup);
    let dest_text = path_text(dest);
    log(format!("$ wsl --terminate {}", quote(&source.name)));
    run(&["--terminate", &source.name]).map_err(|e| {
        at_step(
            e,
            "Stopping the distribution failed; the disk was not moved",
        )
    })?;
    let source_guard = wait_for_disk_release(Path::new(&source.vhd_path), Duration::from_secs(5))?;
    #[cfg(windows)]
    crate::wsl_migration_acl::secure_disk_handle(&source_guard)?;
    drop(source_guard);
    log(format!(
        "$ wsl --export {} {} --format vhd",
        quote(&source.name),
        quote(&backup_text)
    ));
    run(&["--export", &source.name, &backup_text, "--format", "vhd"])
        .map_err(|e| at_step(e, "Backup export failed; the disk was not moved"))?;
    if !backup.is_file() || fs::metadata(backup)?.len() == 0 {
        return Err(AtlasError::invalid(
            "WSL did not produce a nonempty backup. The disk was not moved.",
        ));
    }
    log("# Verifying the VHD backup byte for byte".to_string());
    verify_copy(Path::new(&source.vhd_path), backup)?;
    save_new(
        &backup.with_file_name("BACKUP-COMPLETE.txt"),
        "WSL VHD export and byte verification completed.\n",
    )?;

    let distros = inspect()?;
    let current = source_distro(&source.name, &distros)?;
    if Path::new(&current.base_path).canonicalize()?
        != Path::new(&source.base_path).canonicalize()?
        || Path::new(&current.vhd_path).canonicalize()?
            != Path::new(&source.vhd_path).canonicalize()?
        || current.registration_id != source.registration_id
        || current.default_uid != source.default_uid
        || current.version != source.version
        || current.is_default != source.is_default
    {
        return Err(AtlasError::invalid(
            "The registered distribution changed during backup. The disk was not moved.",
        ));
    }
    if path_key(&destination(dest, &distros)?) != path_key(dest) {
        return Err(AtlasError::invalid(
            "The destination location changed during backup. The disk was not moved.",
        ));
    }
    ensure_space(dest, fs::metadata(&current.vhd_path)?.len(), 1)?;
    log(format!("$ wsl --terminate {}", quote(&source.name)));
    run(&["--terminate", &source.name]).map_err(|e| {
        at_step(
            e,
            "Stopping the distribution after export failed; the disk was not moved",
        )
    })?;
    log("# Waiting for WSL to release the virtual disk".to_string());
    let movement_guard =
        wait_for_disk_release(Path::new(&current.vhd_path), Duration::from_secs(5))?;
    #[cfg(windows)]
    crate::wsl_migration_acl::secure_disk_handle(&movement_guard)?;
    drop(movement_guard);
    log(format!(
        "$ wsl --manage {} --move {}",
        quote(&source.name),
        quote(&dest_text)
    ));
    run(&["--manage", &source.name, "--move", &dest_text]).map_err(|e| {
        at_step(
            e,
            "WSL's move command failed; the registered location may have changed",
        )
    })?;

    let moved_disk = dest.join(
        Path::new(&source.vhd_path)
            .file_name()
            .ok_or_else(|| AtlasError::invalid("The virtual disk filename is missing."))?,
    );
    #[cfg(windows)]
    crate::wsl_migration_acl::secure_disk(&moved_disk)?;

    let moved_distros = inspect()?;
    let moved = source_distro(&source.name, &moved_distros)?;
    if path_key(&Path::new(&moved.base_path).canonicalize()?) != path_key(dest)
        || moved.registration_id != source.registration_id
        || moved.default_uid != source.default_uid
        || moved.version != source.version
        || moved.is_default != source.is_default
    {
        return Err(AtlasError::invalid(
            "WSL reported a move, but the registered location or settings could not be verified.",
        ));
    }
    log(format!(
        "# Checking boot, writable root filesystem, and the default user's home for {}",
        quote(&source.name)
    ));
    run(&[
        "-d",
        &source.name,
        "--cd",
        "/",
        "--exec",
        "sh",
        "-c",
        HEALTH_CHECK,
    ])
    .map_err(|e| {
        at_step(
            e,
            "The disk moved, but the filesystem or user write check failed",
        )
    })?;
    if !source.running {
        log(format!("$ wsl --terminate {}", quote(&source.name)));
        run(&["--terminate", &source.name]).map_err(|e| {
            at_step(
                e,
                "Migration and boot succeeded, but the distribution could not be stopped",
            )
        })?;
    }
    log(format!(
        "# Migration and boot verified. Backup kept at {}",
        backup_text
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fixture {
        root: PathBuf,
        source: WslDistro,
        dest: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/migration-tests");
            fs::create_dir_all(&parent).unwrap();
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = parent.join(format!("case-{}", id));
            fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            let base = root.join("source");
            let dest = root.join("destination");
            fs::create_dir(&base).unwrap();
            fs::create_dir(&dest).unwrap();
            let disk = base.join("custom.vhdx");
            fs::write(&disk, "disk contents").unwrap();
            let source = WslDistro {
                name: "test-distro".into(),
                registration_id: "test-id".into(),
                default_uid: Some(1000),
                version: 2,
                running: false,
                is_default: true,
                base_path: path_text(&base),
                vhd_path: path_text(&disk),
                vhd_size_bytes: 13,
            };
            Self { root, source, dest }
        }

        fn backups(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.root)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| {
                    p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("atlas-migration-backup-")
                })
                .collect()
        }

        fn run(
            &self,
            fail: Option<usize>,
            bad_registration: bool,
        ) -> (Result<MigrateResult, AtlasError>, Vec<String>) {
            let commands = RefCell::new(Vec::new());
            let moved = Cell::new(false);
            let result = migrate(
                &self.source,
                &self.dest,
                |args| {
                    let mut calls = commands.borrow_mut();
                    calls.push(format!("wsl {}", args.join(" ")));
                    if fail == Some(calls.len()) {
                        return Err(AtlasError::new(ErrorKind::Permission, "injected failure"));
                    }
                    match args[0] {
                        "--export" => {
                            fs::copy(&self.source.vhd_path, args[2]).unwrap();
                        }
                        "--manage" => {
                            fs::rename(&self.source.vhd_path, self.dest.join("custom.vhdx"))
                                .unwrap();
                            moved.set(true);
                        }
                        _ => {}
                    }
                    Ok(())
                },
                || {
                    let mut current = self.source.clone();
                    if moved.get() {
                        current.vhd_path = path_text(&self.dest.join("custom.vhdx"));
                        if !bad_registration {
                            current.base_path = path_text(&self.dest);
                        }
                    }
                    Ok(vec![current])
                },
                |_| {},
            );
            (result, commands.into_inner())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/migration-tests")
                .canonicalize()
                .unwrap();
            if self.root.parent() == Some(parent.as_path())
                && self.root.canonicalize().ok().as_ref() == Some(&self.root)
            {
                fs::remove_dir_all(&self.root).unwrap();
            }
        }
    }

    #[cfg(windows)]
    fn read_permissions(path: &Path) -> serde_json::Value {
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", r#"
                $ErrorActionPreference = 'Stop'
                $acl = Get-Acl -LiteralPath $env:ATLAS_PERMISSION_TEST_PATH
                [pscustomobject]@{
                    CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
                    Protected = $acl.AreAccessRulesProtected
                    Entries = @($acl.Access | ForEach-Object {
                        [pscustomobject]@{
                            Sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
                            Rights = $_.FileSystemRights.ToString()
                            Type = $_.AccessControlType.ToString()
                        }
                    })
                } | ConvertTo-Json -Depth 4 -Compress
            "#])
            .env("ATLAS_PERMISSION_TEST_PATH", path)
            .env_remove("PSModulePath")
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[cfg(windows)]
    fn assert_private_permissions(path: &Path) {
        let permissions = read_permissions(path);
        let mut allowed: Vec<_> = permissions["Entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                assert_eq!(entry["Type"], "Allow");
                assert_eq!(entry["Rights"], "FullControl");
                entry["Sid"].as_str().unwrap().to_string()
            })
            .collect();
        let mut expected = vec![
            permissions["CurrentUser"].as_str().unwrap().to_string(),
            "S-1-5-18".into(),
            "S-1-5-32-544".into(),
        ];
        allowed.sort();
        expected.sort();
        assert_eq!(allowed, expected);
    }

    #[test]
    #[cfg(windows)]
    fn backup_and_same_volume_moved_disk_have_private_permissions() {
        let fixture = Fixture::new();
        let parent_before = read_permissions(&fixture.root);
        let source_directory_before = read_permissions(Path::new(&fixture.source.base_path));
        let (result, _) = fixture.run(None, false);
        let result = result.unwrap();
        let backup = Path::new(&result.backup_path);
        assert_private_permissions(backup.parent().unwrap());
        assert_private_permissions(backup);
        assert_private_permissions(&fixture.dest);
        assert_private_permissions(&fixture.dest.join("custom.vhdx"));
        assert_eq!(read_permissions(&fixture.root), parent_before);
        assert_eq!(
            read_permissions(Path::new(&fixture.source.base_path)),
            source_directory_before
        );
        assert_eq!(read_permissions(&fixture.dest)["Protected"], true);
        assert_eq!(
            read_permissions(&fixture.dest.join("custom.vhdx"))["Protected"],
            true
        );
    }

    #[test]
    #[cfg(windows)]
    fn replaced_source_is_private_even_when_post_move_inspection_fails() {
        let fixture = Fixture::new();
        let inspections = Cell::new(0);
        let result = migrate(
            &fixture.source,
            &fixture.dest,
            |args| {
                match args[0] {
                    "--export" => {
                        fs::copy(&fixture.source.vhd_path, args[2])?;
                    }
                    "--manage" => {
                        fs::rename(&fixture.source.vhd_path, fixture.dest.join("custom.vhdx"))?;
                    }
                    _ => {}
                }
                Ok(())
            },
            || {
                inspections.set(inspections.get() + 1);
                if inspections.get() == 2 {
                    return Err(AtlasError::invalid("injected inspection failure"));
                }
                fs::rename(
                    &fixture.source.vhd_path,
                    fixture.root.join("original-private.vhdx"),
                )?;
                fs::write(&fixture.source.vhd_path, b"disk contents")?;
                Ok(vec![fixture.source.clone()])
            },
            |_| {},
        );
        assert!(result.is_err());
        assert_private_permissions(&fixture.dest.join("custom.vhdx"));
        let backup = fixture.backups().pop().unwrap();
        assert_private_permissions(&backup.join("backup.vhdx"));
        assert!(backup.join("BACKUP-COMPLETE.txt").is_file());
        let guide = fs::read_to_string(backup.join("RECOVERY.txt")).unwrap();
        assert!(guide.contains("use Atlas migration again"));
        assert!(!guide.contains("wsl --manage"));
    }

    #[test]
    #[cfg(windows)]
    fn private_directory_creation_preserves_existing_files_and_handles_unicode() {
        let fixture = Fixture::new();
        let directory = fixture.root.join("backup ' $folder Ω");
        let guard = crate::wsl_migration_acl::create_private_directory(&directory).unwrap();
        let sentinel = directory.join("sentinel");
        fs::write(&sentinel, b"keep").unwrap();
        assert_private_permissions(&directory);
        assert_private_permissions(&sentinel);
        assert!(crate::wsl_migration_acl::create_private_directory(&directory).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");
        assert!(fs::rename(&directory, fixture.root.join("replaced")).is_err());
        drop(guard);
        fs::rename(&directory, fixture.root.join("replaced")).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn destination_permission_setup_rejects_occupied_folders_before_commands() {
        let fixture = Fixture::new();
        let sentinel = fixture.dest.join("sentinel");
        fs::write(&sentinel, b"keep").unwrap();
        let (result, commands) = fixture.run(None, false);
        assert!(result.is_err());
        assert!(commands.is_empty());
        assert!(fixture.backups().is_empty());
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");
        assert!(Path::new(&fixture.source.vhd_path).exists());
    }

    #[test]
    fn migration_verifies_backup_location_and_boot_without_unregistering() {
        let fixture = Fixture::new();
        let (result, commands) = fixture.run(None, false);
        let result = result.unwrap();
        assert_eq!(commands.len(), 6);
        assert!(commands[1].ends_with("--format vhd"));
        assert!(commands[3].contains("--move"));
        assert!(commands[4].contains("--exec sh -c"));
        assert!(commands[5].starts_with("wsl --terminate"));
        assert!(!commands
            .iter()
            .any(|c| c.contains("--unregister") || c.contains("--import")));
        assert_eq!(
            fs::read(fixture.dest.join("custom.vhdx")).unwrap(),
            b"disk contents"
        );
        assert!(Path::new(&result.backup_path).is_file());
        assert!(Path::new(&result.recovery_path).is_file());
        let guide = fs::read_to_string(result.recovery_path).unwrap();
        assert!(guide.contains("--import 'atlas-recovered-"));
        assert!(guide.contains("BACKUP-COMPLETE.txt"));
        assert!(guide.contains("Never unregister"));
    }

    #[test]
    fn every_command_failure_preserves_recovery_and_stops_the_sequence() {
        for step in 1..=6 {
            let fixture = Fixture::new();
            let (result, commands) = fixture.run(Some(step), false);
            let error = result.err().unwrap();
            assert_eq!(commands.len(), step);
            assert_eq!(error.kind, ErrorKind::Permission);
            assert!(error.hint.unwrap().contains("RECOVERY.txt"));
            assert!(error.detail.unwrap().contains("injected failure"));
            let backup = fixture.backups().pop().unwrap();
            assert!(backup.join("RECOVERY.txt").is_file());
            assert_eq!(backup.join("BACKUP-COMPLETE.txt").exists(), step >= 3);
            assert_eq!(Path::new(&fixture.source.vhd_path).exists(), step <= 4);
            assert_eq!(fixture.dest.join("custom.vhdx").exists(), step >= 5);
        }
    }

    #[test]
    fn wrong_registration_after_move_is_not_reported_as_success() {
        let fixture = Fixture::new();
        let (result, commands) = fixture.run(None, true);
        assert!(result.is_err());
        assert_eq!(commands.len(), 4);
        assert!(fixture.dest.join("custom.vhdx").is_file());
        assert!(fixture.backups()[0].join("backup.vhdx").is_file());
    }

    #[test]
    fn occupied_relative_missing_and_overlapping_destinations_are_rejected() {
        let fixture = Fixture::new();
        let distros = vec![fixture.source.clone()];
        assert!(destination(&fixture.dest, &distros).is_ok());
        assert!(destination(Path::new("relative"), &distros).is_err());
        assert!(destination(&fixture.root.join("missing"), &distros).is_err());
        assert!(destination(&fixture.root, &distros).is_err());
        assert!(destination(Path::new(&fixture.source.base_path), &distros).is_err());
        let nested = Path::new(&fixture.source.base_path).join("empty");
        fs::create_dir(&nested).unwrap();
        assert!(destination(&nested, &distros).is_err());
        fs::write(fixture.dest.join("keep.txt"), "unrelated content").unwrap();
        assert!(destination(&fixture.dest, &distros).is_err());
        assert_eq!(
            fs::read_to_string(fixture.dest.join("keep.txt")).unwrap(),
            "unrelated content"
        );
    }

    #[test]
    fn backend_rejects_missing_managed_and_unsupported_distributions() {
        let fixture = Fixture::new();
        assert!(source_distro("--help", &[fixture.source.clone()]).is_err());
        assert!(source_distro("missing", &[fixture.source.clone()]).is_err());
        let mut distro = fixture.source.clone();
        distro.name = "docker-desktop".into();
        assert!(source_distro(&distro.name, &[distro.clone()]).is_err());
        distro.name = "test-distro".into();
        distro.version = 1;
        assert!(source_distro(&distro.name, &[distro.clone()]).is_err());
        distro.version = 2;
        distro.vhd_path.clear();
        assert!(source_distro(&distro.name, &[distro.clone()]).is_err());
    }

    #[test]
    fn free_space_check_includes_backup_and_refuses_overflow() {
        assert_eq!(required_space(100, 2).unwrap(), SPACE_RESERVE + 200);
        assert!(required_space(u64::MAX, 2).is_err());
        assert!(check_space(100, 101).is_err());
        assert!(check_space(101, 101).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn reads_available_space_for_the_destination_directory() {
        let fixture = Fixture::new();
        assert!(available_space(&fixture.dest).unwrap() > 0);
        assert!(available_space(&fixture.root.join("missing")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn junction_into_a_registered_distribution_is_rejected() {
        let fixture = Fixture::new();
        let target = Path::new(&fixture.source.base_path).join("nested");
        fs::create_dir(&target).unwrap();
        let link = fixture.root.join("junction");
        let status = std::process::Command::new("powershell")
            .env("ATLAS_TEST_LINK", &link).env("ATLAS_TEST_TARGET", &target)
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:ATLAS_TEST_LINK -Target $env:ATLAS_TEST_TARGET | Out-Null"])
            .status().unwrap();
        assert!(status.success());
        assert!(destination(&link, &[fixture.source.clone()]).is_err());
        assert!(target.is_dir());
    }

    #[test]
    fn backup_verification_rejects_empty_truncated_and_corrupt_copies() {
        let fixture = Fixture::new();
        let backup = fixture.root.join("backup.vhdx");
        for contents in [b"".as_slice(), b"disk", b"disk contentX"] {
            fs::write(&backup, contents).unwrap();
            assert!(verify_copy(Path::new(&fixture.source.vhd_path), &backup).is_err());
        }
        fs::copy(&fixture.source.vhd_path, &backup).unwrap();
        assert!(verify_copy(Path::new(&fixture.source.vhd_path), &backup).is_ok());
        assert_eq!(
            fs::read(&fixture.source.vhd_path).unwrap(),
            b"disk contents"
        );
    }

    #[test]
    fn destination_changed_during_backup_is_preserved_and_not_moved_into() {
        let fixture = Fixture::new();
        let calls = RefCell::new(Vec::new());
        let result = migrate(
            &fixture.source,
            &fixture.dest,
            |args| {
                calls.borrow_mut().push(args[0].to_string());
                if args[0] == "--export" {
                    fs::copy(&fixture.source.vhd_path, args[2]).unwrap();
                    fs::write(fixture.dest.join("keep.txt"), "new unrelated file").unwrap();
                }
                Ok(())
            },
            || Ok(vec![fixture.source.clone()]),
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(*calls.borrow(), vec!["--terminate", "--export"]);
        assert!(Path::new(&fixture.source.vhd_path).is_file());
        assert_eq!(
            fs::read_to_string(fixture.dest.join("keep.txt")).unwrap(),
            "new unrelated file"
        );
        assert!(fixture.backups()[0].join("BACKUP-COMPLETE.txt").is_file());
    }

    #[test]
    fn changed_registration_or_login_user_is_not_moved() {
        for change_user in [true, false] {
            let fixture = Fixture::new();
            let result = migrate(
                &fixture.source,
                &fixture.dest,
                |args| {
                    assert_ne!(args[0], "--manage");
                    if args[0] == "--export" {
                        fs::copy(&fixture.source.vhd_path, args[2]).unwrap();
                    }
                    Ok(())
                },
                || {
                    let mut changed = fixture.source.clone();
                    if change_user {
                        changed.default_uid = Some(2000);
                    } else {
                        changed.registration_id = "different-id".to_string();
                    }
                    Ok(vec![changed])
                },
                |_| {},
            );
            assert!(result.is_err());
            assert!(Path::new(&fixture.source.vhd_path).is_file());
        }
    }

    #[test]
    fn running_distribution_is_left_running_after_verification() {
        let mut fixture = Fixture::new();
        fixture.source.running = true;
        let (result, commands) = fixture.run(None, false);
        assert!(result.is_ok());
        assert_eq!(commands.len(), 5);
        assert!(commands.last().unwrap().contains("--exec sh -c"));
    }

    #[cfg(windows)]
    #[test]
    fn network_and_device_paths_are_rejected_without_network_access() {
        assert!(!is_local_path(Path::new(r"\\server\share\folder")));
        assert!(!is_local_path(Path::new(r"\\.\PhysicalDrive0")));
        assert!(destination(Path::new(r"\\server\share\folder"), &[]).is_err());
        assert!(destination(Path::new(r"C:\"), &[]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn locked_disk_is_rejected_without_waiting_indefinitely() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&fixture.source.vhd_path)
            .unwrap();
        let error =
            wait_for_disk_release(Path::new(&fixture.source.vhd_path), Duration::ZERO).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Busy);
        assert!(error.hint.unwrap().contains("wsl --shutdown"));
        drop(held);
        assert!(wait_for_disk_release(Path::new(&fixture.source.vhd_path), Duration::ZERO).is_ok());
    }

    #[test]
    fn command_display_escapes_powershell_metacharacters() {
        assert_eq!(quote("D:\\O'Brien\\$(secret)"), "'D:\\O''Brien\\$(secret)'");
        assert_eq!(
            path_key(Path::new(r"\\?\C:\WSL\Ubuntu")),
            path_key(Path::new("c:/wsl/ubuntu"))
        );
    }

    #[test]
    fn repeated_runs_keep_separate_backups() {
        let fixture = Fixture::new();
        assert!(fixture.run(Some(1), false).0.is_err());
        assert!(fixture.run(Some(1), false).0.is_err());
        assert_eq!(fixture.backups().len(), 2);
    }

    #[test]
    fn migration_gate_rejects_reentry_and_releases_on_return() {
        let gate = MigrationState::default();
        let guard = gate.0.try_write().unwrap();
        assert!(gate.0.try_write().is_err());
        let result: Result<(), AtlasError> = tauri::async_runtime::block_on(
            gate.clone()
                .run_operation(|| panic!("A blocked operation must not run.")),
        );
        assert_eq!(result.unwrap_err().kind, ErrorKind::Busy);
        drop(guard);
        assert!(gate.0.try_write().is_ok());
        assert_eq!(
            tauri::async_runtime::block_on(gate.run_operation(|| Ok(7))).unwrap(),
            7
        );
    }

    #[test]
    fn active_operations_block_migration_until_their_worker_finishes() {
        let gate = MigrationState::default();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let operation = tauri::async_runtime::spawn(gate.clone().run_operation(move || {
            started_tx.send(()).unwrap();
            finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Err::<(), _>(AtlasError::invalid("test failure"))
        }));
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(gate.0.try_write().is_err());
        assert!(gate.0.try_read().is_ok());
        finish_tx.send(()).unwrap();
        assert!(tauri::async_runtime::block_on(operation).unwrap().is_err());
        assert!(gate.0.try_write().is_ok());
    }

    #[test]
    #[ignore = "Requires ATLAS_MIGRATION_ROOTFS; moves and restores a disposable WSL distribution"]
    fn live_migration_and_backup_restore() {
        use std::process::Command;

        fn run(args: &[&str]) -> Result<(), AtlasError> {
            let mut command = Command::new("wsl");
            command.env("WSL_UTF8", "1").args(args);

            let output = command.output()?;
            if output.status.success() {
                return Ok(());
            }
            Err(format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&output.stdout)
            )
            .into())
        }

        struct OwnedDistro {
            name: String,
            id: String,
        }
        impl Drop for OwnedDistro {
            fn drop(&mut self) {
                let distros = crate::wsl::read_distros().unwrap();
                if distros
                    .iter()
                    .any(|d| d.name == self.name && d.registration_id == self.id)
                {
                    run(&["--unregister", &self.name]).unwrap();
                }
            }
        }

        let archive = std::env::var("ATLAS_MIGRATION_ROOTFS")
            .expect("Provide the disposable root filesystem archive");
        assert!(Path::new(&archive).is_file());
        let before = crate::wsl::read_distros().unwrap();
        let default_id = before
            .iter()
            .find(|d| d.is_default)
            .map(|d| d.registration_id.clone());
        let fixture = Fixture::new();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("atlas-migration-test-{}", nonce);
        let temp_parent = std::env::temp_dir().canonicalize().unwrap();
        let original = temp_parent.join(&name);
        assert!(!before.iter().any(|d| d.name == name));
        fs::create_dir(&original).unwrap();
        run(&[
            "--import",
            &name,
            &path_text(&original),
            &archive,
            "--version",
            "2",
        ])
        .unwrap();
        let source = crate::wsl::read_distros()
            .unwrap()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap();
        let owned = OwnedDistro {
            name: name.clone(),
            id: source.registration_id,
        };
        run(&["--manage", &name, "--set-default-user", "testuser"]).unwrap();
        run(&["--terminate", &name]).unwrap();
        if std::env::var("ATLAS_MIGRATION_ALLOW_SHUTDOWN").as_deref() == Ok("1") {
            run(&["--shutdown"]).unwrap();
        }
        let distros = crate::wsl::read_distros().unwrap();
        let source = source_distro(&name, &distros).unwrap();
        assert_eq!(source.default_uid, Some(1000));
        let dest = destination(&fixture.dest, &distros).unwrap();
        ensure_space(&dest, source.vhd_size_bytes, 2).unwrap();
        let result = migrate(source, &dest, run, crate::wsl::read_distros, |line| {
            println!("{}", line)
        })
        .unwrap();
        let moved = crate::wsl::read_distros()
            .unwrap()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap();
        assert_eq!(moved.registration_id, owned.id);
        assert_eq!(moved.default_uid, Some(1000));
        assert!(!moved.running);
        assert_eq!(path_key(Path::new(&moved.base_path)), path_key(&dest));
        assert_private_permissions(Path::new(&result.backup_path));
        assert_private_permissions(&dest);
        let read_only_check = format!(
            "printf '%s\\n' 'disk / ext4 ro 0 0' > /home/testuser/atlas-test-mounts\n{}",
            HEALTH_CHECK.replace("/proc/mounts", "/home/testuser/atlas-test-mounts")
        );
        assert!(run(&["-d", &name, "--exec", "sh", "-c", &read_only_check]).is_err());
        let bad_home_check = format!("HOME=/atlas-missing-home\n{}", HEALTH_CHECK);
        assert!(run(&["-d", &name, "--exec", "sh", "-c", &bad_home_check]).is_err());
        run(&["-d", &name, "--exec", "sh", "-c", HEALTH_CHECK]).unwrap();
        run(&[
            "-d",
            &name,
            "--exec",
            "rm",
            "/home/testuser/atlas-test-mounts",
        ])
        .unwrap();
        run(&[
            "-d",
            &name,
            "-u",
            "root",
            "--",
            "test",
            "-f",
            "/migration-marker",
        ])
        .unwrap();

        let restored_name = format!("atlas-recovery-test-{}", nonce);
        let restored_dir = Path::new(&result.backup_path)
            .parent()
            .unwrap()
            .join("restored-distro");
        run(&[
            "--import",
            &restored_name,
            &path_text(&restored_dir),
            &result.backup_path,
            "--vhd",
            "--version",
            "2",
        ])
        .unwrap();
        let restored = crate::wsl::read_distros()
            .unwrap()
            .into_iter()
            .find(|d| d.name == restored_name)
            .unwrap();
        let restored_owned = OwnedDistro {
            name: restored_name.clone(),
            id: restored.registration_id,
        };
        run(&[
            "-d",
            &restored_name,
            "-u",
            "root",
            "--",
            "test",
            "-f",
            "/migration-marker",
        ])
        .unwrap();
        assert_private_permissions(&restored_dir);
        run(&["--manage", &restored_name, "--set-default-user", "testuser"]).unwrap();
        run(&["-d", &restored_name, "--exec", "sh", "-c", HEALTH_CHECK]).unwrap();
        drop(restored_owned);
        drop(owned);
        if original.exists() {
            assert_eq!(
                original.canonicalize().unwrap().parent(),
                Some(temp_parent.as_path())
            );
            assert_eq!(original.file_name().unwrap().to_str(), Some(name.as_str()));
            fs::remove_dir_all(&original).unwrap();
        }
        let after = crate::wsl::read_distros().unwrap();
        assert_eq!(
            default_id,
            after
                .iter()
                .find(|d| d.is_default)
                .map(|d| d.registration_id.clone())
        );
        assert_eq!(before.len(), after.len());
    }
}
