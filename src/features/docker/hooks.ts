import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import * as api from './api'
import type { DockerStatus, DockerSystemDf, DockerImage, DockerContainer, DockerVolume } from './types'

/** Re-use cached data if it's younger than this. */
const CACHE_TTL = 2 * 60 * 1000 // 2 minutes

const CMD_CHECK = 'docker version --format "{{.Server.Version}}"'
const CMD_DF    = 'docker system df'
const CMD_IMGS  = 'docker images --format "{{json .}}"'
const CMD_CTRS  = 'docker ps -a --format "{{json .}}"'
const CMD_VOLS  = 'docker volume ls --format "{{json .}}"'

function isCacheFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CACHE_TTL
}

export function useDockerData() {
  const cached = useAppStore(s => s.dockerCache)
  const fresh  = cached !== null && isCacheFresh(cached.fetchedAt)

  const [status, setStatus]         = useState<DockerStatus | null>(fresh ? cached.status : null)
  const [df, setDf]                 = useState<DockerSystemDf | null>(fresh ? cached.df : null)
  const [images, setImages]         = useState<DockerImage[]>(fresh ? cached.images : [])
  const [containers, setContainers] = useState<DockerContainer[]>(fresh ? (cached.containers ?? []) : [])
  const [volumes, setVolumes]       = useState<DockerVolume[]>(fresh ? (cached.volumes ?? []) : [])
  const [loading, setLoading]       = useState(!fresh)
  const [error, setError]           = useState<string | null>(null)

  const running = useRef(false)

  const fetchData = useCallback(async (force = false) => {
    const { dockerCache, setDockerCache, addTerminalLine } = useAppStore.getState()

    // Use cache if fresh and not forced
    if (!force && dockerCache && isCacheFresh(dockerCache.fetchedAt)) {
      setStatus(dockerCache.status)
      setDf(dockerCache.df)
      setImages(dockerCache.images)
      setContainers(dockerCache.containers ?? [])
      setVolumes(dockerCache.volumes ?? [])
      setLoading(false)
      return
    }

    if (running.current) return
    running.current = true
    setLoading(true)
    setError(null)

    try {
      addTerminalLine(`$ ${CMD_CHECK}`, 'cmd')
      const s = await api.dockerCheck()
      setStatus(s)

      if (s.available) {
        addTerminalLine(`  → Docker v${s.version ?? 'unknown'}`, 'info')

        // Run sequentially so the terminal shows command → result → command → result
        // instead of all commands first then all results together.
        addTerminalLine(`$ ${CMD_DF}`, 'cmd')
        const dfData = await api.dockerSystemDf()
        addTerminalLine('  ✓ system df complete', 'success')

        addTerminalLine(`$ ${CMD_IMGS}`, 'cmd')
        const imgData = await api.dockerImages()
        addTerminalLine(`  ✓ ${imgData.length} image(s) loaded`, 'success')

        addTerminalLine(`$ ${CMD_CTRS}`, 'cmd')
        const ctrData = await api.dockerContainers()
        addTerminalLine(`  ✓ ${ctrData.length} container(s) loaded`, 'success')

        addTerminalLine(`$ ${CMD_VOLS}`, 'cmd')
        const volData = await api.dockerVolumes()
        addTerminalLine(`  ✓ ${volData.length} volume(s) loaded`, 'success')

        setDf(dfData)
        setImages(imgData)
        setContainers(ctrData)
        setVolumes(volData)
        setDockerCache({
          status: s,
          df: dfData,
          images: imgData,
          containers: ctrData,
          volumes: volData,
          fetchedAt: Date.now(),
        })
      } else {
        addTerminalLine(`  ✗ Docker not running: ${s.error ?? 'unknown error'}`, 'error')
        setDf(null)
        setImages([])
        setContainers([])
        setVolumes([])
      }
    } catch (e) {
      const msg = String(e)
      setError(msg)
      useAppStore.getState().addTerminalLine(`  ✗ ${msg}`, 'error')
    } finally {
      setLoading(false)
      running.current = false
    }
  }, []) // eslint-disable-line

  /** Force a fresh fetch of all Docker data. */
  const refresh = useCallback(() => fetchData(true), [fetchData])

  /**
   * Refresh only the containers list — used after a single container
   * start/stop/remove so we don't reload images, volumes, and df.
   */
  const refreshContainers = useCallback(async () => {
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`$ ${CMD_CTRS}`, 'cmd')
    try {
      const ctrData = await api.dockerContainers()
      addTerminalLine(`  ✓ ${ctrData.length} container(s)`, 'success')
      setContainers(ctrData)
      // Keep cache in sync so the next full refresh doesn't undo this
      const st = useAppStore.getState()
      if (st.dockerCache) {
        st.setDockerCache({ ...st.dockerCache, containers: ctrData, fetchedAt: Date.now() })
      }
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    }
  }, []) // eslint-disable-line — setContainers is stable (from useState)

  /**
   * Refresh only the volumes list — used after a single volume remove/prune
   * so we don't reload everything else.
   */
  const refreshVolumes = useCallback(async () => {
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`$ ${CMD_VOLS}`, 'cmd')
    try {
      const volData = await api.dockerVolumes()
      addTerminalLine(`  ✓ ${volData.length} volume(s)`, 'success')
      setVolumes(volData)
      const st = useAppStore.getState()
      if (st.dockerCache) {
        st.setDockerCache({ ...st.dockerCache, volumes: volData, fetchedAt: Date.now() })
      }
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    }
  }, []) // eslint-disable-line — setVolumes is stable (from useState)

  useEffect(() => { fetchData() }, [fetchData])

  return { status, df, images, containers, volumes, loading, error, refresh, refreshContainers, refreshVolumes }
}
