import { invoke } from '@tauri-apps/api/core'
import type { WslStatus, WslDistro } from './types'

export const wslCheck       = () => invoke<WslStatus>('wsl_check')
export const wslListDistros = () => invoke<WslDistro[]>('wsl_list_distros')

/** Reveal a path in Windows Explorer. Reuses the generic backend command. */
export const revealPath = (path: string) => invoke<void>('reveal_path', { path })
