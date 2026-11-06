import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import * as api from './api'
import type { DockerStatus, DockerSystemDf, DockerImage, DockerContainer, DockerVolume } from './types'

const CACHE_TTL = 2 * 60 * 1000

const CMD_CHECK = 'docker version --format "{{.Server.Version}}"'
const CMD_DF    = 'docker system df'
const CMD_IMGS  = 'docker images --format "{{json .}}"'
const CMD_CTRS  = 'docker ps -a --format "{{json .}}"'
const CMD_VOLS  = 'docker volume ls --format "{{json .}}"'

const SECTIONS = ['df', 'images', 'containers', 'volumes'] as const
export type DockerSection = typeof SECTIONS[number]

function isCacheFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CACHE_TTL
}

export function useDockerData() {
  const [status, setStatus]         = useState<DockerStatus | null>(null)
  const [df, setDf]                 = useState<DockerSystemDf | null>(null)
  const [images, setImages]         = useState<DockerImage[]>([])
  const [containers, setContainers] = useState<DockerContainer[]>([])
  const [volumes, setVolumes]       = useState<DockerVolume[]>([])
  const [refreshing, setRefreshing] = useState(true)
  // Sections with nothing to show yet. A later refresh does not add to this, so rows stay on screen.
  const [waitingFor, setWaitingFor] = useState<ReadonlySet<DockerSection>>(() => new Set(SECTIONS))
  const [error, setError]           = useState<string | null>(null)

  const running = useRef(false)

  const fetchData = useCallback(async (force = false) => {
    const { dockerCache, setDockerCache, addTerminalLine } = useAppStore.getState()

    if (!force && dockerCache && isCacheFresh(dockerCache.fetchedAt)) return

    if (running.current) return
    running.current = true
    setRefreshing(true)
    setError(null)

    const load = <T,>(section: DockerSection, read: () => Promise<T>, apply: (data: T) => void, done: (data: T) => string) =>
      read()
        .then(data => {
          apply(data)
          addTerminalLine(`  ✓ ${done(data)}`, 'success')
          return data
        })
        .catch(e => {
          setError(String(e))
          addTerminalLine(`  ✗ ${String(e)}`, 'error')
          return null
        })
        .finally(() => setWaitingFor(prev => {
          const next = new Set(prev)
          next.delete(section)
          return next
        }))

    try {
      addTerminalLine(`$ ${CMD_CHECK}`, 'cmd')
      const s = await api.dockerCheck()
      setStatus(s)

      if (s.available) {
        addTerminalLine(`  → Docker v${s.version ?? 'unknown'}`, 'info')

        // Run together, so each section appears as soon as its command answers.
        for (const cmd of [CMD_DF, CMD_IMGS, CMD_CTRS, CMD_VOLS]) addTerminalLine(`$ ${cmd}`, 'cmd')
        const [dfData, imgData, ctrData, volData] = await Promise.all([
          load('df', api.dockerSystemDf, setDf, () => 'system df complete'),
          load('images', api.dockerImages, setImages, d => `${d.length} image(s) loaded`),
          load('containers', api.dockerContainers, setContainers, d => `${d.length} container(s) loaded`),
          load('volumes', api.dockerVolumes, setVolumes, d => `${d.length} volume(s) loaded`),
        ])

        // Only a complete result counts as fresh, so a failed section is read again on the next open.
        if (dfData && imgData && ctrData && volData) {
          setDockerCache({
            status: s,
            df: dfData,
            images: imgData,
            containers: ctrData,
            volumes: volData,
            fetchedAt: Date.now(),
          })
        }
      } else {
        addTerminalLine(`  ✗ Docker not running: ${s.error ?? 'unknown error'}`, 'error')
        setDf(null)
        setImages([])
        setContainers([])
        setVolumes([])
        setWaitingFor(new Set(SECTIONS))
      }
    } catch (e) {
      const msg = String(e)
      setError(msg)
      useAppStore.getState().addTerminalLine(`  ✗ ${msg}`, 'error')
    } finally {
      setRefreshing(false)
      running.current = false
    }
  }, []) // eslint-disable-line

  const refresh = useCallback(() => fetchData(true), [fetchData])

  const refreshContainers = useCallback(async () => {
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`$ ${CMD_CTRS}`, 'cmd')
    try {
      const ctrData = await api.dockerContainers()
      addTerminalLine(`  ✓ ${ctrData.length} container(s)`, 'success')
      setContainers(ctrData)
      // Preserve fetchedAt: only containers were refreshed, so the freshness window for images, df and
      // volumes must not be extended.
      const st = useAppStore.getState()
      if (st.dockerCache) {
        st.setDockerCache({ ...st.dockerCache, containers: ctrData })
      }
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    }
  }, []) // eslint-disable-line - setContainers is stable (from useState)

  const refreshVolumes = useCallback(async () => {
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`$ ${CMD_VOLS}`, 'cmd')
    try {
      const volData = await api.dockerVolumes()
      addTerminalLine(`  ✓ ${volData.length} volume(s)`, 'success')
      setVolumes(volData)
      // Preserve fetchedAt: only volumes were refreshed here.
      const st = useAppStore.getState()
      if (st.dockerCache) {
        st.setDockerCache({ ...st.dockerCache, volumes: volData })
      }
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    }
  }, []) // eslint-disable-line - setVolumes is stable (from useState)

  useEffect(() => { fetchData() }, [fetchData])

  return {
    status, df, images, containers, volumes, refreshing, error, refresh, refreshContainers, refreshVolumes,
    /** True until the first load finishes. A later refresh leaves the current data on screen. */
    loading: refreshing && waitingFor.size > 0,
    waiting: (section: DockerSection) => refreshing && waitingFor.has(section),
  }
}
