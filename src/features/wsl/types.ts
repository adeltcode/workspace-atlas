export interface WslStatus {
  available: boolean
  error: string | null
}

export interface WslDistro {
  name: string
  /** WSL version: 1 or 2; 0 = unknown. */
  version: number
  running: boolean
  is_default: boolean
  base_path: string
  /** Path to ext4.vhdx; empty for WSL1 or if missing. */
  vhd_path: string
  vhd_size_bytes: number
}

export interface WslConfig {
  path: string
  content: string
  exists: boolean
}

/** An installable distribution resolved from Microsoft's ModernDistributions manifest. */
export interface CatalogDistro {
  /** Registration identifier, e.g. "Ubuntu-24.04". */
  name: string
  /** Human-readable label, e.g. "Ubuntu 24.04 LTS". */
  friendly_name: string
  /** Direct download URL of the .wsl image for this host's architecture. */
  url: string
  /** Expected SHA-256 of the image (empty when the manifest omits it). */
  sha256: string
}

/** Live download/install progress, streamed on the `wsl-install-progress` event. */
export interface InstallProgress {
  phase: 'downloading' | 'verifying' | 'importing' | 'done'
  downloaded: number
  /** Total bytes from Content-Length, or 0 when unknown. */
  total: number
  bytes_per_sec: number
  percent: number
}

export interface OptimizeResult {
  before_bytes: number
  after_bytes: number
  reclaimed_bytes: number
  /** "Optimize-VHD" or "diskpart". */
  method: string
}

export interface ExportResult {
  path: string
  size_bytes: number
}

export interface WslConfigBackup {
  filename: string
  path: string
  size_bytes: number
  /** Unix timestamp (seconds). */
  created_at: number
}

export interface TopProc {
  cpu_pct: number
  mem_pct: number
  /** Resident set size in KiB (shown as MB; per-process mem% rounds to 0 on big VMs). */
  rss_kb: number
  command: string
}

/** Live in-distro metrics for the dashboard (snake_case mirrors the Rust struct). */
export interface DistroMetrics {
  load1: number
  load5: number
  load15: number
  cpu_count: number
  uptime_secs: number
  mem_total_kb: number
  mem_available_kb: number
  swap_total_kb: number
  swap_free_kb: number
  disk_used_bytes: number
  disk_total_bytes: number
  pid1: string
  systemd: boolean
  systemd_state: string
  nameservers: string[]
  iface: string
  ip: string
  rx_bytes: number
  tx_bytes: number
  zombies: number
  docker_present: boolean
  docker_running: number
  top_procs: TopProc[]
}

/** Lightweight per-distro usage sample for the home dashboard chart. */
export interface DistroStats {
  cpu_pct: number
  mem_used_bytes: number
}

export interface DistroExtras {
  package_count: number
  /** dpkg | rpm | apk | pacman | unknown */
  package_manager: string
  uptime_secs: number
  disk_used_bytes: number
  disk_total_bytes: number
}

export interface MigrateResult {
  backup_tar: string
}

export interface ServiceInit {
  is_systemd: boolean
  pid1: string
  hint: string | null
}

export interface Service {
  name: string
  enabled_state: string
  active_state: string
  sub_state: string
  description: string
}

export interface ServiceList {
  init: ServiceInit
  services: Service[]
}

export interface ServiceDetail {
  id: string
  description: string
  load_state: string
  active_state: string
  sub_state: string
  unit_file_state: string
  fragment_path: string
  main_pid: string
  requires: string[]
  after: string[]
}

export interface BenchmarkResult {
  boot_ms: number
}

export interface RcFile {
  path: string
  seconds: number
}

export interface DetectedTool {
  tool: string
  suggestion: string
}

export interface ShellProfile {
  shell: string
  baseline_secs: number
  interactive_secs: number
  login_secs: number
  rc_overhead_secs: number
  files: RcFile[]
  detected: DetectedTool[]
}
