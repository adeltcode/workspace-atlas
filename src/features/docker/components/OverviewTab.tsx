import clsx from 'clsx'
import type { DockerSystemDf, DockerContainer, DiskUsageRow } from '../types'

/**
 * Containers stopped for fewer than STALE_DAYS days are considered "active"
 * and excluded from the freeable estimate — they're likely still in use.
 */
const STALE_DAYS = 7

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
  // Only show the category accent color when there's actually something to reclaim.
  // If freeable = 0, render muted so "0 B" doesn't look like an alert.
  const hasFreeable = parseSizeBytes(reclaimSize) > 0
  const pctColor    = hasFreeable ? color : 'muted'

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
      <div className="bar-chart" title={percent > 0 ? `${percent}% of disk space is freeable` : 'Nothing reclaimable'}>
        <div className="bar-hatch" />
        <div
          className={clsx('bar-fill', `bar-fill--${color}`)}
          style={{ height: `${percent}%` }}
        />
      </div>

      {/* Footer — explicitly labelled so meaning is unambiguous */}
      <div className="bar-foot">
        <div>
          <div className={clsx('bar-pct', `bar-pct--${pctColor}`)}>{reclaimSize}</div>
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

/**
 * Overrides the containers row so that "reclaimable" only reflects containers
 * stopped for ≥ STALE_DAYS days, not every stopped container.
 *
 * We don't call `docker ps --size` (it scans every container's filesystem and
 * can take 10+ s). Instead we estimate proportionally:
 *   stale_reclaimable ≈ df_reclaimable × (stale_count / total_stopped_count)
 */
function buildContainersRow(
  dfRow: DiskUsageRow,
  containers: DockerContainer[],
): DiskUsageRow {
  const stopped = containers.filter(c => c.stopped_days >= 0)
  const stale   = containers.filter(c => c.stopped_days >= STALE_DAYS)

  if (stopped.length === 0 || stale.length === 0) {
    // Nothing stale — report zero freeable regardless of what docker system df says
    return { ...dfRow, reclaimable: `0B (0%)` }
  }

  const dfReclaimBytes = parseSizeBytes(parseReclaimSize(dfRow.reclaimable))
  const estimated      = Math.round(dfReclaimBytes * (stale.length / stopped.length))
  const totalBytes     = parseSizeBytes(dfRow.size)
  const pct            = totalBytes > 0 ? Math.round(estimated / totalBytes * 100) : 0

  return { ...dfRow, reclaimable: `${bytesToHuman(estimated)} (${pct}%)` }
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

export default function OverviewTab({
  df,
  containers,
  loading,
}: {
  df: DockerSystemDf | null
  containers: DockerContainer[]
  loading: boolean
}) {
  // Patch the containers row so freeable = stale-only estimate
  const patchedDf = df
    ? { ...df, containers: buildContainersRow(df.containers, containers) }
    : null

  const totalRow = patchedDf ? buildTotalRow(patchedDf) : null

  return (
    <div className="overview-tab">
      <div className="overview-header">
        <p className="section-label" style={{ margin: 0 }}>Disk Usage</p>
        <p className="overview-sub">
          Solid fill = freeable · hatched = in use · containers: stale ≥ {STALE_DAYS}d
        </p>
      </div>

      {loading && (
        <div className="bar-grid">
          {[0, 1, 2, 3, 4].map(i => <BarSkeleton key={i} />)}
        </div>
      )}

      {!loading && patchedDf && totalRow && (
        <div className="bar-grid">
          {CARDS.map(({ key, label, color }) => (
            <BarCard key={key} row={patchedDf[key]} label={label} color={color} />
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
