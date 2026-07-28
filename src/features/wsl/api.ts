import { invoke } from '@tauri-apps/api/core'
import type { WslStatus, WslDistro, WslConfig, OptimizeResult, ExportResult, WslConfigBackup, DistroMetrics, DistroStats, DistroExtras, MigrateResult, ServiceList, ServiceDetail, BenchmarkResult, ShellProfile, CatalogDistro } from './types'

export const wslCheck       = () => invoke<WslStatus>('wsl_check')
/** Pass `silent` for background polling so the list command stays out of the terminal panel. */
export const wslListDistros = (silent = false) => invoke<WslDistro[]>('wsl_list_distros', { silent })
/** Cheap running-state poll (`wsl -l --running -q`) - names of currently-running distros. */
export const wslRunningNames = () => invoke<string[]>('wsl_running_names')

/** Installable distros resolved from Microsoft's ModernDistributions manifest. */
export const wslInstallCatalog  = () => invoke<CatalogDistro[]>('wsl_install_catalog')
/** Default install location (%LOCALAPPDATA%\WSL\<name>) for a downloaded distro. */
export const wslDefaultInstallDir = (name: string) => invoke<string>('wsl_default_install_dir', { name })
/** Stream-download a distro image (progress on `wsl-install-progress`), verify, and import it. */
export const wslInstallDownload = (name: string, url: string, sha256: string, installDir: string) =>
  invoke<void>('wsl_install_download', { name, url, sha256, installDir })
export const wslDistroMetrics = (distro: string) => invoke<DistroMetrics>('wsl_distro_metrics', { distro })
export const wslDistroStats   = (distro: string) => invoke<DistroStats>('wsl_distro_stats', { distro })
export const wslDistroExtras  = (distro: string) => invoke<DistroExtras>('wsl_distro_extras', { distro })
export const wslOpenTerminal     = (distro: string) => invoke<void>('wsl_open_terminal', { distro })
export const wslOpenDistroFolder = (distro: string) => invoke<void>('wsl_open_distro_folder', { distro })
export const wslTerminateDistro = (distro: string) => invoke<void>('wsl_terminate_distro', { distro })
export const wslRestartDistro   = (distro: string) => invoke<void>('wsl_restart_distro', { distro })
export const wslStartDistro     = (distro: string) => invoke<void>('wsl_start_distro', { distro })
export const wslCloneDistro = (source: string, newName: string, installDir: string, version: number) =>
  invoke<void>('wsl_clone_distro', { source, newName, installDir, version })
export const wslMigrateDistro = (distro: string, newDir: string, wasDefault: boolean, currentBase: string, version: number) =>
  invoke<MigrateResult>('wsl_migrate_distro', { distro, newDir, wasDefault, currentBase, version })
/** Permanently delete a distro (`wsl --unregister`). `confirm` is the name the
 *  user typed; the backend rejects the call unless it matches. No undo. */
export const wslUnregisterDistro = (distro: string, confirm: string) =>
  invoke<void>('wsl_unregister_distro', { distro, confirm })

export const wslListServices  = (distro: string) => invoke<ServiceList>('wsl_list_services', { distro })
export const wslServiceDetail = (distro: string, service: string) =>
  invoke<ServiceDetail>('wsl_service_detail', { distro, service })
export const wslServiceSet    = (distro: string, service: string, enable: boolean) =>
  invoke<void>('wsl_service_set', { distro, service, enable })

export const wslBenchmarkBoot = (distro: string) => invoke<BenchmarkResult>('wsl_benchmark_boot', { distro })
export const wslProfileShell  = (distro: string) => invoke<ShellProfile>('wsl_profile_shell', { distro })

export const readWslConfig  = () => invoke<WslConfig>('read_wslconfig')
export const writeWslConfig = (content: string) => invoke<void>('write_wslconfig', { content })
export const wslShutdown    = () => invoke<void>('wsl_shutdown')

export const wslconfigBackup       = (backupDir: string) => invoke<WslConfigBackup>('wslconfig_backup', { backupDir })
export const wslconfigListBackups  = (backupDir: string) => invoke<WslConfigBackup[]>('wslconfig_list_backups', { backupDir })
export const wslconfigRestore      = (backupPath: string) => invoke<string>('wslconfig_restore', { backupPath })

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
export { revealPath } from '../docker/api'
