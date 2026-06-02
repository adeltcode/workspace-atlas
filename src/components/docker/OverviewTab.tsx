import { Box, Layers, Database, Hammer } from 'lucide-react'
import clsx from 'clsx'
import type { DockerSystemDf, DiskUsageRow } from '../../types/docker'

const CARDS: {
  key: keyof DockerSystemDf
  label: string
  description: string
  icon: React.ElementType
  color: string
}[] = [
  {
    key: 'images',
    label: 'Images',
    description: 'Container images on disk',
    icon: Layers,
    color: 'accent',
  },
  {
    key: 'containers',
    label: 'Containers',
    description: 'Stopped & running containers',
    icon: Box,
    color: 'success',
  },
  {
    key: 'volumes',
    label: 'Volumes',
    description: 'Persistent data volumes',
    icon: Database,
    color: 'warning',
  },
  {
    key: 'build_cache',
    label: 'Build Cache',
    description: 'Layer & build artefacts',
    icon: Hammer,
    color: 'danger',
  },
]

function parsePercent(reclaimable: string): number {
  const m = reclaimable.match(/\((\d+)%\)/)
  return m ? Math.min(100, parseInt(m[1], 10)) : 0
}

function parseReclaimSize(reclaimable: string): string {
  return reclaimable.split(' (')[0].trim()
}

function isZeroSize(reclaimable: string): boolean {
  const size = parseReclaimSize(reclaimable)
  return size === '0B' || size === '0 B'
}

function BentoCard({
  row,
  label,
  description,
  icon: Icon,
  color,
}: {
  row: DiskUsageRow
  label: string
  description: string
  icon: React.ElementType
  color: string
}) {
  const hasReclaim  = !isZeroSize(row.reclaimable)
  const percent     = parsePercent(row.reclaimable)
  const reclaimSize = parseReclaimSize(row.reclaimable)

  return (
    <div className={clsx('bento-card', `bento-card--${color}`)}>
      {/* Header: icon chip + label + count pill */}
      <div className="bento-header">
        <div className={clsx('bento-icon-chip', `bento-chip--${color}`)}>
          <Icon size={16} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="bento-label">{label}</div>
          <div className="bento-desc">{description}</div>
        </div>
        <span className={clsx('bento-count-pill', `bento-pill--${color}`)}>
          {row.total}
        </span>
      </div>

      {/* Hero: reclaimable size */}
      <div className="bento-hero">
        <span className={clsx('bento-hero-value', hasReclaim ? `bento-value--${color}` : 'bento-value--zero')}>
          {reclaimSize}
        </span>
        <span className="bento-hero-label">reclaimable</span>
      </div>

      {/* Progress bar */}
      <div className="bento-bar-wrap">
        <div className="bento-bar">
          <div
            className={clsx('bento-bar-fill', `bento-fill--${color}`)}
            style={{ width: hasReclaim ? `${percent}%` : '0%' }}
          />
        </div>
        <span className="bento-bar-pct">{hasReclaim ? `${percent}%` : '—'}</span>
      </div>

      {/* Footer */}
      <div className="bento-footer">
        <span className="bento-footer-size">
          <span className="bento-footer-num">{row.size}</span>
          <span className="bento-footer-sub"> on disk</span>
        </span>
        {row.active > 0 && (
          <span className={clsx('bento-active-badge', `bento-active--${color}`)}>
            {row.active} active
          </span>
        )}
      </div>
    </div>
  )
}

function BentoSkeleton() {
  return (
    <div className="bento-card bento-skeleton">
      <div className="sk-row">
        <div className="sk-box" />
        <div className="sk-col">
          <div className="sk-line w-20" />
          <div className="sk-line w-32 short" />
        </div>
        <div className="sk-line w-12" style={{ height: 24, borderRadius: 20 }} />
      </div>
      <div className="sk-line tall" />
      <div className="sk-line w-full" style={{ height: 5 }} />
      <div className="sk-row space-between">
        <div className="sk-line w-20" />
        <div className="sk-line w-16" />
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
    <div className="overview-tab">
      <div className="overview-header">
        <p className="section-label" style={{ margin: 0 }}>Docker Disk Usage</p>
        <p className="overview-sub">Click Prune tab to reclaim space</p>
      </div>

      {loading && (
        <div className="bento-grid">
          {[0, 1, 2, 3].map((i) => <BentoSkeleton key={i} />)}
        </div>
      )}

      {!loading && df && (
        <div className="bento-grid">
          {CARDS.map(({ key, ...rest }) => (
            <BentoCard key={key} row={df[key]} {...rest} />
          ))}
        </div>
      )}

      {!loading && !df && (
        <div className="overview-empty">
          <p>No disk data available. Is Docker running?</p>
        </div>
      )}
    </div>
  )
}
