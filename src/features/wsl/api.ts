import { invoke } from '@tauri-apps/api/core'
import type { WslStatus, WslDistro, WslConfig, OptimizeResult, ExportResult, WslConfigBackup, DistroMetrics, DistroExtras, MigrateResult } from './types'

export const wslCheck       = () => invoke<WslStatus>('wsl_check')
export const wslListDistros = () => invoke<WslDistro[]>('wsl_list_distros')
export const wslDistroMetrics = (distro: string) => invoke<DistroMetrics>('wsl_distro_metrics', { distro })
export const wslDistroExtras  = (distro: string) => invoke<DistroExtras>('wsl_distro_extras', { distro })
export const wslTerminateDistro = (distro: string) => invoke<void>('wsl_terminate_distro', { distro })
export const wslCloneDistro = (source: string, newName: string, installDir: string) =>
  invoke<void>('wsl_clone_distro', { source, newName, installDir })
export const wslMigrateDistro = (distro: string, newDir: string, wasDefault: boolean) =>
  invoke<MigrateResult>('wsl_migrate_distro', { distro, newDir, wasDefault })

export const readWslConfig  = () => invoke<WslConfig>('read_wslconfig')
export const writeWslConfig = (content: string) => invoke<void>('write_wslconfig', { content })
export const wslShutdown    = () => invoke<void>('wsl_shutdown')

export const wslconfigBackup       = (backupDir: string) => invoke<WslConfigBackup>('wslconfig_backup', { backupDir })
export const wslconfigListBackups  = (backupDir: string) => invoke<WslConfigBackup[]>('wslconfig_list_backups', { backupDir })
export const wslconfigRestore      = (backupPath: string) => invoke<string>('wslconfig_restore', { backupPath })
export const wslconfigDeleteBackup = (backupPath: string) => invoke<void>('wslconfig_delete_backup', { backupPath })

// /etc/wsl.conf (per-distro)
export const readWslConf  = (distro: string) => invoke<WslConfig>('read_wsl_conf', { distro })
export const writeWslConf = (distro: string, content: string) => invoke<void>('write_wsl_conf', { distro, content })
export const wslConfBackup       = (distro: string, backupDir: string) => invoke<WslConfigBackup>('wsl_conf_backup', { distro, backupDir })
export const wslConfListBackups  = (distro: string, backupDir: string) => invoke<WslConfigBackup[]>('wsl_conf_list_backups', { distro, backupDir })
export const wslConfRestore      = (distro: string, backupPath: string) => invoke<string>('wsl_conf_restore', { distro, backupPath })
export const wslConfDeleteBackup = (backupPath: string) => invoke<void>('wsl_conf_delete_backup', { backupPath })

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
