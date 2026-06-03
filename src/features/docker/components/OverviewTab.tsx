import { useState, useEffect } from 'react'
import { CheckCircle, AlertTriangle, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type { DockerStatus, DockerSystemDf, DockerContainer, DockerImage, DockerVolume, DiskUsageRow, ComposeProject } from '../types'
import { bytesToHuman } from '../../../utils/format'
import * as api from '../api'

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

// ── Compose status helpers ────────────────────────────────────────────────────

function composeStatusLabel(raw: string): { text: string; dot: 'running' | 'partial' | 'stopped' } {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(\w+)\((\d+)\)$/)
    return m ? { state: m[1], count: parseInt(m[2], 10) } : { state: part, count: 1 }
  })
  if (!parts.length) return { text: raw || 'unknown', dot: 'stopped' }
  const total   = parts.reduce((s, p) => s + p.count, 0)
  const running = parts.find(p => p.state === 'running')?.count ?? 0
  const text    = parts.map(p => `${p.count} ${p.state}`).join(', ')
  const dot     = running === 0 ? 'stopped' : running === total ? 'running' : 'partial'
  return { text, dot }
}

// ── Bar card ──────────────────────────────────────────────────────────────────

function BarCard({
  row, label, color, totalLabel = false,
}: {
  row: DiskUsageRow; label: string; color: string; totalLabel?: boolean
}) {
  const percent     = parsePercent(row.reclaimable)
  const reclaimSize = parseReclaimSize(row.reclaimable)
  const hasFreeable = parseSizeBytes(reclaimSize) > 0
  const pctColor    = hasFreeable ? color : 'muted'

  return (
    <div className="bar-card">
      <div className="bar-top">
        {!totalLabel
          ? <span className="bar-ratio">{row.active} active / {row.total} total</span>
          : <span className="bar-ratio">all categories</span>
        }
        <span className="bar-name">{label}</span>
      </div>

      <div className="bar-chart" title={percent > 0 ? `${percent}% of disk space is freeable` : 'Nothing reclaimable'}>
        <div className="bar-hatch" />
        <div
          className={clsx('bar-fill', `bar-fill--${color}`)}
          style={{ height: `${percent}%` }}
        />
      </div>

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

// ── Disk usage helpers ────────────────────────────────────────────────────────

/**
 * Overrides the containers row so that "reclaimable" only reflects containers
 * stopped for ≥ STALE_DAYS days, not every stopped container.
 */
function buildContainersRow(
  dfRow: DiskUsageRow,
  containers: DockerContainer[],
): DiskUsageRow {
  const stopped = containers.filter(c => c.stopped_days >= 0)
  const stale   = containers.filter(c => c.stopped_days >= STALE_DAYS)

  if (stopped.length === 0 || stale.length === 0) {
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

// ── Skeletons ─────────────────────────────────────────────────────────────────

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

function HeroSkeleton() {
  return (
    <div className="hero-grid">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className="hero-tile">
          <div className="sk-line w-16" style={{ height: 9 }} />
          <div className="sk-line w-20" style={{ height: 24, marginTop: 4 }} />
          <div className="sk-line w-24" style={{ height: 10, marginTop: 2 }} />
        </div>
      ))}
    </div>
  )
}

// ── Cleanup row ───────────────────────────────────────────────────────────────

function CleanupRow({
  color, label, count, size, sizeEst, onClick,
}: {
  color: string
  label: string
  count?: number
  size: string | null
  sizeEst?: boolean
  onClick: () => void
}) {
  return (
    <button className="cleanup-row" onClick={onClick}>
      <span className={clsx('cleanup-dot', `cleanup-dot--${color}`)} />
      <span className="cleanup-row-label">{label}</span>
      {count != null && <span className="cleanup-row-count">{count}</span>}
      <span className="cleanup-row-size">
        {size ?? '—'}
        {sizeEst && size && <span className="cleanup-row-size-note"> est.</span>}
      </span>
      <ChevronRight size={11} className="cleanup-row-arrow" />
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OverviewTab({
  df,
  containers,
  images,
  volumes,
  status,
  loading,
  refreshTick = 0,
}: {
  df: DockerSystemDf | null
  containers: DockerContainer[]
  images: DockerImage[]
  volumes: DockerVolume[]
  status: DockerStatus | null
  loading: boolean
  refreshTick?: number
}) {
  const setDockerTab       = useAppStore(s => s.setDockerTab)
  const setImagesFilter    = useAppStore(s => s.setImagesFilter)
  const setVolumesFilter   = useAppStore(s => s.setVolumesFilter)
  const setComposePreselect = useAppStore(s => s.setComposePreselect)

  // ── Compose projects (fetched independently; refreshes with global tick) ──
  const [composeProjects, setComposeProjects] = useState<ComposeProject[]>([])
  const [composeLoading, setComposeLoading]   = useState(true)

  useEffect(() => {
    if (!status?.available) { setComposeLoading(false); return }
    setComposeLoading(true)
    api.dockerComposeLs()
      .then(setComposeProjects)
      .catch(() => setComposeProjects([]))
      .finally(() => setComposeLoading(false))
  }, [refreshTick, status?.available]) // eslint-disable-line

  // ── Hero counts ───────────────────────────────────────────────────────────
  const runningCtrs = containers.filter(c => c.state === 'running').length
  const pausedCtrs  = containers.filter(c => c.state === 'paused').length
  const stoppedCtrs = containers.filter(c => c.state !== 'running' && c.state !== 'paused').length
  const restarting  = containers.filter(c => c.state === 'restarting')
  const dead        = containers.filter(c => c.state === 'dead')

  const notRunning = [
    pausedCtrs  > 0 && `${pausedCtrs} paused`,
    stoppedCtrs > 0 && `${stoppedCtrs} stopped`,
  ].filter(Boolean).join(' · ')

  // ── Disk totals ───────────────────────────────────────────────────────────
  const patchedDf = df ? { ...df, containers: buildContainersRow(df.containers, containers) } : null
  const totalRow  = patchedDf ? buildTotalRow(patchedDf) : null
  const totalFree = totalRow ? parseReclaimSize(totalRow.reclaimable) : null
  const hasFree   = totalFree != null && parseSizeBytes(totalFree) > 0

  // ── Cleanup data ──────────────────────────────────────────────────────────
  const dangling   = images.filter(i => !i.in_use)
  const stale      = containers.filter(c => c.stopped_days >= STALE_DAYS)
  const unusedVols = volumes.filter(v => !v.in_use)

  const danglingBytes       = dangling.reduce((s, i) => s + i.size_bytes, 0)
  const staleContainerFree  = patchedDf ? parseReclaimSize(patchedDf.containers.reclaimable) : null
  const staleContainerBytes = staleContainerFree ? parseSizeBytes(staleContainerFree) : 0
  const unusedVolBytes      = unusedVols.reduce((s, v) => s + v.size_bytes, 0)
  const buildCacheFree      = df ? parseReclaimSize(df.build_cache.reclaimable) : null
  const buildCacheBytes     = buildCacheFree ? parseSizeBytes(buildCacheFree) : 0
  const showBuildCache      = buildCacheBytes > 0

  const totalFreeBytes =
    (dangling.length > 0 ? danglingBytes : 0) +
    (stale.length > 0 ? staleContainerBytes : 0) +
    (unusedVols.length > 0 ? unusedVolBytes : 0) +
    (showBuildCache ? buildCacheBytes : 0)

  const allClean = dangling.length === 0 && stale.length === 0 && unusedVols.length === 0 && !showBuildCache
  const hasWarnings = !loading && (restarting.length > 0 || dead.length > 0)

  return (
    <div className="overview-tab">

      {/* ── Hero status strip ────────────────────────────────────────── */}
      <div className="overview-section">
        {loading ? <HeroSkeleton /> : (
          <div className="hero-grid">

            <div className="hero-tile">
              <span className="hero-tile-label">Engine</span>
              <span className={clsx('hero-tile-value hero-tile-value--text',
                status?.available ? 'hero-tile-value--ok' : 'hero-tile-value--err'
              )}>
                {status?.available ? 'Running' : 'Stopped'}
              </span>
              <span className="hero-tile-sub">
                {status?.available ? `v${status.version ?? '—'}` : (status?.error ?? '—')}
              </span>
            </div>

            <div className="hero-tile">
              <span className="hero-tile-label">Containers</span>
              <span className="hero-tile-value">{runningCtrs}</span>
              <span className="hero-tile-sub">running</span>
              {notRunning && <span className="hero-tile-sub">{notRunning}</span>}
            </div>

            <div className="hero-tile">
              <span className="hero-tile-label">Images</span>
              <span className="hero-tile-value">{images.length}</span>
              <span className="hero-tile-sub">{df?.images.size ?? '—'}</span>
            </div>

            <div className="hero-tile">
              <span className="hero-tile-label">Volumes</span>
              <span className="hero-tile-value">{volumes.length}</span>
              {unusedVols.length > 0
                ? <span className="hero-tile-sub">{unusedVols.length} unused</span>
                : <span className="hero-tile-sub">all in use</span>
              }
            </div>

            <div className="hero-tile">
              <span className="hero-tile-label">Total Disk</span>
              <span className="hero-tile-value">{totalRow?.size ?? '—'}</span>
              {hasFree && <span className="hero-tile-sub">{totalFree} freeable</span>}
            </div>

          </div>
        )}

        {hasWarnings && (
          <div className="hero-warnings">
            {restarting.length > 0 && (
              <button className="hero-warning-row hero-warning-row--critical" onClick={() => setDockerTab('containers')}>
                <AlertTriangle size={13} />
                {restarting.length} container{restarting.length !== 1 ? 's' : ''} in restart loop — view Containers
              </button>
            )}
            {dead.length > 0 && (
              <button className="hero-warning-row hero-warning-row--critical" onClick={() => setDockerTab('containers')}>
                <AlertTriangle size={13} />
                {dead.length} dead container{dead.length !== 1 ? 's' : ''} — view Containers
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Compose Stacks ───────────────────────────────────────────── */}
      <div className="overview-section">
        <button className="overview-section-head" onClick={() => setDockerTab('compose')}>
          <span className="section-label" style={{ margin: 0 }}>Compose Stacks</span>
          <span className="overview-section-meta">
            {composeLoading ? '…' : `${composeProjects.filter(p => composeStatusLabel(p.status).dot === 'running').length} running · ${composeProjects.length} total`}
          </span>
          <ChevronRight size={12} className="overview-section-arrow" />
        </button>

        {composeLoading ? (
          <div className="cleanup-rows">
            {[0, 1, 2].map(i => (
              <div key={i} className="cleanup-row cleanup-row--skeleton">
                <div className="sk-line" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }} />
                <div className="sk-line w-24" />
                <div className="sk-line w-32" style={{ marginLeft: 'auto' }} />
              </div>
            ))}
          </div>
        ) : composeProjects.length === 0 ? (
          <p className="overview-empty-row">No compose projects found</p>
        ) : (
          <div className="cleanup-rows">
            {composeProjects.map(p => {
              const { text, dot } = composeStatusLabel(p.status)
              return (
                <button
                  key={p.name}
                  className="cleanup-row"
                  onClick={() => { setComposePreselect(p.name); setDockerTab('compose') }}
                >
                  <span className={clsx('compose-status-dot', dot)} />
                  <span className="cleanup-row-label">{p.name}</span>
                  <span className="compose-stack-status">{text}</span>
                  <ChevronRight size={11} className="cleanup-row-arrow" />
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Cleanup Opportunities ────────────────────────────────────── */}
      <div className="overview-section">
        <div className="overview-section-head overview-section-head--static">
          <span className="section-label" style={{ margin: 0 }}>Cleanup Opportunities</span>
          {!loading && totalFreeBytes > 0 && (
            <span className="overview-section-meta">~{bytesToHuman(totalFreeBytes)} estimated freeable</span>
          )}
        </div>

        {loading ? (
          <div className="cleanup-rows">
            {[0, 1, 2].map(i => (
              <div key={i} className="cleanup-row cleanup-row--skeleton">
                <div className="sk-line" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }} />
                <div className="sk-line w-24" />
                <div className="sk-line w-12" style={{ marginLeft: 'auto' }} />
                <div className="sk-line w-16" />
              </div>
            ))}
          </div>
        ) : allClean ? (
          <div className="overview-attention">
            <div className="overview-chip overview-chip--clean">
              <CheckCircle size={12} />
              All resources clean
            </div>
          </div>
        ) : (
          <>
            <div className="cleanup-rows">
              {dangling.length > 0 && (
                <CleanupRow
                  color="accent"
                  label="Dangling images"
                  count={dangling.length}
                  size={danglingBytes > 0 ? bytesToHuman(danglingBytes) : null}
                  onClick={() => { setImagesFilter('dangling'); setDockerTab('images') }}
                />
              )}
              {stale.length > 0 && (
                <CleanupRow
                  color="success"
                  label={`Stale containers ≥${STALE_DAYS}d`}
                  count={stale.length}
                  size={staleContainerBytes > 0 ? bytesToHuman(staleContainerBytes) : null}
                  sizeEst
                  onClick={() => setDockerTab('prune')}
                />
              )}
              {unusedVols.length > 0 && (
                <CleanupRow
                  color="warning"
                  label="Unused volumes"
                  count={unusedVols.length}
                  size={unusedVolBytes > 0 ? bytesToHuman(unusedVolBytes) : null}
                  onClick={() => { setVolumesFilter('unused'); setDockerTab('volumes') }}
                />
              )}
              {showBuildCache && (
                <CleanupRow
                  color="danger"
                  label="Build cache"
                  size={buildCacheFree}
                  onClick={() => setDockerTab('prune')}
                />
              )}
            </div>

            <div className="cleanup-footer">
              <button className="cleanup-cta-btn" onClick={() => setDockerTab('prune')}>
                Open Prune tab
                <ChevronRight size={13} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Disk usage ───────────────────────────────────────────────── */}
      <div>
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

    </div>
  )
}
