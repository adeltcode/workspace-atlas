import { LayoutDashboard, Box, HardDrive, Package } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type View } from '../store/appStore'

const NAV_ITEMS: { view: View; label: string; icon: React.ElementType; badge?: string }[] = [
  { view: 'dashboard', label: 'Dashboard',          icon: LayoutDashboard },
  { view: 'docker',    label: 'Docker',              icon: Box             },
  { view: 'wsl',       label: 'WSL2 Optimizer',      icon: HardDrive       },
  { view: 'packages',  label: 'Package Scanner',     icon: Package         },
]

export default function Sidebar() {
  const { activeView, setActiveView } = useAppStore()

  return (
    <nav className="sidebar">
      {/* Branding */}
      <div className="sidebar-brand">
        <div className="sidebar-logo-mark">WA</div>
        <div className="sidebar-brand-text">
          <span className="sidebar-brand-name">Workspace</span>
          <span className="sidebar-brand-sub">Atlas</span>
        </div>
      </div>

      {/* Nav */}
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
                <span className="sidebar-item-icon-wrap">
                  <Icon size={15} />
                </span>
                <span className="sidebar-item-label">{label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Footer */}
      <div className="sidebar-footer">
        <span className="sidebar-version">v0.1.0-dev</span>
      </div>
    </nav>
  )
}
