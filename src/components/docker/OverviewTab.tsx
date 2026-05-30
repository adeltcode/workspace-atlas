import { Box, Layers, Database, Hammer } from 'lucide-react'
import clsx from 'clsx'
import type { DockerSystemDf, DiskUsageRow } from '../../types/docker'

const CARDS: {
  key: keyof DockerSystemDf
  label: string
  icon: React.ElementType
  color: string
}[] = [
  { key: 'images',      label: 'Images',      icon: Layers,   color: 'accent'  },
  { key: 'containers',  label: 'Containers',  icon: Box,      color: 'success' },
  { key: 'volumes',     label: 'Volumes',     icon: Database, color: 'warning' },
  { key: 'build_cache', label: 'Build Cache', icon: Hammer,   color: 'danger'  },
]

function parseReclaimPercent(reclaimable: string): number {
  const m = reclaimable.match(/\((\d+)%\)/)
  return m ? Math.min(100, parseInt(m[1], 10)) : 0
}

function isZero(reclaimable: string) {
  return reclaimable.split(' (')[0].trim() === '0B'
}

function DfCard({
  row, label, icon: Icon, color,
}: {
  row: DiskUsageRow
  label: string
  icon: React.ElementType
  color: string
}) {
  const hasReclaimable = !isZero(row.reclaimable)
  const percent        = parseReclaimPercent(row.reclaimable)
  const reclaimSize    = row.reclaimable.split(' (')[0].trim()

  return (
    <div className={clsx('df-card', `df-card--${color}`)}>
      {/* Header row */}
      <div className="df-card-header">
        <div className={clsx('df-card-icon', `df-card-icon--${color}`)}>
          <Icon size={15} />
        </div>
        <span className="df-card-title">{label}</span>
        <span className="df-card-count-pill">
          {row.total}
          {row.active > 0 && (
            <span className="df-count-active"> · {row.active} active</span>
          )}
        </span>
      </div>

      {/* Hero: reclaimable — what the user cares about */}
      <div className="df-hero">
        <span className={clsx('df-hero-value', hasReclaimable ? `df-hero--${color}` : 'df-hero-zero')}>
          {reclaimSize}
        </span>
        <span className="df-hero-label">reclaimable</span>
      </div>

      {/* Progress bar */}
      <div className="df-bar-track">
        <div
          className={clsx('df-bar-fill', `df-bar-fill--${color}`)}
          style={{ width: hasReclaimable ? `${percent}%` : '0%' }}
        />
      </div>

      {/* Footer row */}
      <div className="df-bar-meta">
        <span className="df-bar-pct">
          {hasReclaimable ? `${percent}% of ` : ''}
        </span>
        <span className="df-bar-total">{row.size} total</span>
      </div>
    </div>
  )
}

export default function OverviewTab({
  df,
  loading,
}: {
  df: DockerSystemDf | null
  loading: boolean
}) {
  return (
    <>
      <p className="section-label">Disk Usage</p>

      {loading && (
        <div className="df-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="df-card df-card-skeleton" />
          ))}
        </div>
      )}

      {!loading && df && (
        <div className="df-grid">
          {CARDS.map(({ key, ...rest }) => (
            <DfCard key={key} row={df[key]} {...rest} />
          ))}
        </div>
      )}

      {!loading && !df && (
        <p className="empty-state">No disk usage data — is Docker running?</p>
      )}
    </>
  )
}
