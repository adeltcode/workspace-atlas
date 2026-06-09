import { invoke } from '@tauri-apps/api/core'
import type { WslStatus, WslDistro, WslConfig, OptimizeResult } from './types'

export const wslCheck       = () => invoke<WslStatus>('wsl_check')
export const wslListDistros = () => invoke<WslDistro[]>('wsl_list_distros')

export const readWslConfig  = () => invoke<WslConfig>('read_wslconfig')
export const writeWslConfig = (content: string) => invoke<void>('write_wslconfig', { content })
export const wslShutdown    = () => invoke<void>('wsl_shutdown')

export const wslOptimizeVhd = (vhdPath: string) =>
  invoke<OptimizeResult>('wsl_optimize_vhd', { vhdPath })

/** Reveal a path in Windows Explorer. Reuses the generic backend command. */
export const revealPath = (path: string) => invoke<void>('reveal_path', { path })
