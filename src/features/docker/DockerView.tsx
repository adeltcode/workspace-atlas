import { Box, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import { useDockerData } from './hooks'
import OverviewTab    from './components/OverviewTab'
import ImagesTab      from './components/ImagesTab'
import ContainersTab  from './components/ContainersTab'
import VolumesTab     from './components/VolumesTab'
import PruneTab       from './components/PruneTab'
import LogTab         from './components/LogTab'

export default function DockerView() {
  const dockerTab = useAppStore(s => s.dockerTab)
  const { status, df, images, containers, volumes, loading, error, refresh } = useDockerData()

  const online = status?.available ?? false

  return (
    <div className="view-container">
      <div className="view-header">
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
          <p className="view-subtitle">Manage images, containers, and reclaim disk space</p>
        </div>
        <button className="btn-refresh" onClick={refresh} disabled={loading} title="Refresh data">
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="error-banner">
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {!loading && status && !online && (
        <div className="offline-card">
          <p className="offline-title">Docker Desktop is not running</p>
          <p className="offline-desc">Start Docker Desktop, then click Refresh.</p>
          {status.error && <code className="offline-code">{status.error}</code>}
        </div>
      )}

      {(online || loading) && (
        <div className="docker-tab-content">
          {dockerTab === 'overview'    && <OverviewTab df={df} loading={loading} />}
          {dockerTab === 'images'      && <ImagesTab images={images} loading={loading} />}
          {dockerTab === 'containers'  && <ContainersTab containers={containers} loading={loading} onRefresh={refresh} />}
          {dockerTab === 'volumes'     && <VolumesTab volumes={volumes} loading={loading} onRefresh={refresh} />}
          {dockerTab === 'prune'       && <PruneTab images={images} onDone={refresh} />}
          {dockerTab === 'log'         && <LogTab />}
        </div>
      )}
    </div>
  )
}
