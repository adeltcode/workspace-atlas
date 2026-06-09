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
