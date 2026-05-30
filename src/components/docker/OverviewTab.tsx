import { Box, Layers, Database, Hammer } from 'lucide-react'
import clsx from 'clsx'
import type { DockerSystemDf, DiskUsageRow } from '../../types/docker'

const CARDS: { key: keyof DockerSystemDf; label: string; icon: React.ElementType; color: string }[] = [
  { key: 'images',      label: 'Images',      icon: Layers,   color: 'accent'  },
  { key: 'containers',  label: 'Containers',  icon: Box,      color: 'success' },
  { key: 'volumes',     label: 'Volumes',     icon: Database, color: 'warning' },
  { key: 'build_cache', label: 'Build Cache', icon: Hammer,   color: 'danger'  },
]

function isZero(reclaimable: string) {
  return reclaimable.split(' (')[0].trim() === '0B'
}

function DfCard({ row, label, icon: Icon, color }: {
  row: DiskUsageRow; label: string; icon: React.ElementType; color: string
}) {
  const hasReclaimable = !isZero(row.reclaimable)
  return (
    <div className={clsx('df-card', `df-card--${color}`)}>
      <div className="df-card-header">
        <div className={clsx('df-card-icon', `df-card-icon--${color}`)}>
          <Icon size={17} />
        </div>
        <span className="df-card-title">{label}</span>
      </div>
      <div className="df-count-row">
        <span className="df-count-num">{row.total}</span>
        <span className="df-count-label">total</span>
        {row.active > 0 && (
          <>
            <span className="df-count-sep">·</span>
            <span className="df-count-num">{row.active}</span>
            <span className="df-count-label">active</span>
          </>
        )}
      </div>
      <div className="df-stat">
        <p className="df-stat-size">{row.size}</p>
        <p className="df-stat-label">total size</p>
      </div>
      <div className="df-stat">
        <p className={clsx('df-stat-size df-reclaimable', hasReclaimable && 'has-value')}>
          {row.reclaimable}
        </p>
        <p className="df-stat-label">reclaimable</p>
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
