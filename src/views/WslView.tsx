import { HardDrive, Settings, FolderOpen, Download, Upload, Zap, AlertTriangle } from 'lucide-react'

const PLANNED = [
  {
    icon: Zap,
    label: 'VHD Compactor',
    desc: 'Compact all distro VHDs with before/after size delta',
  },
  {
    icon: Settings,
    label: '.wslconfig Editor',
    desc: 'View and edit memory, CPU, swap, and kernel settings',
  },
  {
    icon: FolderOpen,
    label: 'VHD Path Locator',
    desc: 'Auto-detect VHD paths via registry and open in Explorer',
  },
  {
    icon: Download,
    label: 'Distro Export',
    desc: 'Export any distro to a .tar archive for backup',
  },
  {
    icon: Upload,
    label: 'Distro Import',
    desc: 'Import distros from .tar archives',
  },
  {
    icon: AlertTriangle,
    label: 'WSL Shutdown Guard',
    desc: 'Warns if any distro is running before destructive operations',
  },
] as const

export default function WslView() {
  return (
    <div className="view-container">
      <div className="view-header">
        <div className="view-header-icon">
          <HardDrive size={20} />
        </div>
        <div>
          <h1 className="view-title">WSL2 Optimizer</h1>
          <p className="view-subtitle">Compact VHDs, manage distros, and reclaim disk space</p>
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
    </div>
  )
}
