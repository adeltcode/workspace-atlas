export interface DockerStatus {
  available: boolean
  version: string | null
  error: string | null
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
}

export interface DockerVolume {
  name: string
  driver: string
  mountpoint: string
  /** false = dangling / unused */
  in_use: boolean
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

export interface LogEntry {
  id: string
  timestamp: number
  level: number
  dry_run: boolean
  lines: string[]
  success: boolean
}
