import { useCallback, useEffect } from 'react'
import { HardDrive, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type WslTab } from '../store/appStore'
import { useWslData } from '../features/wsl/hooks'
import DistroSwitcher from '../features/wsl/components/DistroSwitcher'
import WslDashboardTab from '../features/wsl/components/WslDashboardTab'
import WslDistrosTab from '../features/wsl/components/WslDistrosTab'
import WslStartupTab from '../features/wsl/components/WslStartupTab'
import WslPerformanceTab from '../features/wsl/components/WslPerformanceTab'
import WslConfigTab from '../features/wsl/components/WslConfigTab'
import WslConfTab from '../features/wsl/components/WslConfTab'

const TAB_SUBTITLES: Record<WslTab, string> = {
  dashboard:   'Live CPU, memory, disk, network, and process metrics inside the selected distro',
  distros:     'Compare distributions and export, import, clone, restart, or migrate them',
  startup:     'View and manage the systemd services that start with the distro',
  performance: 'Benchmark cold-boot time and profile shell startup',
  config:      'Edit machine-wide .wslconfig and the selected distro’s wsl.conf',
}

/** Tabs that act on a single distro and therefore show the header switcher. */
const PER_DISTRO: WslTab[] = ['dashboard', 'startup', 'performance']

export default function WslView() {
  const wslTab        = useAppStore(s => s.wslTab)
  const configSub     = useAppStore(s => s.wslConfigSub)
  const selected      = useAppStore(s => s.wslSelectedDistro)
  const setSelected   = useAppStore(s => s.setWslSelectedDistro)
  const setWslTab     = useAppStore(s => s.setWslTab)

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

  const goToConf = useCallback(() => {
    setWslTab('config')
    useAppStore.getState().setWslConfigSub('conf')
  }, [setWslTab])

  const showSwitcher = available && (PER_DISTRO.includes(wslTab) || (wslTab === 'config' && configSub === 'conf'))

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
            {showSwitcher && <DistroSwitcher distros={distros} />}
          </div>
          <p className="view-subtitle">{TAB_SUBTITLES[wslTab]}</p>
        </div>
        <button className="btn-refresh" onClick={reload} disabled={loading} title="Refresh (Ctrl+R)">
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          Refresh
        </button>
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
          {wslTab === 'dashboard'   && <WslDashboardTab distros={distros} />}
          {wslTab === 'distros'     && <WslDistrosTab distros={distros} loading={loading} onReload={reload} />}
          {wslTab === 'startup'     && <WslStartupTab distros={distros} onGoToConf={goToConf} />}
          {wslTab === 'performance' && <WslPerformanceTab distros={distros} />}
          {wslTab === 'config' && configSub === 'wslconfig' && (
            <WslConfigTab runningNames={distros.filter(d => d.running).map(d => d.name)} onAfterShutdown={reload} />
          )}
          {wslTab === 'config' && configSub === 'conf' && (
            <WslConfTab distros={distros} runningNames={distros.filter(d => d.running).map(d => d.name)} onAfterShutdown={reload} />
          )}
        </div>
      )}
    </div>
  )
}
