import { Box, HardDrive, Package, ArrowRight } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type View } from '../store/appStore'

const MODULES = [
  {
    view: 'docker' as View,
    icon: Box,
    title: 'Docker & Containers',
    description: '3-level pruning engine, image browser, dry-run size estimates, and keep-list management.',
    tags: ['Prune', 'Images', 'Disk Usage', 'Keep-List'],
    color: 'accent',
  },
  {
    view: 'wsl' as View,
    icon: HardDrive,
    title: 'WSL2 Optimizer',
    description: 'Compact VHD files, manage distro config, and reclaim gigabytes with before/after deltas.',
    tags: ['Compact VHD', 'Distros', '.wslconfig'],
    color: 'success',
  },
  {
    view: 'packages' as View,
    icon: Package,
    title: 'Package Scanner',
    description: 'Scan 10+ package sources, flag outdated packages, and run upgrades with live output.',
    tags: ['winget', 'npm', 'pip', 'Cargo'],
    color: 'warning',
  },
] as const

export default function Dashboard() {
  const setActiveView = useAppStore(s => s.setActiveView)

  return (
    <div className="view-container">
      <div className="dashboard-header">
        <h1 className="dashboard-title">Workspace Atlas</h1>
        <p className="dashboard-subtitle">Your dev environment, mapped and managed.</p>
      </div>

      <div className="module-grid">
        {MODULES.map(({ view, icon: Icon, title, description, tags, color }) => (
          <button
            key={view}
            className={clsx('module-card', `module-card--${color}`)}
            onClick={() => setActiveView(view)}
          >
            <div className="module-card-header">
              <div className={clsx('module-icon', `module-icon--${color}`)}>
                <Icon size={22} />
              </div>
              <ArrowRight size={15} className="module-arrow" />
            </div>
            <h2 className="module-card-title">{title}</h2>
            <p className="module-card-desc">{description}</p>
            <div className="module-tags">
              {tags.map(tag => (
                <span key={tag} className="module-tag">{tag}</span>
              ))}
            </div>
          </button>
        ))}
      </div>

      <div className="dashboard-notice">
        <span className="notice-dot" />
        Fully offline — no telemetry, no cloud, no account required.
      </div>
    </div>
  )
}
