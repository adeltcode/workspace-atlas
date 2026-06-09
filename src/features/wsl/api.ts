import { invoke } from '@tauri-apps/api/core'
import type { WslStatus, WslDistro, WslConfig, OptimizeResult, ExportResult } from './types'

export const wslCheck       = () => invoke<WslStatus>('wsl_check')
export const wslListDistros = () => invoke<WslDistro[]>('wsl_list_distros')

export const readWslConfig  = () => invoke<WslConfig>('read_wslconfig')
export const writeWslConfig = (content: string) => invoke<void>('write_wslconfig', { content })
export const wslShutdown    = () => invoke<void>('wsl_shutdown')

export const wslOptimizeVhd = (vhdPath: string) =>
  invoke<OptimizeResult>('wsl_optimize_vhd', { vhdPath })

export const wslExportDistro = (name: string) =>
  invoke<ExportResult | null>('wsl_export_distro', { name })

export const wslImportDistro = (name: string, installDir: string, tarPath: string) =>
  invoke<void>('wsl_import_distro', { name, installDir, tarPath })

export const pickTarFile  = () => invoke<string | null>('pick_tar_file')
export const pickDirectory = () => invoke<string | null>('pick_directory')

/** Reveal a path in Windows Explorer. Reuses the generic backend command. */
export const revealPath = (path: string) => invoke<void>('reveal_path', { path })
