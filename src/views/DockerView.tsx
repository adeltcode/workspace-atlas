import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Box, RefreshCw, CheckCircle2, Loader2, Terminal, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
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

interface TraceEntry {
  cmd: string
  done: boolean
  error: boolean
}

export default function DockerView() {
  const [tab, setTab]         = useState<Tab>('overview')
  const [status, setStatus]   = useState<DockerStatus | null>(null)
  const [df, setDf]           = useState<DockerSystemDf | null>(null)
  const [images, setImages]   = useState<DockerImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [trace, setTrace]     = useState<TraceEntry[]>([])
  const [traceOpen, setTraceOpen] = useState(true)

  const traceRef = useRef<TraceEntry[]>([])

  const addCmd = (cmd: string) => {
    traceRef.current = [...traceRef.current, { cmd, done: false, error: false }]
    setTrace([...traceRef.current])
  }
  const doneCmd = (cmd: string, error = false) => {
    traceRef.current = traceRef.current.map(t =>
      t.cmd === cmd ? { ...t, done: true, error } : t
    )
    setTrace([...traceRef.current])
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    traceRef.current = []
    setTrace([])
    setTraceOpen(true)

    const CHECK = 'docker version --format "{{.Server.Version}}"'
    const DF    = 'docker system df'
    const IMGS  = 'docker images --format "{{json .}}"'

    try {
      addCmd(CHECK)
      const s = await invoke<DockerStatus>('docker_check')
      doneCmd(CHECK, !s.available)
      setStatus(s)

      if (s.available) {
        addCmd(DF)
        addCmd(IMGS)
        const [dfData, imgData] = await Promise.all([
          invoke<DockerSystemDf>('docker_system_df')
            .then(d => { doneCmd(DF); return d })
            .catch(e => { doneCmd(DF, true); throw e }),
          invoke<DockerImage[]>('docker_images')
            .then(d => { doneCmd(IMGS); return d })
            .catch(e => { doneCmd(IMGS, true); throw e }),
        ])
        setDf(dfData)
        setImages(imgData)
      } else {
        setDf(null)
        setImages([])
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const online = status?.available ?? false

  return (
    <div className="view-container">

      {/* Header */}
      <div className="view-header">
        <div className="view-header-icon">
          <Box size={20} />
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
        <div className="status-bar-right">
          {trace.length > 0 && (
            <button
              className="btn-trace-toggle"
              onClick={() => setTraceOpen(o => !o)}
              title="Toggle command trace"
            >
              <Terminal size={12} />
              <span>{trace.filter(t => t.done).length}/{trace.length}</span>
              <ChevronDown size={11} className={clsx('trace-chevron', traceOpen && 'open')} />
            </button>
          )}
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
      </div>

      {/* Command trace panel */}
      {trace.length > 0 && (
        <div className={clsx('trace-panel', traceOpen && 'open')}>
          <div className="trace-panel-inner">
            {trace.map((entry) => (
              <div
                key={entry.cmd}
                className={clsx(
                  'trace-row',
                  entry.done && (entry.error ? 'trace-err' : 'trace-done'),
                )}
              >
                <span className="trace-icon">
                  {!entry.done
                    ? <Loader2 size={11} className="spin" />
                    : entry.error
                    ? <span className="trace-x">✕</span>
                    : <CheckCircle2 size={11} />}
                </span>
                <code className="trace-cmd">$ {entry.cmd}</code>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {/* Tabs — key forces content remount on tab switch for fade-in */}
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
