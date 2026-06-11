import clsx from 'clsx'
import { LayoutDashboard, ListChecks, Gauge, FileCog, Star, SquareTerminal, Terminal, FolderOpen } from 'lucide-react'
import { useAppStore, type WslDistroTab } from '../../../store/appStore'
import * as api from '../api'
import type { WslDistro } from '../types'
import WslDashboardTab from './WslDashboardTab'
import WslStartupTab from './WslStartupTab'
import WslPerformanceTab from './WslPerformanceTab'
import WslConfTab from './WslConfTab'

const TABS: { id: WslDistroTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview',    label: 'Overview',    icon: LayoutDashboard },
  { id: 'startup',     label: 'Startup',     icon: ListChecks },
  { id: 'performance', label: 'Performance', icon: Gauge },
  { id: 'config',      label: 'Config',      icon: FileCog },
]

/** Per-distribution page: identity strip + Overview/Startup/Performance/Config
 *  tabs. The distro shown is the global selection (header dropdown / sidebar). */
export default function WslDistroPage({ distros, onReload }: {
  distros: WslDistro[]
  onReload: () => void
}) {
  const selected    = useAppStore(s => s.wslSelectedDistro) ?? ''
  const tab         = useAppStore(s => s.wslDistroTab)
  const setTab      = useAppStore(s => s.setWslDistroTab)
  const addActivity = useAppStore(s => s.addActivity)

  const d = distros.find(x => x.name === selected)
  if (!d) {
    return <p className="empty-state" style={{ marginTop: 8 }}>Select a distribution from the sidebar.</p>
  }

  const openTerminal = () => {
    api.wslOpenTerminal(d.name).catch(() => {})
    addActivity({ module: 'wsl', action: `Opened terminal · ${d.name}`, outcome: 'info' })
  }

  return (
    <div className="wsl-distro-page">
      <div className="wsl-identity">
        <span className={clsx('wsl-distro-tile', !d.running && 'wsl-distro-tile--off')}><SquareTerminal size={16} /></span>
        <span className="wsl-identity-name">{d.name}</span>
        {d.is_default && <Star size={11} className="wsl-distro-star" />}
        <span className={clsx('wsl-state-pill', d.running ? 'wsl-state-pill--running' : 'wsl-state-pill--stopped')}>
          <span className="wsl-state-pill-dot" />{d.running ? 'Running' : 'Stopped'}
        </span>
        <span className="wsl-ver-badge">WSL {d.version === 1 ? '1' : '2'}</span>
        <div className="wsl-identity-actions">
          <button className="btn-secondary" onClick={openTerminal} title="Open a terminal in this distro">
            <Terminal size={13} /> Terminal
          </button>
          <button className="btn-secondary" onClick={() => api.wslOpenDistroFolder(d.name).catch(() => {})} title="Open the distro's files in Explorer (\\wsl.localhost)">
            <FolderOpen size={13} /> Files
          </button>
        </div>
      </div>

      <div className="wsl-page-tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={clsx('wsl-page-tab', tab === id && 'wsl-page-tab--active')}
            onClick={() => setTab(id)}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === 'overview'    && <WslDashboardTab distros={distros} />}
      {tab === 'startup'     && <WslStartupTab distros={distros} onGoToConf={() => setTab('config')} />}
      {tab === 'performance' && <WslPerformanceTab distros={distros} />}
      {tab === 'config'      && (
        <WslConfTab
          distros={distros}
          runningNames={distros.filter(x => x.running).map(x => x.name)}
          onAfterShutdown={onReload}
        />
      )}
    </div>
  )
}
