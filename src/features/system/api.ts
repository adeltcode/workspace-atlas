import { invoke } from '../../utils/errors'

export interface DiskInfo {
  /** Mount point, e.g. "C:\\". */
  mount: string
  total_bytes: number
  free_bytes: number
}

export interface SystemMetrics {
  /** Global CPU usage since the previous poll (0–100). */
  cpu_pct: number
  /** Number of logical CPUs. */
  cpu_count: number
  mem_used_bytes: number
  mem_total_bytes: number
  disks: DiskInfo[]
}

export const getSystemMetrics = () => invoke<SystemMetrics>('get_system_metrics')
