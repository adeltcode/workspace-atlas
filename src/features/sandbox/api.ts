import { invoke } from '../../utils/errors'

export interface SandboxStatus {
  /** False when this PC has no `wsb` command. */
  available: boolean
  running: string[]
}

export interface SandboxSwitches {
  microphone: boolean
  camera: boolean
  clipboard: boolean
  printers: boolean
  graphics: boolean
}

export interface SandboxOptions extends SandboxSwitches {
  networking: boolean
  folder: string | null
  writable: boolean
  /** Null leaves the amount to Windows. */
  memory_mb: number | null
}

export const sandboxStatus = () => invoke<SandboxStatus>('sandbox_status')
export const sandboxStart = (options: SandboxOptions) => invoke<string>('sandbox_start', { options })
export const sandboxStop = (id: string) => invoke<void>('sandbox_stop', { id })
export const sandboxOpenWindow = (id: string) => invoke<void>('sandbox_open_window', { id })
