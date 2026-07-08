export interface DockerStatus {
  available: boolean
  version: string | null
  error: string | null
  /** "running" | "stopped" | "not_installed" */
  state: 'running' | 'stopped' | 'not_installed'
}

export interface DiskStats {
  total_bytes: number
  free_bytes: number
  drive_label: string
}

export interface DiskUsageRow {
  type: string
  total: number
  active: number
  size: string
  reclaimable: string
}

export interface DockerSystemDf {
  images: DiskUsageRow
  containers: DiskUsageRow
  volumes: DiskUsageRow
  build_cache: DiskUsageRow
}

export interface DockerImage {
  id: string
  repository: string
  tag: string
  size: string
  size_bytes: number
  created_since: string
  age_days: number
  in_use: boolean
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  /** 'running' | 'exited' | 'paused' | 'created' | 'restarting' | 'dead' */
  state: string
  /** Human-readable e.g. "Up 2 days", "Exited (0) 3 hours ago" */
  status: string
  ports: string
  created_since: string
  /** Days since the container was stopped; -1 if currently running */
  stopped_days: number
  /** Docker Compose project name from com.docker.compose.project label */
  compose_project: string | null
  /** Docker Compose service name from com.docker.compose.service label */
  compose_service: string | null
}

export interface AppProjectMeta {
  favorite: boolean
  tags: string[]
  note: string
  recent_opened: string | null
  startup_times: number[]
}

export function emptyMeta(): AppProjectMeta {
  return { favorite: false, tags: [], note: '', recent_opened: null, startup_times: [] }
}

export interface DetectedFile {
  path: string
  kind: 'dockerfile' | 'env'
}

export interface EditorInfo {
  name: string
  command: string
}

export interface DockerVolume {
  name: string
  driver: string
  /** false = dangling / unused */
  in_use: boolean
  /** Container names currently using this volume */
  containers: string[]
  /** Docker Compose project that created this volume, if any */
  compose_project: string | null
  /** Disk space used (0 = unknown / still loading) */
  size_bytes: number
}

export interface DockerNetwork {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
  ipv6: boolean
  /** "YYYY-MM-DD HH:mm" */
  created: string
}

export interface PrunePreview {
  level: number
  command: string
  image_ids: string[]
  image_names: string[]
  reclaim_bytes: number
  reclaim_size: string
  container_count: number
  volume_count: number
}

export interface ContainerStats {
  name: string
  cpu_pct: number
  mem_used_bytes: number
}

export interface ComposeProject {
  name: string
  status: string
  config_files: string[]
}

export interface VolumeBackupEntry {
  filename: string
  volume: string
  path: string
  size_bytes: number
  /** Unix timestamp (seconds) */
  created_at: number
}

export interface ComposeBackupEntry {
  filename: string
  project: string
  original_path: string
  path: string
  size_bytes: number
  created_at: number
}

export interface TransferResult {
  moved: number
  old_dir_removed: boolean
}

export interface BackupProgress {
  /** Which volume this event belongs to. */
  volume: string | null
  step: string
  /** 0-100 completion estimate for this volume. */
  progress: number
  done: boolean
  error: string | null
  filename: string | null
  /** Raw Docker command being executed — display in terminal. */
  cmd: string | null
}

export interface LogEntry {
  id: string
  timestamp: number
  level: number
  lines: string[]
  success: boolean
}
