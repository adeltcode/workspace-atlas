import { useState, useEffect, useCallback } from 'react'
import {
  Box, RefreshCw,
  LayoutGrid, Layers, Boxes, Database, Network,
  FileCode, Eraser, ScrollText,
} from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type DockerTab } from '../../store/appStore'
import { useDockerData } from './hooks'
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

  const online   = status?.available ?? false
  const subtitle = TAB_SUBTITLES[dockerTab] ?? ''

  // Ctrl+R / Cmd+R → Refresh
  const handleRefresh = useCallback(() => {
    refresh(); setComposeTick(t => t + 1)
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

      {!loading && status && !online && (
        <div className="offline-card" style={{ marginTop: 20 }}>
          <p className="offline-title">Docker Desktop is not running</p>
          <p className="offline-desc">Start Docker Desktop, then click Refresh.</p>
          {status.error && <code className="offline-code">{status.error}</code>}
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
