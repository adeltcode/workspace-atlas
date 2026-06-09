import { LayoutDashboard, Box, HardDrive, Package, Bot, Settings, FileText, FileCode2, FileKey } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type View, type DockerTab, type WslTab, type WslConfigSub } from '../store/appStore'
import { composeStatusLabel } from '../utils/format'

// ── Top-level module nav ──────────────────────────────────────────────────────

const TOP_NAV: { view: View; label: string; icon: React.ElementType }[] = [
  { view: 'dashboard',  label: 'Dashboard',      icon: LayoutDashboard },
  { view: 'docker',     label: 'Docker',          icon: Box             },
  { view: 'wsl',        label: 'WSL',             icon: HardDrive       },
  { view: 'packages',   label: 'Package Scanner', icon: Package         },
  { view: 'automation', label: 'Automation',      icon: Bot             },
]

// ── Docker child tabs ─────────────────────────────────────────────────────────

const DOCKER_TABS: { id: DockerTab; label: string }[] = [
  { id: 'overview',   label: 'Overview'   },
  { id: 'images',     label: 'Images'     },
  { id: 'containers', label: 'Containers' },
  { id: 'volumes',    label: 'Volumes'    },
  { id: 'networks',   label: 'Networks'   },
  { id: 'compose',    label: 'Compose'    },
  { id: 'prune',      label: 'Prune'      },
  { id: 'log',        label: 'Log'        },
]

// ── WSL child tabs ──────────────────────────────────────────────────────────────

const WSL_TABS: { id: WslTab; label: string }[] = [
  { id: 'dashboard',   label: 'Dashboard'     },
  { id: 'distros',     label: 'Distributions' },
  { id: 'startup',     label: 'Startup'       },
  { id: 'performance', label: 'Performance'   },
  { id: 'config',      label: 'Config'        },
]

const WSL_CONFIG_SUBS: { id: WslConfigSub; label: string }[] = [
  { id: 'wslconfig', label: '.wslconfig' },
  { id: 'conf',      label: 'wsl.conf'   },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const activeView           = useAppStore(s => s.activeView)
  const setActiveView        = useAppStore(s => s.setActiveView)
  const dockerTab            = useAppStore(s => s.dockerTab)
  const setDockerTab         = useAppStore(s => s.setDockerTab)
  const dockerBadges         = useAppStore(s => s.dockerBadges)
  const composeProjectsNav   = useAppStore(s => s.composeProjectsNav)
  const composeActiveProject = useAppStore(s => s.composeActiveProject)
  const composeFilesNav      = useAppStore(s => s.composeFilesNav)
  const composeActiveFilePath = useAppStore(s => s.composeActiveFilePath)
  const wslTab               = useAppStore(s => s.wslTab)
  const setWslTab            = useAppStore(s => s.setWslTab)
  const wslConfigSub         = useAppStore(s => s.wslConfigSub)
  const setWslConfigSub      = useAppStore(s => s.setWslConfigSub)
  const wslSelectedDistro    = useAppStore(s => s.wslSelectedDistro)
  const wslDistrosNav        = useAppStore(s => s.wslDistrosNav)
  const wslBadges            = useAppStore(s => s.wslBadges)

  const goDockerTab = (id: DockerTab) => {
    setActiveView('docker')
    setDockerTab(id)
  }

  const goWslTab = (id: WslTab) => {
    setActiveView('wsl')
    setWslTab(id)
  }

  const goWslDistro = (name: string) => {
    setActiveView('wsl')
    useAppStore.getState().setWslSelectedDistro(name)
    setWslTab('dashboard')
  }

  const goComposeProject = (name: string) => {
    setActiveView('docker')
    setDockerTab('compose')
    useAppStore.getState().setComposePreselect(name)
  }

  const goComposeOverview = () => {
    setActiveView('docker')
    setDockerTab('compose')
    useAppStore.getState().setComposeShowOverview(true)
    useAppStore.getState().setComposeActiveProject(null)
  }

  const openComposeFile = (path: string) => {
    setActiveView('docker')
    setDockerTab('compose')
    useAppStore.getState().setComposeFileSelect(path)
  }

  const childBadge = (id: DockerTab): string | undefined => {
    if (!dockerBadges) return undefined
    if (id === 'images'     && dockerBadges.images > 0)  return String(dockerBadges.images)
    if (id === 'containers' && dockerBadges.containers)  return dockerBadges.containers
    if (id === 'volumes'    && dockerBadges.volumes)     return dockerBadges.volumes
    return undefined
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-nav-group">
        <span className="sidebar-section-label">Modules</span>
        <ul className="sidebar-nav">
          {TOP_NAV.map(({ view, label, icon: Icon }) => (
            <li key={view}>
              <button
                className={clsx('sidebar-item', activeView === view && 'active')}
                onClick={() => setActiveView(view)}
                aria-current={activeView === view ? 'page' : undefined}
              >
                <span className="sidebar-item-icon-wrap"><Icon size={15} /></span>
                <span className="sidebar-item-label">{label}</span>
              </button>

              {/* Docker child nav — only when Docker module is active */}
              {view === 'docker' && activeView === 'docker' && (
                <ul className="sidebar-children">
                  {DOCKER_TABS.map(({ id, label: tabLabel }) => {
                    const badge = childBadge(id)
                    return (
                      <li key={id}>
                        <button
                          className={clsx('sidebar-child-item', dockerTab === id && 'active')}
                          onClick={() => goDockerTab(id)}
                        >
                          <span className="sidebar-child-label">{tabLabel}</span>
                          {badge && <span className="sidebar-child-badge">{badge}</span>}
                        </button>

                        {/* Compose project grandchild items — only when Compose tab is active */}
                        {id === 'compose' && dockerTab === 'compose' && composeProjectsNav.length > 0 && (
                          <ul className="sidebar-grandchildren">
                            {/* Overview item — always first */}
                            <li>
                              <button
                                className={clsx('sidebar-grandchild-item', composeActiveProject === null && 'active')}
                                onClick={goComposeOverview}
                              >
                                <span className="sidebar-compose-dot" style={{ background: 'var(--color-text-tertiary)', opacity: 0.5 }} />
                                <span className="sidebar-grandchild-label">Overview</span>
                              </button>
                            </li>
                            {composeProjectsNav.map(p => {
                              const { dot, running, total } = composeStatusLabel(p.status)
                              const isActive = dockerTab === 'compose' && composeActiveProject === p.name
                              return (
                                <li key={p.name}>
                                  <button
                                    className={clsx('sidebar-grandchild-item', isActive && 'active')}
                                    onClick={() => goComposeProject(p.name)}
                                    title={`${p.name} — ${running}/${total} running`}
                                  >
                                    <span className={clsx('sidebar-compose-dot', dot)} />
                                    <span className="sidebar-grandchild-label">{p.name}</span>
                                    {total > 0 && (
                                      <span className={clsx(
                                        'sidebar-compose-frac',
                                        dot === 'running' ? 'frac--ok'
                                          : dot === 'partial' ? 'frac--warn'
                                          : 'frac--off',
                                      )}>
                                        {running}/{total}
                                      </span>
                                    )}
                                  </button>

                                  {/* Project files — sidebar menu in place of editor tabs */}
                                  {isActive && composeFilesNav.length > 0 && (
                                    <ul className="sidebar-files">
                                      {composeFilesNav.map(f => (
                                        <li key={f.path}>
                                          <button
                                            className={clsx('sidebar-file-item', composeActiveFilePath === f.path && 'active')}
                                            onClick={() => openComposeFile(f.path)}
                                            title={f.path}
                                          >
                                            <span className="sidebar-file-icon">
                                              {f.kind === 'dockerfile' ? <FileCode2 size={12} />
                                                : f.kind === 'env' ? <FileKey size={12} />
                                                : <FileText size={12} />}
                                            </span>
                                            <span className="sidebar-file-label">{f.label}</span>
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {/* WSL child nav — only when WSL module is active */}
              {view === 'wsl' && activeView === 'wsl' && (
                <ul className="sidebar-children">
                  {WSL_TABS.map(({ id, label: tabLabel }) => (
                    <li key={id}>
                      <button
                        className={clsx('sidebar-child-item', wslTab === id && 'active')}
                        onClick={() => goWslTab(id)}
                      >
                        <span className="sidebar-child-label">{tabLabel}</span>
                        {id === 'distros' && wslBadges?.distros && (
                          <span className="sidebar-child-badge">{wslBadges.distros}</span>
                        )}
                      </button>

                      {/* Distro grandchildren — only when Distributions tab is active */}
                      {id === 'distros' && wslTab === 'distros' && wslDistrosNav.length > 0 && (
                        <ul className="sidebar-grandchildren">
                          {wslDistrosNav.map(d => (
                            <li key={d.name}>
                              <button
                                className={clsx('sidebar-grandchild-item', wslSelectedDistro === d.name && 'active')}
                                onClick={() => goWslDistro(d.name)}
                                title={`${d.name}${d.is_default ? ' (default)' : ''} — ${d.running ? 'running' : 'stopped'}`}
                              >
                                <span className={clsx('sidebar-compose-dot', d.running ? 'running' : 'stopped')} />
                                <span className="sidebar-grandchild-label">{d.name}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* Config editor grandchildren — only when Config tab is active */}
                      {id === 'config' && wslTab === 'config' && (
                        <ul className="sidebar-grandchildren">
                          {WSL_CONFIG_SUBS.map(sub => (
                            <li key={sub.id}>
                              <button
                                className={clsx('sidebar-grandchild-item', wslConfigSub === sub.id && 'active')}
                                onClick={() => { setActiveView('wsl'); setWslTab('config'); setWslConfigSub(sub.id) }}
                              >
                                <span className="sidebar-grandchild-label">{sub.label}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-version">v0.1.0-dev</span>
        <button
          className={clsx('sidebar-settings-btn', activeView === 'settings' && 'active')}
          onClick={() => setActiveView('settings')}
          title="Settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </nav>
  )
}
