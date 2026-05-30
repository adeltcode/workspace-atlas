import { Package, Search, RefreshCw, FileDown } from 'lucide-react'

const PLANNED = [
  {
    icon: Search,
    label: 'Global Search',
    desc: 'Search across all 10+ package sources simultaneously',
  },
  {
    icon: RefreshCw,
    label: 'Outdated Flagging',
    desc: 'Green/amber/red freshness indicators with version diff',
  },
  {
    icon: Package,
    label: 'Integrated Upgrade Runner',
    desc: 'Live CLI output, per-source or batch upgrade',
  },
  {
    icon: FileDown,
    label: 'CSV Export',
    desc: 'Export full package inventory across all sources',
  },
] as const

const SOURCES = [
  'winget', 'Chocolatey', 'Scoop', 'pip / pip3', 'npm globals',
  'PowerShell modules', 'VS Code extensions', 'Cargo binaries',
  'NuGet globals', 'Registry uninstall keys',
]

export default function PackagesView() {
  return (
    <div className="view-container">
      <div className="view-header">
        <div className="view-header-icon">
          <Package size={20} />
        </div>
        <div>
          <h1 className="view-title">Package Scanner</h1>
          <p className="view-subtitle">Inventory and update packages across your entire dev stack</p>
        </div>
      </div>

      <div className="build-badge">Module in development</div>

      <div className="coming-soon-grid">
        {PLANNED.map(({ icon: Icon, label, desc }) => (
          <div key={label} className="coming-soon-card">
            <Icon size={18} className="coming-soon-icon" />
            <div>
              <p className="coming-soon-label">{label}</p>
              <p className="coming-soon-desc">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="sources-list">
        <p className="sources-label">Scanned sources</p>
        <div className="sources-chips">
          {SOURCES.map(s => (
            <span key={s} className="source-chip">{s}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
