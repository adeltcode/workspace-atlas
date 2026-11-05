import { invoke } from '../../utils/errors'

export interface SandboxStatus {
  /** False when this PC has no `wsb` command. */
  available: boolean
  running: string[]
  /** Closing the window does not stop the sandbox, so this can be false while one runs. */
  window_open: boolean
  /** What the sandbox uses right now, seen from this PC. */
  memory_used_bytes: number | null
}

/** Null means the sandbox did not answer. */
export interface SandboxDetails {
  cpu_name: string | null
  cpu_threads: number | null
  memory_mb: number | null
  disk_total_gb: number | null
  disk_free_gb: number | null
  windows_build: number | null
  graphics: boolean | null
  /** False when wsb failed for another reason than the sandbox having no network. */
  network_known: boolean
  ip_address: string | null
}

/** One of the things a sandbox was started with, for showing on the page. */
export interface SandboxSharedItem {
  key: keyof SandboxSwitches | 'folder'
  label: string
  /** For a folder: the full path and whether programs can change it. */
  path?: string
  writable?: boolean
}

export type SandboxPathKind = 'program' | 'file' | 'folder' | 'missing'

export interface SandboxSwitches {
  networking: boolean
  microphone: boolean
  camera: boolean
  clipboard: boolean
  printers: boolean
  graphics: boolean
}

export interface SandboxOptions extends SandboxSwitches {
  folder: string | null
  writable: boolean
  /** Null leaves the amount to Windows. */
  memory_mb: number | null
  /** A file to copy in and open as soon as the sandbox is ready. */
  open_file: string | null
}

export const sandboxStatus = () => invoke<SandboxStatus>('sandbox_status')
export const sandboxDetails = (id: string) => invoke<SandboxDetails>('sandbox_details', { id })
export const sandboxStart = (options: SandboxOptions) => invoke<string>('sandbox_start', { options })
export const sandboxStop = (id: string) => invoke<void>('sandbox_stop', { id })
export const sandboxOpenWindow = (id: string) => invoke<void>('sandbox_open_window', { id })
export const sandboxOpenFile = (id: string, file: string) => invoke<void>('sandbox_open_file', { id, file })
export const sandboxPathKinds = (paths: string[]) => invoke<SandboxPathKind[]>('sandbox_path_kinds', { paths })
