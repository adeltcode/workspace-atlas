import { invoke } from '@tauri-apps/api/core'
import type { DockerStatus, DiskStats, DockerSystemDf, DockerImage, DockerContainer, DockerVolume, DockerNetwork, ContainerStats, ComposeProject, VolumeBackupEntry, PrunePreview, TransferResult, ComposeBackupEntry } from './types'

export const dockerCheck          = () => invoke<DockerStatus>('docker_check')
export const launchDockerDesktop  = () => invoke<void>('launch_docker_desktop')
export const getDiskStats         = (path: string) => invoke<DiskStats>('get_disk_stats', { path })
export const getBackupSize        = (backupDir: string) => invoke<number>('get_backup_size', { backupDir })
export const dockerSystemDf  = () => invoke<DockerSystemDf>('docker_system_df')
export const dockerImages    = () => invoke<DockerImage[]>('docker_images')
export const dockerContainers = () => invoke<DockerContainer[]>('docker_containers')
export const dockerVolumes    = () => invoke<DockerVolume[]>('docker_volumes')

export const dockerContainerAction = (id: string, action: 'start' | 'stop' | 'remove') =>
  invoke<void>('docker_container_action', { id, action })

export const dockerVolumeRemove = (name: string) =>
  invoke<void>('docker_volume_remove', { name })

export const transferBackups = (fromDir: string, toDir: string) =>
  invoke<TransferResult>('transfer_backups', { fromDir, toDir })

export const dockerVolumesPrune = () =>
  invoke<void>('docker_volumes_prune')

export const dockerContainerLogs = (id: string, tail = 150) =>
  invoke<string[]>('docker_container_logs', { id, tail })

export const dockerNetworks = () =>
  invoke<DockerNetwork[]>('docker_networks')

export const dockerNetworkRemove = (id: string) =>
  invoke<void>('docker_network_remove', { id })

export const dockerComposeLs        = () => invoke<ComposeProject[]>('docker_compose_ls')
export const dockerComposeAction    = (configFile: string, action: 'up' | 'down' | 'restart' | 'rebuild') =>
  invoke<void>('docker_compose_action', { configFile, action })
export const dockerStats            = () => invoke<ContainerStats[]>('docker_stats')
export const readFileContent         = (path: string) => invoke<string>('read_file_content', { path })
export const getDefaultBackupDir     = () => invoke<string>('get_default_backup_dir')
export const dockerListBackups       = (backupDir: string) => invoke<VolumeBackupEntry[]>('docker_list_backups', { backupDir })
export const dockerVolumeBackup      = (volumeName: string, backupDir: string) => invoke<string>('docker_volume_backup', { volumeName, backupDir })
export const dockerVolumeRestore     = (volumeName: string, backupFile: string) => invoke<void>('docker_volume_restore', { volumeName, backupFile })
export const dockerBackupCompose          = (project: string, configFiles: string[], backupDir: string) => invoke<ComposeBackupEntry[]>('docker_backup_compose', { project, configFiles, backupDir })
export const dockerListAllComposeBackups  = (backupDir: string) => invoke<ComposeBackupEntry[]>('docker_list_all_compose_backups', { backupDir })
export const dockerListComposeBackups     = (backupDir: string, project: string) => invoke<ComposeBackupEntry[]>('docker_list_compose_backups', { backupDir, project })
export const dockerDeleteComposeBackup  = (backupDir: string, filename: string) => invoke<void>('docker_delete_compose_backup', { backupDir, filename })

export const dockerDeleteBackup = (backupDir: string, filename: string) =>
  invoke<void>('docker_delete_backup', { backupDir, filename })

export const pickBackupFolder = () =>
  invoke<string | null>('pick_backup_folder')

export const dockerPrunePreview = (level: number, keepList: string[]) =>
  invoke<PrunePreview>('docker_prune_preview', { level, keepList })

export const dockerPruneRun = (level: number, imageIds: string[]) =>
  invoke<void>('docker_prune_run', { level, imageIds })
