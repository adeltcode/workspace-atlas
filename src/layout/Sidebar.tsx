import { LayoutDashboard, Box, HardDrive, Package, Bot } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type View, type DockerTab } from '../store/appStore'

const NAV_ITEMS: { view: View; label: string; icon: React.ElementType }[] = [
  { view: 'dashboard',  label: 'Dashboard',       icon: LayoutDashboard },
  { view: 'docker',     label: 'Docker',           icon: Box             },
  { view: 'wsl',        label: 'WSL2 Optimizer',   icon: HardDrive       },
  { view: 'packages',   label: 'Package Scanner',  icon: Package         },
  { view: 'automation', label: 'Automation',       icon: Bot             },
]

const DOCKER_CHILDREN: { tab: DockerTab; label: string }[] = [
  { tab: 'overview',    label: 'Overview'    },
  { tab: 'images',      label: 'Images'      },
  { tab: 'containers',  label: 'Containers'  },
  { tab: 'volumes',     label: 'Volumes'     },
  { tab: 'networks',    label: 'Networks'    },
  { tab: 'compose',     label: 'Compose'     },
  { tab: 'backup',      label: 'Backup'      },
  { tab: 'prune',       label: 'Prune'       },
  { tab: 'log',         label: 'Log'         },
]

function TabBadge({ children }: { children: React.ReactNode }) {
  return <span className="sidebar-tab-badge">{children}</span>
}

export default function Sidebar() {
  const { activeView, setActiveView, dockerTab, setDockerTab } = useAppStore()
  const cache = useAppStore(s => s.dockerCache)

  // Compute badge labels from cache
  const badges: Partial<Record<DockerTab, string>> = {}
  if (cache) {
    const { images, containers, volumes } = cache

    if (images.length)
      badges['images'] = String(images.length)

    const running = containers.filter(c => c.state === 'running').length
    if (containers.length)
      badges['containers'] = running > 0
        ? `${running}/${containers.length}`
        : String(containers.length)

    const unused = volumes.filter(v => !v.in_use).length
    if (volumes.length)
      badges['volumes'] = unused > 0
        ? `${volumes.length} · ${unused} unused`
        : String(volumes.length)
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-nav-group">
        <span className="sidebar-section-label">Modules</span>
        <ul className="sidebar-nav">
          {NAV_ITEMS.map(({ view, label, icon: Icon }) => (
            <li key={view}>
              <button
                className={clsx('sidebar-item', activeView === view && 'active')}
                onClick={() => setActiveView(view)}
                aria-current={activeView === view ? 'page' : undefined}
              >
                <span className="sidebar-item-icon-wrap"><Icon size={15} /></span>
                <span className="sidebar-item-label">{label}</span>
              </button>

              {/* Docker child navigation — visible when Docker is active */}
              {view === 'docker' && activeView === 'docker' && (
                <ul className="sidebar-children">
                  {DOCKER_CHILDREN.map(({ tab, label: childLabel }) => (
                    <li key={tab}>
                      <button
                        className={clsx('sidebar-child-item', dockerTab === tab && 'active')}
                        onClick={() => setDockerTab(tab)}
                      >
                        <span className="sidebar-child-label">{childLabel}</span>
                        {badges[tab] && <TabBadge>{badges[tab]}</TabBadge>}
                      </button>
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
      </div>
    </nav>
  )
}
