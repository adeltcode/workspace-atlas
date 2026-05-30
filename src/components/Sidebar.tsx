import { LayoutDashboard, Box, HardDrive, Package } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type View } from '../store/appStore'

const NAV_ITEMS: { view: View; label: string; icon: React.ElementType }[] = [
  { view: 'dashboard', label: 'Dashboard',          icon: LayoutDashboard },
  { view: 'docker',    label: 'Docker & Containers', icon: Box },
  { view: 'wsl',       label: 'WSL2 Optimizer',      icon: HardDrive },
  { view: 'packages',  label: 'Package Scanner',     icon: Package },
]

export default function Sidebar() {
  const { activeView, setActiveView } = useAppStore()

  return (
    <nav className="sidebar">
      <ul className="sidebar-nav">
        <li>
          <span className="sidebar-section-label">Navigation</span>
        </li>
        {NAV_ITEMS.map(({ view, label, icon: Icon }) => (
          <li key={view}>
            <button
              className={clsx('sidebar-item', activeView === view && 'active')}
              onClick={() => setActiveView(view)}
              aria-current={activeView === view ? 'page' : undefined}
            >
              <Icon size={17} className="sidebar-item-icon" />
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        <span className="sidebar-version">v0.1.0-dev</span>
      </div>
    </nav>
  )
}
