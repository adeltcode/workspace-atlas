import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Play, ExternalLink } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import clsx from 'clsx'
import { useAppStore, type DockerTab } from '../../store/appStore'
import { useVisiblePoll } from '../../hooks/useVisiblePoll'
import { useDockerData } from './hooks'
import * as api from './api'
import type { ContainerStats } from './types'
import OverviewTab    from './components/OverviewTab'
import ImagesTab      from './components/ImagesTab'
import ContainersTab  from './components/ContainersTab'
import VolumesTab     from './components/VolumesTab'
import NetworksTab    from './components/NetworksTab'
import ComposeTab     from './components/ComposeTab'
import PruneTab       from './components/PruneTab'
import LogTab         from './components/LogTab'
import { SheetHead, Prerequisite, Button, ErrorBanner } from '../../components/ui'

const TAB_SUBTITLES: Partial<Record<DockerTab, string>> = {
  overview:   'Disk usage at a glance across images, containers, volumes, and build cache',
  images:     'Browse, filter, and pin Docker images',
  containers: 'Monitor and control running and stopped containers',
  volumes:    'Inspect volumes, back up and restore data',
  networks:   'View and remove custom Docker networks',
  compose:    'Inspect and back up Compose project configuration files',
  prune:      'Free disk space by removing unused images and stopped containers',
  log:        'View past prune runs',
}

const FILLING_TABS = new Set<DockerTab>(['images', 'containers', 'volumes', 'networks', 'compose'])

export default function DockerView() {
  const dockerTab     = useAppStore(s => s.dockerTab)
  const setActiveView = useAppStore(s => s.setActiveView)
  const { status, df, images, containers, volumes, loading, error, refresh, refreshContainers, refreshVolumes } = useDockerData()
  const [composeTick, setComposeTick] = useState(0)
  const [starting, setStarting]       = useState(false)
  const [startError, setStartError]   = useState<string | null>(null)

  const online = status?.available ?? false

  // Kept here, not in OverviewTab, so history accumulates from the moment Docker is detected as
  // running, whichever tab is active.
  const [containerStats, setContainerStats] = useState<ContainerStats[]>([])
  const [statsLoading,   setStatsLoading]   = useState(true)
  const [statsError,     setStatsError]     = useState<string | null>(null)
  const [statHistory,    setStatHistory]    = useState<Map<string, { cpu: number[]; mem: number[] }>>(() => new Map())

  const pollStats = useCallback(() => {
    if (!online) { setStatsLoading(false); return }
    api.dockerStats()
      .then(snaps => {
        setContainerStats(snaps)
        setStatsError(null)
        setStatsLoading(false)
        setStatHistory(prev => {
          const next = new Map(prev)
          const active = new Set(snaps.map(s => s.name))
          for (const k of next.keys()) if (!active.has(k)) next.delete(k)
          snaps.forEach(s => {
            const h = next.get(s.name) ?? { cpu: [], mem: [] }
            next.set(s.name, {
              cpu: [...h.cpu.slice(-14), s.cpu_pct],
              mem: [...h.mem.slice(-14), s.mem_used_bytes],
            })
          })
          return next
        })
      })
      .catch(e => { setStatsError(String(e)); setStatsLoading(false) })
  }, [online]) // eslint-disable-line

  useEffect(() => {
    if (!online) { setStatsLoading(false); setContainerStats([]); setStatHistory(new Map()); return }
    setStatsLoading(true)
    setStatsError(null)
    // Do not reset statHistory here: the updater already evicts departed containers, so sparklines
    // survive a manual Refresh. History is only wiped in the !online branch above.
    pollStats()
  }, [online, composeTick]) // eslint-disable-line

  useVisiblePoll(pollStats, 5000, online)

  const subtitle = TAB_SUBTITLES[dockerTab] ?? ''

  const handleRefresh = useCallback(() => {
    refresh(); setComposeTick(t => t + 1)
  }, [refresh])

  const handleStartDocker = useCallback(async () => {
    setStarting(true)
    setStartError(null)
    try {
      await api.launchDockerDesktop()
      // Docker Desktop takes about 30 to 60 s to start. Refresh after 8 s so the user sees progress
      // without clicking Refresh.
      setTimeout(() => { refresh(); setStarting(false) }, 8000)
    } catch (e) {
      setStartError(String(e))
      setStarting(false)
    }
  }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'r' && !e.shiftKey) {
        e.preventDefault(); handleRefresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleRefresh])

  useEffect(() => {
    const running = containers.filter(c => c.state === 'running').length
    const unused  = volumes.filter(v => !v.in_use).length
    useAppStore.getState().setDockerBadges({
      images:     images.length,
      containers: containers.length
        ? running > 0 ? `${running}/${containers.length}` : String(containers.length)
        : '',
      volumes: volumes.length
        ? unused > 0 ? `${volumes.length} · ${unused} unused` : String(volumes.length)
        : '',
    })
  }, [images.length, containers, volumes])

  // Table sections and the compose page need a body that fills rather than scrolls. Everything else
  // scrolls as one column.
  const fills = FILLING_TABS.has(dockerTab)

  return (
    <div className="view-container docker-view">

      <div className="page-head">
      <SheetHead
        crumbs={[
          { label: 'Overview', onClick: () => setActiveView('dashboard') },
          { label: 'Docker' },
        ]}
        title="Docker"
        subtitle={subtitle}
        status={
          loading && !status
            ? <span className="pill">Connecting…</span>
            : status && (
              <span className="pill">
                <span className={clsx('rail-dot', online ? 'running' : 'stopped')} />
                {online ? `v${status.version ?? 'unknown'}` : 'not running'}
              </span>
            )
        }
        actions={
          <Button onClick={handleRefresh} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            Refresh
          </Button>
        }
      />
      </div>

      <div className={clsx(fills ? 'page-fill' : 'page-scroll', 'docker-tab-content')}>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!loading && status && !online && status.state === 'not_installed' && (
        <Prerequisite
          title="Docker is not installed"
          description="This page needs Docker Desktop. It is a separate download, and the rest of Workspace Atlas keeps working without it."
          steps={[
            'Download Docker Desktop for Windows from docker.com',
            'Run the installer and follow the on-screen instructions',
            'Start Docker Desktop and wait for the engine to come online',
            'Return here and refresh',
          ]}
          actions={
            <>
              <Button variant="primary" onClick={() => openUrl('https://www.docker.com/products/docker-desktop/')}>
                <ExternalLink size={13} />
                Download Docker Desktop
              </Button>
              <Button onClick={handleRefresh}>
                <RefreshCw size={13} />
                Refresh
              </Button>
            </>
          }
        />
      )}

      {!loading && status && !online && status.state === 'stopped' && (
        <Prerequisite
          title="Docker Desktop is not running"
          description={starting
            ? 'Starting Docker Desktop. This can take up to a minute.'
            : 'Docker Desktop is installed but the engine is stopped. Start it here or from the system tray, then refresh.'}
          command={startError ?? status.error ?? undefined}
          actions={
            <>
              <Button variant="primary" onClick={handleStartDocker} disabled={starting}>
                <Play size={13} />
                {starting ? 'Starting…' : 'Start Docker Desktop'}
              </Button>
              <Button onClick={handleRefresh} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
                Refresh
              </Button>
            </>
          }
        />
      )}

      {(online || loading) && (
        <>
          {dockerTab === 'overview'   && <OverviewTab df={df} containers={containers} images={images} volumes={volumes} status={status} loading={loading} refreshTick={composeTick} onRefresh={refresh} containerStats={containerStats} statsLoading={statsLoading} statsError={statsError} statHistory={statHistory} onPollStats={pollStats} />}
          {dockerTab === 'images'     && <ImagesTab images={images} loading={loading} />}
          {dockerTab === 'containers' && <ContainersTab containers={containers} loading={loading} onRefresh={refreshContainers} />}

          {/* VolumesTab stays mounted while Docker is online so that in-progress
              backups, event listeners, and progress state survive tab switches. */}
          <div className={clsx('docker-pane-fill', dockerTab !== 'volumes' && 'tab-hidden')}>
            <VolumesTab volumes={volumes} loading={loading} onRefresh={refreshVolumes} />
          </div>

          {dockerTab === 'networks'   && <NetworksTab />}

          {/* ComposeTab stays mounted so it can update the sidebar's compose project list */}
          <div className={clsx('docker-pane-fill', dockerTab !== 'compose' && 'tab-hidden')}>
            <ComposeTab
              refreshTick={composeTick}
              containers={containers}
              containerStats={containerStats}
              onRefresh={refreshContainers}
            />
          </div>

          {dockerTab === 'prune'      && <PruneTab onDone={refresh} />}
          {dockerTab === 'log'        && <LogTab />}
        </>
      )}
      </div>
    </div>
  )
}
