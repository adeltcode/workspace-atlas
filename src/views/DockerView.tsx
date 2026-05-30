import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Box, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../store/appStore'
import type { DockerStatus, DockerSystemDf, DockerImage } from '../types/docker'
import OverviewTab from '../components/docker/OverviewTab'
import ImagesTab   from '../components/docker/ImagesTab'
import PruneTab    from '../components/docker/PruneTab'
import LogTab      from '../components/docker/LogTab'

type Tab = 'overview' | 'images' | 'prune' | 'log'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'images',   label: 'Images'   },
  { id: 'prune',    label: 'Prune'    },
  { id: 'log',      label: 'Log'      },
]

export default function DockerView() {
  const addTerminalLine = useAppStore(s => s.addTerminalLine)

  const [tab, setTab]         = useState<Tab>('overview')
  const [status, setStatus]   = useState<DockerStatus | null>(null)
  const [df, setDf]           = useState<DockerSystemDf | null>(null)
  const [images, setImages]   = useState<DockerImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    const CMD_CHECK = 'docker version --format "{{.Server.Version}}"'
    const CMD_DF    = 'docker system df'
    const CMD_IMGS  = 'docker images --format "{{json .}}"'

    try {
      addTerminalLine(`$ ${CMD_CHECK}`, 'cmd')
      const s = await invoke<DockerStatus>('docker_check')
      setStatus(s)

      if (s.available) {
        addTerminalLine(`  → Docker v${s.version ?? 'unknown'}`, 'info')
        addTerminalLine(`$ ${CMD_DF}`, 'cmd')
        addTerminalLine(`$ ${CMD_IMGS}`, 'cmd')

        const [dfData, imgData] = await Promise.all([
          invoke<DockerSystemDf>('docker_system_df')
            .then(d => { addTerminalLine(`  ✓ system df complete`, 'success'); return d })
            .catch(e => { addTerminalLine(`  ✗ ${String(e)}`, 'error'); throw e }),
          invoke<DockerImage[]>('docker_images')
            .then(d => { addTerminalLine(`  ✓ ${d.length} image(s) loaded`, 'success'); return d })
            .catch(e => { addTerminalLine(`  ✗ ${String(e)}`, 'error'); throw e }),
        ])
        setDf(dfData)
        setImages(imgData)
      } else {
        addTerminalLine(`  ✗ Docker not running: ${s.error ?? 'unknown error'}`, 'error')
        setDf(null)
        setImages([])
      }
    } catch (e) {
      setError(String(e))
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [addTerminalLine])

  useEffect(() => { refresh() }, [refresh])

  const online = status?.available ?? false

  return (
    <div className="view-container">
      {/* Header */}
      <div className="view-header">
        <div className="view-header-icon">
          <Box size={18} />
        </div>
        <div>
          <h1 className="view-title">Docker & Containers</h1>
          <p className="view-subtitle">Manage images, containers, and reclaim disk space</p>
        </div>
      </div>

      {/* Status bar */}
      <div className="docker-status-bar">
        <div className="docker-status-left">
          {loading && !status ? (
            <span className="status-text">Connecting to Docker…</span>
          ) : status ? (
            <>
              <span className={clsx('status-dot', online ? 'online' : 'offline')} />
              <span className="status-text">
                {online
                  ? `Docker Desktop running${status.version ? ` — v${status.version}` : ''}`
                  : 'Docker is not running'}
              </span>
            </>
          ) : null}
        </div>
        <button
          className="btn-refresh"
          onClick={refresh}
          disabled={loading}
          title="Refresh data"
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="error-banner">
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {/* Docker not running */}
      {!loading && status && !online && (
        <div className="offline-card">
          <p className="offline-title">Docker Desktop is not running</p>
          <p className="offline-desc">Start Docker Desktop, then click Refresh.</p>
          {status.error && <code className="offline-code">{status.error}</code>}
        </div>
      )}

      {/* Tabs */}
      {(online || loading) && (
        <>
          <div className="docker-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={clsx('docker-tab', tab === t.id && 'active')}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="docker-tab-content" key={tab}>
            {tab === 'overview' && <OverviewTab df={df} loading={loading} />}
            {tab === 'images'   && <ImagesTab images={images} loading={loading} />}
            {tab === 'prune'    && <PruneTab images={images} onDone={refresh} />}
            {tab === 'log'      && <LogTab />}
          </div>
        </>
      )}
    </div>
  )
}
