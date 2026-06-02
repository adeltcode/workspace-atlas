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
        addTerminalLine(`$ ${CMD_DF}`, 'cmd')
        addTerminalLine(`$ ${CMD_IMGS}`, 'cmd')
        addTerminalLine(`$ ${CMD_CTRS}`, 'cmd')
        addTerminalLine(`$ ${CMD_VOLS}`, 'cmd')

        const [dfData, imgData, ctrData, volData] = await Promise.all([
          api.dockerSystemDf()
            .then(d => { addTerminalLine('  ✓ system df complete', 'success'); return d })
            .catch(e => { addTerminalLine(`  ✗ ${String(e)}`, 'error'); throw e }),
          api.dockerImages()
            .then(d => { addTerminalLine(`  ✓ ${d.length} image(s) loaded`, 'success'); return d })
            .catch(e => { addTerminalLine(`  ✗ ${String(e)}`, 'error'); throw e }),
          api.dockerContainers()
            .then(d => { addTerminalLine(`  ✓ ${d.length} container(s) loaded`, 'success'); return d })
            .catch(e => { addTerminalLine(`  ✗ ${String(e)}`, 'error'); throw e }),
          api.dockerVolumes()
            .then(d => { addTerminalLine(`  ✓ ${d.length} volume(s) loaded`, 'success'); return d })
            .catch(e => { addTerminalLine(`  ✗ ${String(e)}`, 'error'); throw e }),
        ])

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
  }, [])

  /** Force a fresh fetch regardless of cache age. */
  const refresh = useCallback(() => fetchData(true), [fetchData])

  useEffect(() => { fetchData() }, [fetchData])

  return { status, df, images, containers, volumes, loading, error, refresh }
}
