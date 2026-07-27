# Workspace Atlas

A Windows developer utility for managing Docker and WSL2 from one native app. Your dev environment, mapped and managed.

Built with Tauri v2 (Rust) + React 19 + TypeScript + Vite + Tailwind v4.

## Modules

### Docker & Containers

- **Overview**: engine status, live CPU/memory charts, disk usage breakdown
- **Images / Containers / Volumes / Networks**: browse, inspect, start/stop/remove, container logs, shell into a container
- **Compose**: project list with live service status, per-project logs, in-app editing of compose files, Dockerfiles, and `.env`, open in your editor
- **Prune**: three levels with a dry-run estimate before anything is removed:
  - Level 1 Safe: dangling images only
  - Level 2 Deep: all unused images not in the keep-list
  - Level 3 Nuclear: containers, images, volumes, build cache (requires typed confirmation)
- **Backup**: volume and compose-project backup/restore to a chosen folder
- **Log**: history of every prune run

### WSL

- **Dashboard**: per-distro live CPU/memory charts, Docker-style disk usage per drive, `.wslconfig` limit-vs-actual
- **Per-distro pages**: start / restart / stop, open terminal or files, export, clone, migrate to another drive, VHD compact with before/after delta
- **Startup**: systemd unit list with enable/disable toggles
- **Performance**: cold-boot benchmark history and shell-profile timing (detects nvm, conda, pyenv, oh-my-zsh, sdkman, and friends)
- **Install distro**: catalog browse and download
- **`.wslconfig` / `wsl.conf`**: editors with backup and restore

## Ground rules

- Every operation that touches disk or Docker prints the real, copy-pasteable command in the built-in terminal. No black boxes.
- Destructive actions always dry-run first and show before/after numbers.
- Keep-listed images are never pruned.
- Runs unprivileged; elevation is requested just-in-time for the operations that need it (VHD compact).
- Fully offline apart from distro downloads.

## Development

Requires Node 20+, pnpm (via corepack), and the Rust toolchain with the Tauri v2 prerequisites for Windows.

```bash
corepack pnpm install
```

```bash
corepack pnpm tauri dev
```

```bash
corepack pnpm tauri build
```

Rust tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Layout

```
src/                    React frontend
  features/docker/       Docker module (api, hooks, types, components)
  features/wsl/          WSL module
  layout/                Titlebar, Sidebar, MainPanel, Terminal
  store/appStore.ts      Zustand state (persisted to localStorage)
src-tauri/src/
  docker.rs              Docker CLI wrappers, prune engine, backups
  wsl.rs                 Distro detection, metrics, config, lifecycle
  system.rs              Host CPU/RAM/disk via sysinfo
  shell.rs               Command execution + streamed output events
  config.rs              Settings export/import
```

## License

MIT
