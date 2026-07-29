/* The rail.
 *
 * Modules with their children nested underneath, because a compose project's
 * status and a distro's size are things you read at a glance rather than go and
 * look up. The guide line carries the nesting instead of deep indentation, so
 * three levels stay readable at 212px. */
import { LayoutDashboard, Box, HardDrive, Package, Settings, Keyboard } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type DockerTab, type WslView } from '../store/appStore'
import { composeStatusLabel } from '../utils/format'

const DOCKER_TABS: { id: DockerTab; label: string }[] = [
  { id: 'overview',   label: 'Overview'   },
  { id: 'images',     label: 'Images'     },
  { id: 'containers', label: 'Containers' },
  { id: 'volumes',    label: 'Volumes'    },
  { id: 'networks',   label: 'Networks'   },
  { id: 'compose',    label: 'Compose'    },
  { id: 'prune',      label: 'Prune'      },
  { id: 'log',        label: 'Run log'    },
]

export default function Sidebar() {
  const activeView    = useAppStore(s => s.activeView)
  const setActiveView = useAppStore(s => s.setActiveView)
  const dockerTab     = useAppStore(s => s.dockerTab)
  const setDockerTab  = useAppStore(s => s.setDockerTab)
  const dockerBadges  = useAppStore(s => s.dockerBadges)
  const composeProjectsNav   = useAppStore(s => s.composeProjectsNav)
  const composeActiveProject = useAppStore(s => s.composeActiveProject)
  const wslView       = useAppStore(s => s.wslView)
  const setWslView    = useAppStore(s => s.setWslView)
  const wslSelectedDistro = useAppStore(s => s.wslSelectedDistro)
  const wslDistrosNav = useAppStore(s => s.wslDistrosNav)
  const wslBadges     = useAppStore(s => s.wslBadges)
  const setShortcutsOpen = useAppStore(s => s.setShortcutsOpen)

  const goDockerTab = (id: DockerTab) => { setActiveView('docker'); setDockerTab(id) }
  const goWslView   = (v: WslView)    => { setActiveView('wsl'); setWslView(v) }
  const goWslDistro = (name: string) => {
    setActiveView('wsl')
    useAppStore.getState().setWslSelectedDistro(name)
    setWslView('distro')
  }
  const goComposeProject = (name: string) => {
    setActiveView('docker')
    setDockerTab('compose')
    useAppStore.getState().setComposePreselect(name)
  }

  const tabCount = (id: DockerTab): string | undefined => {
    if (!dockerBadges) return undefined
    if (id === 'images'     && dockerBadges.images > 0) return String(dockerBadges.images)
    if (id === 'containers' && dockerBadges.containers) return dockerBadges.containers
    if (id === 'volumes'    && dockerBadges.volumes)    return dockerBadges.volumes
    return undefined
  }

  return (
    <nav className="sidebar" aria-label="Modules">
      <div className="rail-group">
        <button
          className={clsx('rail-item', activeView === 'dashboard' && 'active')}
          onClick={() => setActiveView('dashboard')}
          aria-current={activeView === 'dashboard' ? 'page' : undefined}
        >
          <span className="rail-icon"><LayoutDashboard size={15} /></span>
          <span className="rail-label">Overview</span>
        </button>
      </div>

      <span className="rail-section">Environments</span>
      <div className="rail-group">
        <button
          className={clsx('rail-item', activeView === 'docker' && 'active')}
          onClick={() => setActiveView('docker')}
          aria-current={activeView === 'docker' ? 'page' : undefined}
        >
          <span className="rail-icon"><Box size={15} /></span>
          <span className="rail-label">Docker</span>
          {dockerBadges?.containers && <span className="rail-count">{dockerBadges.containers}</span>}
        </button>

        {activeView === 'docker' && (
          <div className="rail-kids">
            {DOCKER_TABS.map(({ id, label }) => (
              <div key={id}>
                <button
                  className={clsx('rail-kid', dockerTab === id && 'active')}
                  onClick={() => goDockerTab(id)}
                  style={{ width: '100%' }}
                >
                  <span className="rail-kid-label">{label}</span>
                  {tabCount(id) && <span className="rail-frac">{tabCount(id)}</span>}
                </button>

                {/* Compose projects: the grandchild level, with live state. */}
                {id === 'compose' && dockerTab === 'compose' && composeProjectsNav.length > 0 && (
                  <div className="rail-kids">
                    {composeProjectsNav.map(p => {
                      const { dot, running, total } = composeStatusLabel(p.status)
                      return (
                        <button
                          key={p.name}
                          className={clsx('rail-kid', composeActiveProject === p.name && 'active')}
                          onClick={() => goComposeProject(p.name)}
                          style={{ width: '100%' }}
                        >
                          <span className={clsx('rail-dot', dot)} />
                          <span className="rail-kid-label">{p.name}</span>
                          {total > 0 && <span className="rail-frac">{running}/{total}</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <button
          className={clsx('rail-item', activeView === 'wsl' && 'active')}
          onClick={() => setActiveView('wsl')}
          aria-current={activeView === 'wsl' ? 'page' : undefined}
        >
          <span className="rail-icon"><HardDrive size={15} /></span>
          <span className="rail-label">WSL</span>
          {wslBadges?.distros && <span className="rail-count">{wslBadges.distros}</span>}
        </button>

        {activeView === 'wsl' && (
          <div className="rail-kids">
            {wslDistrosNav.map(d => (
              <button
                key={d.name}
                className={clsx('rail-kid', wslView === 'distro' && wslSelectedDistro === d.name && 'active')}
                onClick={() => goWslDistro(d.name)}
                style={{ width: '100%' }}
              >
                <span className={clsx('rail-dot', d.running ? 'running' : 'stopped')} />
                <span className="rail-kid-label">{d.name}</span>
                {d.is_default && <span className="rail-frac">default</span>}
              </button>
            ))}
            <button
              className={clsx('rail-kid', wslView === 'install' && 'active')}
              onClick={() => goWslView('install')}
              style={{ width: '100%' }}
            >
              <span className="rail-kid-label">Install distro</span>
            </button>
            <button
              className={clsx('rail-kid', wslView === 'wslconfig' && 'active')}
              onClick={() => goWslView('wslconfig')}
              style={{ width: '100%' }}
            >
              <span className="rail-kid-label">.wslconfig</span>
            </button>
          </div>
        )}
      </div>

      <span className="rail-section">System</span>
      <div className="rail-group">
        <button
          className={clsx('rail-item', activeView === 'packages' && 'active')}
          onClick={() => setActiveView('packages')}
          aria-current={activeView === 'packages' ? 'page' : undefined}
        >
          <span className="rail-icon"><Package size={15} /></span>
          <span className="rail-label">Packages</span>
        </button>
        <button
          className={clsx('rail-item', activeView === 'settings' && 'active')}
          onClick={() => setActiveView('settings')}
          aria-current={activeView === 'settings' ? 'page' : undefined}
        >
          <span className="rail-icon"><Settings size={15} /></span>
          <span className="rail-label">Settings</span>
        </button>
      </div>

      <div className="rail-foot rail-group">
        <button className="rail-item" onClick={() => setShortcutsOpen(true)}>
          <span className="rail-icon"><Keyboard size={15} /></span>
          <span className="rail-label">Keyboard</span>
        </button>
      </div>
    </nav>
  )
}
