import { invoke } from '../../utils/errors'

export type CacheKind = 'node-modules' | 'rust-target' | 'maven-target' | 'gradle-build' | 'python-venv' | 'python-bytecode' | 'shared'

export interface CacheItem {
  kind: CacheKind
  /** The project folder's name, or the shared cache's name. */
  name: string
  /** What gets deleted. More than one for a project's `__pycache__` folders and for Cargo. */
  paths: string[]
  size_bytes: number
  file_count: number
  /** Seconds since 1970: the newest file in the project or the cache. */
  last_used: number | null
  /** How it comes back: a command, or that it comes back by itself. */
  restore: string | null
  /** Anything to know before clearing it. */
  note: string | null
}

export interface CacheScan {
  items: CacheItem[]
  /** Chosen folders that are gone, or that this page will not look inside. */
  skipped_roots: string[]
  /** The user stopped the scan, so the list is not complete. */
  stopped: boolean
}

export interface ClearFailure {
  path: string
  error: unknown
}

export interface DriveFreed {
  drive: string
  freed_bytes: number
  free_bytes: number
}

export interface ClearResult {
  removed: string[]
  failed: ClearFailure[]
  /** Measured from the drive, because shared files make a folder's size overstate what is freed. */
  drives: DriveFreed[]
}

export const cachesScan = (roots: string[]) => invoke<CacheScan>('caches_scan', { roots })
export const cachesScanStop = () => invoke<void>('caches_scan_stop')
export const cachesClear = (paths: string[]) => invoke<ClearResult>('caches_clear', { paths })
