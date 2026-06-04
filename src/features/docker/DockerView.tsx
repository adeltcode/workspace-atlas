import { useState, useEffect, useCallback } from 'react'
import {
  Box, RefreshCw,
  LayoutGrid, Layers, Boxes, Database, Network,
  FileCode, Eraser, ScrollText,
  Play, ExternalLink, Download,
} from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import clsx from 'clsx'
import { useAppStore, type DockerTab } from '../../store/appStore'
import { useDockerData } from './hooks'
import * as api from './api'
import OverviewTab    from './components/OverviewTab'
import ImagesTab      from './components/ImagesTab'
import ContainersTab  from './components/ContainersTab'
import VolumesTab     from './components/VolumesTab'
import NetworksTab    from './components/NetworksTab'
import ComposeTab     from './components/ComposeTab'
import PruneTab       from './components/PruneTab'
import LogTab         from './components/LogTab'

// ── Tab definitions ────────────────────────────────────────────────────────────

interface TabDef {
  id:    DockerTab
  label: string
  icon:  React.ElementType
}

const DOCKER_TABS: TabDef[] = [
  { id: 'overview',   label: 'Overview',    icon: LayoutGrid },
  { id: 'images',     label: 'Images',      icon: Layers     },
  { id: 'containers', label: 'Containers',  icon: Boxes      },
  { id: 'volumes',    label: 'Volumes',     icon: Database   },
  { id: 'networks',   label: 'Networks',    icon: Network    },
  { id: 'compose',    label: 'Compose',     icon: FileCode   },
  { id: 'prune',      label: 'Prune',       icon: Eraser     },
  { id: 'log',        label: 'Log',         icon: ScrollText },
]

const TAB_SUBTITLES: Partial<Record<DockerTab, string>> = {
  overview:   'Disk usage at a glance across images, containers, volumes, and build cache',
  images:     'Browse, filter, and pin Docker images',
  containers: 'Monitor and control running and stopped containers',
  volumes:    'Inspect volumes, back up and restore data',
  networks:   'View and remove custom Docker networks',
  compose:    'Inspect and back up compose project configuration files',
  prune:      'Free disk space by removing unused images and stopped containers',
  log:        'View recent Docker and Atlas activity',
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function DockerView() {
  const dockerTab = useAppStore(s => s.dockerTab)
  const setDockerTab = useAppStore(s => s.setDockerTab)
  const { status, df, images, containers, volumes, loading, error, refresh, refreshContainers, refreshVolumes } = useDockerData()
  const [composeTick, setComposeTick] = useState(0)
  const [starting, setStarting]       = useState(false)
  const [startError, setStartError]   = useState<string | null>(null)

  const online   = status?.available ?? false
  const subtitle = TAB_SUBTITLES[dockerTab] ?? ''

  // Ctrl+R / Cmd+R → Refresh
  const handleRefresh = useCallback(() => {
    refresh(); setComposeTick(t => t + 1)
  }, [refresh])

  const handleStartDocker = useCallback(async () => {
    setStarting(true)
    setStartError(null)
    try {
      await api.launchDockerDesktop()
      // Docker Desktop takes ~30–60 s to start; auto-refresh after 8 s so the
      // user sees progress without having to click Refresh manually.
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

  // ── Compute tab badges ───────────────────────────────────────────────────────
  const tabBadges: Partial<Record<DockerTab, string>> = {}
  if (images.length) tabBadges['images'] = String(images.length)
  if (containers.length) {
    const running = containers.filter(c => c.state === 'running').length
    tabBadges['containers'] = running > 0
      ? `${running}/${containers.length}`
      : String(containers.length)
  }
  if (volumes.length) {
    const unused = volumes.filter(v => !v.in_use).length
    tabBadges['volumes'] = unused > 0
      ? `${volumes.length} · ${unused} unused`
      : String(volumes.length)
  }

  return (
    <div className="view-container docker-view">

      {/* ── View header ──────────────────────────────────────────────── */}
      <div className="view-header docker-view-header">
        <div className="view-header-icon"><Box size={18} /></div>
        <div style={{ flex: 1 }}>
          <div className="view-header-title-row">
            <h1 className="view-title">Docker & Containers</h1>
            {loading && !status && (
              <span className="status-text">Connecting…</span>
            )}
            {status && (
              <>
                <span className={clsx('status-dot', online ? 'online' : 'offline')} />
                <span className="status-text">
                  {online ? `v${status.version ?? 'unknown'}` : 'not running'}
                </span>
              </>
            )}
          </div>
          {subtitle && <p className="view-subtitle">{subtitle}</p>}
        </div>
        <button
          className="btn-refresh"
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh data (Ctrl+R)"
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── In-content tab strip ──────────────────────────────────────── */}
      <div className="docker-tab-strip">
        {DOCKER_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={clsx('docker-tab-btn', dockerTab === id && 'active')}
            onClick={() => setDockerTab(id)}
          >
            <Icon size={13} />
            {label}
            {tabBadges[id] && (
              <span className="docker-tab-badge">{tabBadges[id]}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Error / offline states ───────────────────────────────────── */}
      {error && (
        <div className="error-banner" style={{ marginTop: 20 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {!loading && status && !online && status.state === 'not_installed' && (
        <div className="docker-install-card" style={{ marginTop: 20 }}>
          <div className="docker-install-icon"><Download size={28} /></div>
          <h2 className="docker-install-title">Docker is not installed</h2>
          <p className="docker-install-desc">
            Docker Desktop is required to use this application. Download and install it for Windows, then restart the app.
          </p>
          <ol className="docker-install-steps">
            <li>Download <strong>Docker Desktop for Windows</strong> from docker.com</li>
            <li>Run the installer and follow the on-screen instructions</li>
            <li>Start Docker Desktop and wait for the engine to come online</li>
            <li>Return here and click <strong>Refresh</strong></li>
          </ol>
          <div className="docker-install-actions">
            <button
              className="btn-primary"
              onClick={() => openUrl('https://www.docker.com/products/docker-desktop/')}
            >
              <ExternalLink size={14} />
              Download Docker Desktop
            </button>
            <button className="btn-refresh" onClick={handleRefresh}>
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>
        </div>
      )}

      {!loading && status && !online && status.state === 'stopped' && (
        <div className="offline-card" style={{ marginTop: 20 }}>
          <p className="offline-title">Docker Desktop is not running</p>
          {starting ? (
            <p className="offline-desc">
              <RefreshCw size={13} className="spin" style={{ display: 'inline', marginRight: 6 }} />
              Starting Docker Desktop… this can take up to a minute.
            </p>
          ) : (
            <p className="offline-desc">
              Docker Desktop is installed but the engine is stopped.
              Start it below or from the system tray, then click Refresh.
            </p>
          )}
          {startError && <code className="offline-code" style={{ color: 'var(--color-danger)' }}>{startError}</code>}
          {status.error && !startError && <code className="offline-code">{status.error}</code>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="btn-primary"
              onClick={handleStartDocker}
              disabled={starting}
            >
              <Play size={13} />
              {starting ? 'Starting…' : 'Start Docker Desktop'}
            </button>
            <button className="btn-refresh" onClick={handleRefresh} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      )}

      {/* ── Tab content ──────────────────────────────────────────────── */}
      {(online || loading) && (
        <div className="docker-tab-content">
          {dockerTab === 'overview'   && <OverviewTab df={df} containers={containers} images={images} volumes={volumes} status={status} loading={loading} refreshTick={composeTick} />}
          {dockerTab === 'images'     && <ImagesTab images={images} loading={loading} />}
          {dockerTab === 'containers' && <ContainersTab containers={containers} loading={loading} onRefresh={refreshContainers} />}

          {/* VolumesTab stays mounted while Docker is online so that in-progress
              backups, event listeners, and progress state survive tab switches. */}
          <div className={dockerTab !== 'volumes' ? 'tab-hidden' : undefined}>
            <VolumesTab volumes={volumes} loading={loading} onRefresh={refreshVolumes} />
          </div>

          {dockerTab === 'networks'   && <NetworksTab />}
          {dockerTab === 'compose'    && <ComposeTab refreshTick={composeTick} />}
          {dockerTab === 'prune'      && <PruneTab images={images} onDone={refresh} />}
          {dockerTab === 'log'        && <LogTab />}
        </div>
      )}
    </div>
  )
}
