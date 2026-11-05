import { invoke } from '../../utils/errors'

export interface SandboxStatus {
  /** False when this PC has no `wsb` command. */
  available: boolean
  running: string[]
}

export interface SandboxOptions {
  networking: boolean
  folder: string | null
  writable: boolean
}

export const sandboxStatus = () => invoke<SandboxStatus>('sandbox_status')
export const sandboxStart = (options: SandboxOptions) => invoke<string>('sandbox_start', { options })
export const sandboxStop = (id: string) => invoke<void>('sandbox_stop', { id })
export const sandboxOpenWindow = (id: string) => invoke<void>('sandbox_open_window', { id })
