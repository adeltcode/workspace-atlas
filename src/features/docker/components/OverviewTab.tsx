import clsx from 'clsx'
import type { DockerSystemDf, DiskUsageRow } from '../types'

const CARDS: { key: keyof DockerSystemDf; label: string; color: string }[] = [
  { key: 'images',      label: 'Images',      color: 'accent'  },
  { key: 'containers',  label: 'Containers',  color: 'success' },
  { key: 'volumes',     label: 'Volumes',     color: 'warning' },
  { key: 'build_cache', label: 'Build Cache', color: 'danger'  },
]

function parsePercent(reclaimable: string): number {
  const m = reclaimable.match(/\((\d+)%\)/)
  return m ? Math.min(100, parseInt(m[1], 10)) : 0
}

function parseReclaimSize(reclaimable: string): string {
  return reclaimable.split(' (')[0].trim()
}

/** Parse Docker size strings like "2.54GB", "187MB", "1.2kB", "0B" → bytes */
function parseSizeBytes(s: string): number {
  const n = parseFloat(s)
  if (s.endsWith('GB')) return n * 1e9
  if (s.endsWith('MB')) return n * 1e6
  if (s.endsWith('kB')) return n * 1e3
  return n
}

function bytesToHuman(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`
  return `${b} B`
}

function BarCard({
  row, label, color, totalLabel = false,
}: {
  row: DiskUsageRow; label: string; color: string; totalLabel?: boolean
}) {
  const percent     = parsePercent(row.reclaimable)
  const reclaimSize = parseReclaimSize(row.reclaimable)

  return (
    <div className="bar-card">
      {/* Header: active/total count + category name */}
      <div className="bar-top">
        {!totalLabel
          ? <span className="bar-ratio">{row.active} active / {row.total} total</span>
          : <span className="bar-ratio">all categories</span>
        }
        <span className="bar-name">{label}</span>
      </div>

      {/* Vertical bar — hatched bg = used space, solid fill = freeable portion */}
      <div className="bar-chart" title={`${percent}% of disk space is freeable`}>
        <div className="bar-hatch" />
        <div
          className={clsx('bar-fill', `bar-fill--${color}`)}
          style={{ height: `${percent}%` }}
        />
      </div>

      {/* Footer — explicitly labelled so meaning is unambiguous */}
      <div className="bar-foot">
        <div>
          <div className={clsx('bar-pct', `bar-pct--${color}`)}>{reclaimSize}</div>
          <div className="bar-foot-sub">freeable</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="bar-size">{row.size}</div>
          <div className="bar-foot-sub">total</div>
        </div>
      </div>
    </div>
  )
}

/** Derives a synthetic "Total" row by summing all 4 categories */
function buildTotalRow(df: DockerSystemDf): DiskUsageRow {
  const rows = [df.images, df.containers, df.volumes, df.build_cache]

  const totalBytes   = rows.reduce((s, r) => s + parseSizeBytes(r.size), 0)
  const reclaimBytes = rows.reduce((s, r) => s + parseSizeBytes(parseReclaimSize(r.reclaimable)), 0)
  const pct          = totalBytes > 0 ? Math.round(reclaimBytes / totalBytes * 100) : 0

  return {
    type:        'Total',
    total:       rows.reduce((s, r) => s + r.total, 0),
    active:      rows.reduce((s, r) => s + r.active, 0),
    size:        bytesToHuman(totalBytes),
    reclaimable: `${bytesToHuman(reclaimBytes)} (${pct}%)`,
  }
}

function BarSkeleton() {
  return (
    <div className="bar-card bar-card-skeleton">
      <div className="sk-line w-24" style={{ marginBottom: 2 }} />
      <div className="sk-line w-16" />
      <div className="sk-line" style={{ height: 90, width: '100%', borderRadius: 4 }} />
      <div className="sk-row space-between">
        <div className="sk-line w-12" />
        <div className="sk-line w-16" />
      </div>
    </div>
  )
}

export default function OverviewTab({ df, loading }: { df: DockerSystemDf | null; loading: boolean }) {
  const totalRow = df ? buildTotalRow(df) : null

  return (
    <div className="overview-tab">
      <div className="overview-header">
        <p className="section-label" style={{ margin: 0 }}>Disk Usage</p>
        <p className="overview-sub">Solid fill = freeable · hatched = in use</p>
      </div>

      {loading && (
        <div className="bar-grid">
          {[0, 1, 2, 3, 4].map(i => <BarSkeleton key={i} />)}
        </div>
      )}

      {!loading && df && totalRow && (
        <div className="bar-grid">
          {CARDS.map(({ key, label, color }) => (
            <BarCard key={key} row={df[key]} label={label} color={color} />
          ))}
          <BarCard row={totalRow} label="Total" color="total" totalLabel />
        </div>
      )}

      {!loading && !df && (
        <div className="overview-empty">No disk data available. Is Docker running?</div>
      )}
    </div>
  )
}
