<p align="center">
  <img alt="Workspace Atlas icon" src="src-tauri/icons/128x128@2x.png" width="128">
</p>

<h1 align="center">Workspace Atlas</h1>

<p align="center">
  <strong>Your dev environment, mapped and managed.</strong><br>
  A Windows app for managing Docker, WSL2, and installed packages in one place.
</p>

<p align="center">
  <a href="https://github.com/adeltcode/workspace-atlas/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/adeltcode/workspace-atlas"></a>
  <a href="#project-status"><img alt="Status: beta" src="https://img.shields.io/badge/status-beta-E6833A"></a>
  <a href="https://github.com/adeltcode/workspace-atlas/actions/workflows/ci.yml"><img alt="Test status" src="https://github.com/adeltcode/workspace-atlas/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/adeltcode/workspace-atlas"></a>
  <img alt="Platform: Windows x64" src="https://img.shields.io/badge/platform-Windows%20x64-0078D4">
  <a href="https://v2.tauri.app"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white"></a>
  <a href="https://react.dev"><img alt="React 19" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript 5.8" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://www.rust-lang.org"><img alt="Rust" src="https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://github.com/adeltcode/workspace-atlas/releases/latest"><strong>Download</strong></a> ·
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#ground-rules">Ground rules</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

Workspace Atlas is a desktop app for keeping a Windows dev machine in order. Use it to clean up Docker, manage WSL distros, and keep track of installed packages, instead of juggling separate scripts and commands.

Every disk or Docker operation prints the real command it runs, so you can check it or copy it. No telemetry, no account.

> [!NOTE]
> Workspace Atlas is in beta. Features can change between versions, and some parts haven't been tested on a real system yet. See [Project status](#project-status).

## Features

### Docker

- **Overview**: engine status, live CPU and memory charts, and a disk usage breakdown
- **Images, Containers, Volumes, Networks**: browse, inspect, and remove them, start and stop containers, read logs, and open a shell inside a container
- **Compose**: live service status and logs for each project, in-app editing of compose files, Dockerfiles, and `.env`, and a shortcut to open the project in your editor
- **Prune**: clean up at three levels, with a dry-run estimate before anything is deleted
- **Backup**: save volumes and Compose projects to a folder you choose, and restore volumes from it
- **Run log**: a history of every prune run

| Level | Removes |
| --- | --- |
| 1 Safe | Dangling images |
| 2 Deep | All unused images not on your keep-list |
| 3 Nuclear | Stopped containers, unused images not on your keep-list, unused volumes, and all build cache |

### WSL

- **Dashboard**: live CPU and memory charts for each distro, disk usage per drive, and your `.wslconfig` limits next to actual use
- **Distro pages**: start, restart, or stop a distro, open its terminal or files, export, clone, or delete it, [move it to another drive](#moving-a-distro-to-another-drive), and compact its virtual disk (VHD), with sizes shown before and after
- **Startup**: turn systemd services on or off
- **Performance**: benchmark cold boots over time and find out what slows your shell down, such as nvm, conda, pyenv, oh-my-zsh, or sdkman
- **Install**: download a distro from the catalog, or import one from a `.tar` file
- **`.wslconfig` and `wsl.conf`**: edit them in the app, with backup and restore

### Packages

- **Package list**: everything installed through 22 sources, in one table you can search, filter by source, and export to CSV
- **Sources**: winget, Chocolatey, Scoop, global npm and pnpm, pip, pipx, uv tools, conda envs, Cargo, Rust toolchains, Ruby gems, .NET tools, .NET SDKs, .NET runtimes, PowerShell, VS Code, VS Code Insiders, Cursor, VSCodium, installed apps, and the Microsoft Store
- **Updates**: winget updates appear after every scan. **Check for updates** also covers npm, pip, and Chocolatey, and needs an internet connection
- **Upgrade**: upgrade winget, npm, pip, and Chocolatey packages one at a time
- **Uninstall**: remove winget, pip, and npm packages and VS Code extensions. First, Atlas shows what depends on the package, which commands you'd lose, whether it's running, and how to reinstall it. Core tools such as Git and Python ask you to type the ID to confirm

### Windows Sandbox

- **Start**: open a clean, throwaway copy of Windows. The network stays off unless you turn it on
- **Share a folder**: show one folder from your PC on the sandbox desktop. It is read-only unless you allow changes
- **Running sandboxes**: open a sandbox's window again, or stop it. Stopping deletes everything inside

### Tools

- **Ports**: see what is listening on each TCP port, on Windows, in Docker containers, and in running WSL distros, and whether other devices can reach it. Close a stuck program after you confirm
- **File locks**: when Windows won't let you delete or move something, see which program holds that file or folder, and close it after you confirm

Atlas won't close Windows, Docker, or WSL's own programs, or anything that needs administrator rights.

### General

- **Overview**: live CPU, memory, and disk use for the whole machine, plus recent activity across the app
- **Command pane**: a built-in terminal that shows each command as it runs. You can type your own commands there too
- **Search**: `Ctrl+K` finds modules, distros, images, containers, and volumes
- **Settings**: choose the backup folder, and export or import your configuration

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search everything |
| `Ctrl+R` | Refresh the current module |
| `` Ctrl+` `` | Show or hide the command pane |
| `↑` `↓` | Move through results, or through command history in the pane |
| `Enter` | Open the highlighted result |
| `Esc` | Close search, a dialog, or a menu |

## Install

1. Download the `x64-setup.exe` file from the [latest release](https://github.com/adeltcode/workspace-atlas/releases/latest).
2. Run it. It installs for your Windows account only.

> [!NOTE]
> The installer isn't code signed, so Windows shows "Windows protected your PC". If you downloaded it from the Releases page, click **More info**, then **Run anyway**. You may see this warning again with each new version.
>
> Some PCs may not offer **Run anyway**, because Windows Smart App Control and company policies can block unsigned apps.

To verify your download, run this in the download folder and compare the result with the checksum in the release notes:

```powershell
Get-FileHash .\Workspace*x64-setup.exe
```

Atlas doesn't update itself. To get a new version, download and run its installer.

### Requirements

| Feature | Requirement |
| --- | --- |
| App | 64-bit Windows with Microsoft Edge WebView2 (included in Windows 11). Tested on Windows 11 |
| Docker | Docker Desktop |
| WSL | WSL 2 |
| Moving a distro | A WSL version with `wsl --manage --move`. Atlas offers to update WSL if yours is too old |
| Packages | Nothing extra. Atlas scans the package tools you have and lists any it can't find |
| Windows Sandbox | Windows Pro, Enterprise, or Education with Windows Sandbox turned on, and the `wsb` command. Older Windows versions don't include `wsb` |

## Ground rules

- Every operation that touches disk or Docker prints the real, copy-pasteable command in the built-in terminal.
- Prune shows a dry-run estimate first, then before and after numbers.
- You have to type a confirmation for the riskiest actions: Nuclear prune, deleting a distro, and uninstalling a core tool.
- Keep-listed images are never pruned.
- Atlas runs without administrator rights. Windows asks for your approval only when an operation needs them: VHD compact, Chocolatey upgrades, and pip when its folder is admin-only.
- Atlas only goes online when you ask it to: downloading distro images, checking for updates, and upgrading packages.

## Moving a distro to another drive

Atlas can move a distro's disk to another drive. It backs up the disk first, verifies the backup, and checks that the distro still boots after the move. If the move fails, follow the recovery guide, which restores the backup as a separate distro without deleting the existing one.

<details>
<summary><strong>Full steps and limits</strong></summary>

**Before you start**

- Save your work in all distros. Atlas shuts down every WSL session to release the disk.
- Quit Docker Desktop. Docker Desktop's own distros must be moved through Docker Desktop.
- Finish active Atlas operations, including terminal commands and Compose log streams. Atlas refuses conflicting operations until the move finishes.
- Close terminals, editors, and other tools that could restart the distro during the move.
- Choose a folder on a local drive, or pick a drive root to get a suggested `WSL\<distro>` folder. Use storage with Windows file permissions and without NTFS compression or file encryption.

**Review screen**

Atlas checks the destination and free space, then lists everything blocking the move on one screen. From there you can update WSL, quit Docker Desktop, choose another destination, or inspect an active terminal task.

- Updates and workload shutdowns ask for confirmation first, then Atlas checks the requirements again.
- New folders are created only when you confirm.
- The move itself has its own confirmation.

Expand **Commands and Windows responses** to see the commands, exit codes, and both output streams. Atlas checks WSL compatibility from the commands WSL advertises, because `wsl --help` can return a nonzero exit code even when the required commands are available.

**During the move**

1. Atlas shuts down all WSL sessions to release the disk.
2. It checks free space.
3. It exports a VHD backup and verifies it byte by byte.
4. It moves the registered disk.
5. It checks that the distro boots with a writable root filesystem and default-user home directory.

Backup and destination permissions are restricted to your Windows account, SYSTEM, and administrators.

**Backup files**

A separate backup folder beside the destination holds `backup.vhdx` and `RECOVERY.txt`. `BACKUP-COMPLETE.txt` appears only after the export and byte verification finish. Keep these files until you've checked your files and applications.

**What gets moved**

Linux packages and paths inside the disk stay as they are. Windows-mounted files, Docker Desktop's separate disk, and global WSL swap storage are not moved or backed up.

**If something goes wrong**

- If the move fails or is interrupted, follow the recovery guide before retrying.
- A recovered backup gets a new distro name. Enable Docker WSL integration for it and update your terminal and editor connections before using it.
- If another tool keeps a lock on the disk after shutdown, close WSL terminals and editors, then retry. Atlas never forces a locked disk to move.

</details>

## Build from source

You need Node 20 or later, pnpm on your PATH, and the Rust toolchain with the [Tauri v2 prerequisites for Windows](https://v2.tauri.app/start/prerequisites/).

Install pnpm once:

```bash
npm install -g pnpm
```

Node 25 and later no longer include corepack. On older Node versions, `corepack enable pnpm` also works.

Get the code and start the app in development mode:

```bash
git clone https://github.com/adeltcode/workspace-atlas.git
cd workspace-atlas
pnpm install
pnpm tauri dev
```

Build the installers, which end up in `src-tauri/target/release/bundle/`:

```bash
pnpm tauri build
```

### Tests

Rust tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Frontend tests (run `pnpm install` first):

```bash
node --test tests/
```

GitHub runs both on every push.

### Release a new version

1. Set the new version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Run `cargo update --workspace --manifest-path src-tauri/Cargo.toml` to update the lockfile, then commit.
3. Push a matching tag, such as `v0.2.0`.

GitHub then runs the tests, builds the installer, and creates a draft release with the installer's checksum. Check the draft, add your notes, and publish it.

### Project layout

```text
.github/workflows/        Tests on every push, draft release on every version tag
src/                      React frontend
  components/             Shared UI parts
  features/docker/        Docker module (api, hooks, types, components)
  features/wsl/           WSL module
  features/packages/      Packages module
  features/sandbox/       Windows Sandbox module
  features/holders/       Ports and File locks pages
  features/system/        Machine metrics
  features/config/        Settings export and import
  layout/                 Titlebar, Sidebar, MainPanel, Terminal
  store/appStore.ts       Zustand state (persisted to localStorage)
  views/                  Dashboard, Settings, WSL
src-tauri/src/
  docker.rs               Docker CLI wrappers, prune engine, backups
  wsl.rs                  Distro detection, metrics, config, lifecycle
  wsl_migration.rs        Moving a distro to another drive
  wsl_migration_acl.rs    Permissions on backup and destination folders
  packages.rs             Package scans, upgrades, uninstall
  sandbox.rs              Windows Sandbox start, stop, and list through wsb
  holders.rs              Which programs hold a port or file, and closing them
  system.rs               Host CPU, RAM, and disk via sysinfo
  shell.rs                Command execution and streamed output events
  config.rs               Settings export and import
tests/                    Node tests that check the frontend source
```

## Project status

Workspace Atlas is in beta, so its version numbers start with 0. Version 1.0.0 has no fixed feature list or date. It will come once the app has enough features and all of them are tested.

Two Optimize cases haven't been tested on a real system yet: Windows Home, which uses `diskpart`, and a disk that is still in use.

## Contributing

Bug reports and pull requests are welcome. If you find a problem, [open an issue](https://github.com/adeltcode/workspace-atlas/issues).

Before you open a pull request:

- Run both test commands and `pnpm build`, which also type-checks the frontend.
- Follow the [ground rules](#ground-rules). A new operation that touches disk or Docker must print its real command in the terminal.
- Start console programs with `shell::hidden`. A release build has no console, so anything else pops up a visible window. `pnpm tauri dev` hides the problem, so test new commands in an installed build.
- Use `type(scope): summary` commit messages, for example `fix(wsl): run first-run setup after installing a distro`.

## License

[MIT](LICENSE)
