import { invoke } from '@tauri-apps/api/core'
import type { DockerStatus, DockerSystemDf, DockerImage, DockerContainer, DockerVolume, PrunePreview } from './types'

export const dockerCheck     = () => invoke<DockerStatus>('docker_check')
export const dockerSystemDf  = () => invoke<DockerSystemDf>('docker_system_df')
export const dockerImages    = () => invoke<DockerImage[]>('docker_images')
export const dockerContainers = () => invoke<DockerContainer[]>('docker_containers')
export const dockerVolumes    = () => invoke<DockerVolume[]>('docker_volumes')

export const dockerContainerAction = (id: string, action: 'start' | 'stop' | 'remove') =>
  invoke<void>('docker_container_action', { id, action })

export const dockerVolumeRemove = (name: string) =>
  invoke<void>('docker_volume_remove', { name })

export const dockerVolumesPrune = () =>
  invoke<void>('docker_volumes_prune')

export const dockerPrunePreview = (level: number, keepList: string[]) =>
  invoke<PrunePreview>('docker_prune_preview', { level, keepList })

export const dockerPruneRun = (level: number, imageIds: string[]) =>
  invoke<void>('docker_prune_run', { level, imageIds })
