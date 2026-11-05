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

export interface PortEntry {
  port: number
  addresses: string[]
  reachable: 'this-pc' | 'network'
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
