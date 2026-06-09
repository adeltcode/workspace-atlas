import { useEffect, useState } from 'react'
import { Box, HardDrive, Package, Bot, ArrowRight, Cpu, MemoryStick } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type View } from '../store/appStore'
import { getSystemMetrics, type SystemMetrics } from '../features/system/api'
import { bytesToHuman } from '../utils/format'

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
  {
    view: 'automation' as View,
    icon: Bot,
    title: 'Automation',
    description: 'Schedule recurring tasks, set up event-driven triggers, and automate your dev workflows.',
    tags: ['Scheduling', 'Triggers', 'Webhooks', 'Git Hooks'],
    color: 'danger',
  },
] as const

/** A labelled usage bar (CPU, memory, or a disk). */
function MetricCard({ icon: Icon, label, pct, sub, color }: {
  icon: typeof Cpu; label: string; pct: number | null; sub?: string
  color: 'accent' | 'success' | 'warning'
}) {
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="sys-card">
      <div className="sys-card-head">
        <Icon size={13} className="sys-card-icon" />
        <span className="sys-card-label">{label}</span>
        <span className="sys-card-val">{pct === null ? '—' : `${Math.round(pct)}%`}</span>
      </div>
      <div className="sys-bar">
        <div className={clsx('sys-bar-fill', `sys-bar--${color}`)} style={{ width: `${width}%` }} />
      </div>
      {sub && <div className="sys-card-sub">{sub}</div>}
    </div>
  )
}

export default function Dashboard() {
  const setActiveView = useAppStore(s => s.setActiveView)
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)

  // Poll live system metrics every 2 s while the dashboard is mounted.
  // The effect cleans up on navigation away, so no polling runs off-screen.
  useEffect(() => {
    let active = true
    const poll = () => {
      getSystemMetrics().then(m => { if (active) setMetrics(m) }).catch(() => {})
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => { active = false; clearInterval(id) }
  }, [])

  const memPct = metrics && metrics.mem_total_bytes > 0
    ? (metrics.mem_used_bytes / metrics.mem_total_bytes) * 100
    : null

  return (
    <div className="view-container">
      <div className="dashboard-header">
        <h1 className="dashboard-title">Workspace Atlas</h1>
        <p className="dashboard-subtitle">Your dev environment, mapped and managed.</p>
      </div>

      <section className="sys-section">
        <p className="section-label">System</p>
        <div className="sys-metrics">
          <MetricCard
            icon={Cpu}
            label="CPU"
            pct={metrics ? metrics.cpu_pct : null}
            color="accent"
          />
          <MetricCard
            icon={MemoryStick}
            label="Memory"
            pct={memPct}
            sub={metrics ? `${bytesToHuman(metrics.mem_used_bytes)} / ${bytesToHuman(metrics.mem_total_bytes)}` : undefined}
            color="success"
          />
          {(metrics?.disks ?? []).map(d => {
            const used = d.total_bytes - d.free_bytes
            const pct  = d.total_bytes > 0 ? (used / d.total_bytes) * 100 : null
            return (
              <MetricCard
                key={d.mount}
                icon={HardDrive}
                label={d.mount.replace(/\\$/, '')}
                pct={pct}
                sub={`${bytesToHuman(d.free_bytes)} free of ${bytesToHuman(d.total_bytes)}`}
                color="warning"
              />
            )
          })}
        </div>
      </section>

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
