import { invoke } from '@tauri-apps/api/core'
import type { DockerStatus, DiskStats, DockerSystemDf, DockerImage, DockerContainer, DockerVolume, DockerNetwork, ContainerStats, ComposeProject, VolumeBackupEntry, PrunePreview, TransferResult, ComposeBackupEntry, AppProjectMeta, DetectedFile, EditorInfo } from './types'

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
export const dockerComposeAction    = (configFile: string, action: 'up' | 'down' | 'down-volumes' | 'restart' | 'rebuild') =>
  invoke<void>('docker_compose_action', { configFile, action })
export const dockerStats            = () => invoke<ContainerStats[]>('docker_stats')
export const readFileContent         = (path: string) => invoke<string>('read_file_content', { path })
export const getDefaultBackupDir     = () => invoke<string>('get_default_backup_dir')
export const dockerListBackups       = (backupDir: string) => invoke<VolumeBackupEntry[]>('docker_list_backups', { backupDir })
export const dockerVolumeBackup      = (volumeName: string, backupDir: string) => invoke<string>('docker_volume_backup', { volumeName, backupDir })
export const dockerVolumeRestore     = (volumeName: string, backupFile: string) => invoke<void>('docker_volume_restore', { volumeName, backupFile })
export const dockerBackupCompose          = (project: string, configFiles: string[], backupDir: string) => invoke<ComposeBackupEntry[]>('docker_backup_compose', { project, configFiles, backupDir })
export const dockerListComposeBackups     = (backupDir: string, project: string) => invoke<ComposeBackupEntry[]>('docker_list_compose_backups', { backupDir, project })
export const dockerDeleteComposeBackup  = (backupDir: string, filename: string) => invoke<void>('docker_delete_compose_backup', { backupDir, filename })

export const dockerDeleteBackup = (backupDir: string, filename: string) =>
  invoke<void>('docker_delete_backup', { backupDir, filename })

export const pickBackupFolder = () =>
  invoke<string | null>('pick_backup_folder')

export const metadataLoad = () =>
  invoke<Record<string, AppProjectMeta>>('metadata_load')

export const metadataSaveProject = (name: string, meta: AppProjectMeta) =>
  invoke<void>('metadata_save_project', { name, meta })

export const dockerComposeServiceAction = (configFile: string, action: string, service: string) =>
  invoke<void>('docker_compose_service_action', { configFile, action, service })

export const openContainerShell = (containerName: string) =>
  invoke<void>('open_container_shell', { containerName })

export const writeFileContent = (path: string, content: string) =>
  invoke<void>('write_file_content', { path, content })

export const detectComposeProjectFiles = (configFile: string) =>
  invoke<DetectedFile[]>('detect_compose_project_files', { configFile })

export const detectEditors = () =>
  invoke<EditorInfo[]>('detect_editors')

export const openInEditor = (path: string, editorCmd: string) =>
  invoke<void>('open_in_editor', { path, editorCmd })

export const revealPath = (path: string) =>
  invoke<void>('reveal_path', { path })

export const dockerComposeConfig = (configFile: string) =>
  invoke<string>('docker_compose_config', { configFile })

export const composeLogsWatch = (configFile: string, services: string[]) =>
  invoke<void>('compose_logs_watch', { configFile, services })

export const composeLogsStop = () =>
  invoke<void>('compose_logs_stop')

export const dockerPrunePreview = (level: number, keepList: string[]) =>
  invoke<PrunePreview>('docker_prune_preview', { level, keepList })

export const dockerPruneRun = (level: number, imageIds: string[]) =>
  invoke<void>('docker_prune_run', { level, imageIds })
