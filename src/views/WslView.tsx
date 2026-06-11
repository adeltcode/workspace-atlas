import { useEffect } from 'react'
import { HardDrive, RefreshCw, Upload } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type WslDistroTab } from '../store/appStore'
import { useWslData } from '../features/wsl/hooks'
import DistroSwitcher from '../features/wsl/components/DistroSwitcher'
import WslHome from '../features/wsl/components/WslHome'
import WslDistroPage from '../features/wsl/components/WslDistroPage'
import WslConfigTab from '../features/wsl/components/WslConfigTab'

const DISTRO_TAB_SUBTITLES: Record<WslDistroTab, string> = {
  overview:    'Live CPU, memory, disk, network, and process metrics inside this distro',
  startup:     'View and manage the systemd services that start with this distro',
  performance: 'Benchmark cold-boot time and profile shell startup',
  config:      'Edit /etc/wsl.conf inside this distro',
}

export default function WslView() {
  const wslView      = useAppStore(s => s.wslView)
  const wslDistroTab = useAppStore(s => s.wslDistroTab)
  const selected     = useAppStore(s => s.wslSelectedDistro)
  const setSelected  = useAppStore(s => s.setWslSelectedDistro)

  const { status, distros, loading, error, reload } = useWslData()
  const available  = status?.available ?? false
  const runningCnt = distros.filter(d => d.running).length

  // Publish the distro list + badge to the store for the sidebar nav.
  useEffect(() => {
    useAppStore.getState().setWslDistrosNav(
      distros.map(d => ({ name: d.name, running: d.running, is_default: d.is_default, version: d.version })),
    )
    useAppStore.getState().setWslBadges(
      distros.length
        ? { distros: runningCnt > 0 ? `${runningCnt}/${distros.length}` : String(distros.length) }
        : null,
    )
  }, [distros, runningCnt])

  // Default the global selection to the default distro (or first), and keep it
  // valid if the current selection disappears (e.g. after migrate/unregister).
  useEffect(() => {
    if (distros.length === 0) return
    if (!selected || !distros.some(d => d.name === selected)) {
      setSelected((distros.find(d => d.is_default) ?? distros[0]).name)
    }
  }, [distros, selected, setSelected])

  // Ctrl+R / Cmd+R → Refresh
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'r' && !e.shiftKey) {
        e.preventDefault(); reload()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reload])

  const subtitle =
    wslView === 'dashboard'  ? 'All distributions at a glance: manage, clone, export, and optimize'
    : wslView === 'wslconfig' ? 'Machine-wide WSL2 settings, applied to every distribution'
    : DISTRO_TAB_SUBTITLES[wslDistroTab]

  return (
    <div className="view-container wsl-view">
      <div className="view-header">
        <div className="view-header-icon"><HardDrive size={18} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="view-header-title-row">
            <h1 className="view-title">WSL</h1>
            {status && (
              <>
                <span className={clsx('status-dot', available ? 'online' : 'offline')} />
                <span className="status-text">
                  {available
                    ? `${distros.length} distro${distros.length !== 1 ? 's' : ''}${runningCnt ? ` · ${runningCnt} running` : ''}`
                    : 'not installed'}
                </span>
              </>
            )}
            {available && wslView === 'distro' && <DistroSwitcher distros={distros} />}
          </div>
          <p className="view-subtitle">{subtitle}</p>
        </div>
        <button className="btn-refresh" onClick={reload} disabled={loading} title="Refresh (Ctrl+R)">
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          Refresh
        </button>
        {available && wslView === 'dashboard' && (
          <button className="btn-filled btn-filled--accent" onClick={() => useAppStore.getState().setWslImportOpen(true)}>
            <Upload size={13} /> Import distro
          </button>
        )}
      </div>

      {error && (
        <div className="error-banner" style={{ marginTop: 20 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {!loading && status && !available && (
        <div className="offline-card" style={{ marginTop: 20 }}>
          <p className="offline-title">WSL is not installed</p>
          <p className="offline-desc">
            The Windows Subsystem for Linux is required for this module.
            Install it from an elevated terminal, then click Refresh.
          </p>
          <code className="offline-code">wsl --install</code>
        </div>
      )}

      {available && (
        <div className="wsl-tab-content">
          {wslView === 'dashboard' && <WslHome distros={distros} loading={loading} onReload={reload} />}
          {wslView === 'distro'    && <WslDistroPage distros={distros} onReload={reload} />}
          {wslView === 'wslconfig' && (
            <WslConfigTab runningNames={distros.filter(d => d.running).map(d => d.name)} onAfterShutdown={reload} />
          )}
        </div>
      )}
    </div>
  )
}
