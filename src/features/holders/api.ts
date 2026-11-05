import { invoke } from '../../utils/errors'

export type ProcessOwner = 'app' | 'admin' | 'docker' | 'wsl' | 'distro-system' | 'windows' | 'this-app' | 'unknown'

export interface ProcessInfo {
  /** 0 for a Docker container. The Linux PID when `distro` is set. */
  pid: number
  name: string
  path: string | null
  started_at: number
  owner: ProcessOwner
  distro: string | null
}

export interface PortDetails {
  /** The command line. For a container, its image. */
  command: string | null
  /** The working folder. For a container, its Compose project's folder. */
  folder: string | null
  memory_bytes: number | null
  /** The program that started this one. */
  parent: string | null
}

export interface PortEntry {
  port: number
  addresses: string[]
  reachable: 'this-pc' | 'network'
  /** Seconds since 1970. When Windows opened the socket; for Docker and WSL, when the container or
   *  program started. */
  listening_since: number | null
  source: 'windows' | 'docker' | 'wsl'
  details: PortDetails
  process: ProcessInfo
}

export interface PortList {
  entries: PortEntry[]
  /** Docker or distros that did not answer, so their ports may be missing. */
  unchecked: string[]
}

export type HoldReason = 'open-file' | 'folder-open' | 'loaded-file' | 'running-from-here'

export interface LockHolder {
  process: ProcessInfo
  reason: HoldReason
  /** One thing it holds, when the path checked is a folder. */
  example: string | null
}

export interface LockReport {
  path: string
  is_folder: boolean
  complete: boolean
  holders: LockHolder[]
}

export const portsList = () => invoke<PortList>('ports_list')
export const locksFind = (path: string) => invoke<LockReport>('locks_find', { path })
export const processClose = (p: ProcessInfo) =>
  invoke<void>('process_close', { pid: p.pid, startedAt: p.started_at, name: p.name, distro: p.distro })
export const pickAnyFile = () => invoke<string | null>('pick_any_file')
