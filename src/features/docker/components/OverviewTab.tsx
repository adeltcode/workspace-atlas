import { useState, useEffect, useCallback, useMemo } from 'react'
import { CheckCircle, AlertTriangle, ChevronRight, RefreshCw, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type { DockerStatus, DiskStats, DockerSystemDf, DockerContainer, DockerImage, DockerVolume, DiskUsageRow, ComposeProject, ContainerStats } from '../types'
import { bytesToHuman, composeStatusLabel } from '../../../utils/format'
import * as api from '../api'

/**
 * Containers stopped for fewer than STALE_DAYS days are considered "active"
 * and excluded from the freeable estimate — they're likely still in use.
 */
const STALE_DAYS = 7

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
  const { setDockerTab, setImagesFilter, setVolumesFilter, setComposePreselect, backupDir } = useAppStore()

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

  // ── Container stats (docker stats --no-stream; re-runs on tick or manual refresh) ──
  const [containerStats, setContainerStats] = useState<ContainerStats[]>([])
  const [statsLoading, setStatsLoading]     = useState(true)
  const [statsError, setStatsError]         = useState<string | null>(null)

  const loadStats = useCallback(() => {
    if (!status?.available) { setStatsLoading(false); return }
    setStatsLoading(true)
    setStatsError(null)
    api.dockerStats()
      .then(s => { setContainerStats(s); setStatsLoading(false) })
      .catch(e => { setStatsError(String(e)); setStatsLoading(false) })
  }, [status?.available]) // eslint-disable-line

  useEffect(() => { loadStats() }, [refreshTick, loadStats]) // eslint-disable-line

  // ── Disk stats (drive total/free) and backup size ─────────────────────────
  const [diskStats,   setDiskStats]   = useState<DiskStats | null>(null)
  const [backupBytes, setBackupBytes] = useState(0)

  useEffect(() => {
    const path = backupDir || 'C:\\'
    api.getDiskStats(path).then(setDiskStats).catch(() => setDiskStats(null))
  }, [refreshTick, backupDir]) // eslint-disable-line

  useEffect(() => {
    if (!backupDir) { setBackupBytes(0); return }
    api.getBackupSize(backupDir).then(setBackupBytes).catch(() => setBackupBytes(0))
  }, [refreshTick, backupDir]) // eslint-disable-line

  const topCpu = useMemo(() => [...containerStats].sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 3), [containerStats])
  const topMem = useMemo(() => [...containerStats].sort((a, b) => b.mem_used_bytes - a.mem_used_bytes).slice(0, 3), [containerStats])

  // ── Hero counts ───────────────────────────────────────────────────────────
  const runningCtrs = containers.filter(c => c.state === 'running').length
  const pausedCtrs  = containers.filter(c => c.state === 'paused').length
  const stoppedCtrs = containers.length - runningCtrs - pausedCtrs
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
  // Split unused images into two categories — they target different prune levels:
  //   trueDangling  = <none>:<none>  (untagged intermediates)  → Level 1
  //   unusedTagged  = named but unreferenced by any container  → Level 2
  const trueDangling  = images.filter(i => !i.in_use && i.repository === '<none>')
  const unusedTagged  = images.filter(i => !i.in_use && i.repository !== '<none>')
  const stale         = containers.filter(c => c.stopped_days >= STALE_DAYS)
  const unusedVols    = volumes.filter(v => !v.in_use)

  const trueDanglingBytes   = trueDangling.reduce((s, i) => s + i.size_bytes, 0)
  const unusedTaggedBytes   = unusedTagged.reduce((s, i) => s + i.size_bytes, 0)
  const staleContainerFree  = patchedDf ? parseReclaimSize(patchedDf.containers.reclaimable) : null
  const staleContainerBytes = staleContainerFree ? parseSizeBytes(staleContainerFree) : 0
  const unusedVolBytes      = unusedVols.reduce((s, v) => s + v.size_bytes, 0)
  const buildCacheFree      = df ? parseReclaimSize(df.build_cache.reclaimable) : null
  const buildCacheBytes     = buildCacheFree ? parseSizeBytes(buildCacheFree) : 0
  const showBuildCache      = buildCacheBytes > 0

  const totalFreeBytes = trueDanglingBytes + unusedTaggedBytes + staleContainerBytes + unusedVolBytes + buildCacheBytes

  const allClean = trueDangling.length === 0 && unusedTagged.length === 0 &&
                   stale.length === 0 && unusedVols.length === 0 && !showBuildCache
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

      {/* ── Resource Usage ───────────────────────────────────────────── */}
      <div className="overview-section">
        <div className="overview-section-head overview-section-head--static">
          <span className="section-label" style={{ margin: 0 }}>Resource Usage</span>
          <span className="overview-section-meta">top containers by CPU and memory</span>
          <button
            className="stats-refresh-btn"
            onClick={loadStats}
            disabled={statsLoading}
            title="Refresh stats"
          >
            <RefreshCw size={12} className={statsLoading ? 'spin' : ''} />
          </button>
        </div>

        {statsLoading ? (
          <div className="stats-grid">
            {[0, 1].map(col => (
              <div key={col} className="stats-col">
                <div className="sk-line w-12" style={{ height: 9, marginBottom: 10 }} />
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 44px', gap: 8, marginBottom: 10 }}>
                    <div className="sk-line" />
                    <div className="sk-line" style={{ height: 6, alignSelf: 'center' }} />
                    <div className="sk-line w-12" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : statsError ? (
          <p className="overview-empty-row" style={{ color: 'var(--color-danger)' }}>{statsError}</p>
        ) : containerStats.length === 0 ? (
          <p className="overview-empty-row">No running containers</p>
        ) : (
          <div className="stats-grid">
            <div className="stats-col">
              <div className="stats-col-label">CPU</div>
              {(() => {
                const maxCpu = topCpu[0]?.cpu_pct > 0 ? topCpu[0].cpu_pct : 1
                return topCpu.map(s => (
                  <div key={s.name} className="stats-row">
                    <span className="stats-name" title={s.name}>{s.name}</span>
                    <div className="stats-bar-wrap">
                      <div className="stats-bar stats-bar--cpu" style={{ width: `${(s.cpu_pct / maxCpu) * 100}%` }} />
                    </div>
                    <span className="stats-value">{s.cpu_pct.toFixed(1)}%</span>
                  </div>
                ))
              })()}
            </div>
            <div className="stats-col">
              <div className="stats-col-label">Memory</div>
              {(() => {
                const maxMem = topMem[0]?.mem_used_bytes > 0 ? topMem[0].mem_used_bytes : 1
                return topMem.map(s => (
                  <div key={s.name} className="stats-row">
                    <span className="stats-name" title={s.name}>{s.name}</span>
                    <div className="stats-bar-wrap">
                      <div className="stats-bar stats-bar--mem" style={{ width: `${(s.mem_used_bytes / maxMem) * 100}%` }} />
                    </div>
                    <span className="stats-value">{bytesToHuman(s.mem_used_bytes)}</span>
                  </div>
                ))
              })()}
            </div>
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
                  className="cleanup-row cleanup-row--compose"
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
              {trueDangling.length > 0 && (
                <CleanupRow
                  color="accent"
                  label="Dangling images"
                  count={trueDangling.length}
                  size={trueDanglingBytes > 0 ? bytesToHuman(trueDanglingBytes) : null}
                  onClick={() => { setImagesFilter('dangling'); setDockerTab('images') }}
                />
              )}
              {unusedTagged.length > 0 && (
                <CleanupRow
                  color="accent"
                  label="Unused tagged images"
                  count={unusedTagged.length}
                  size={unusedTaggedBytes > 0 ? bytesToHuman(unusedTaggedBytes) : null}
                  onClick={() => { setImagesFilter('unused-tagged'); setDockerTab('images') }}
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

            <button className="cleanup-cta-full" onClick={() => setDockerTab('prune')}>
              <span className="cleanup-cta-main">
                <Trash2 size={14} />
                Clean up ~{bytesToHuman(totalFreeBytes)} of space
              </span>
              <span className="cleanup-cta-sub">View breakdown and run safely in Prune tab</span>
            </button>
          </>
        )}
      </div>

      {/* ── Disk usage ───────────────────────────────────────────────── */}
      {(() => {
        if (!patchedDf) return !loading ? (
          <div className="overview-empty">No disk data available. Is Docker running?</div>
        ) : null

        const imgBytes = parseSizeBytes(patchedDf.images.size)
        const ctrBytes = parseSizeBytes(patchedDf.containers.size)
        const volBytes = parseSizeBytes(patchedDf.volumes.size)
        const bldBytes = parseSizeBytes(patchedDf.build_cache.size)
        const dockerTotal = imgBytes + ctrBytes + volBytes + bldBytes

        const imgFree  = parseSizeBytes(parseReclaimSize(patchedDf.images.reclaimable))
        const ctrFree  = parseSizeBytes(parseReclaimSize(patchedDf.containers.reclaimable))
        const bldFree  = parseSizeBytes(parseReclaimSize(patchedDf.build_cache.reclaimable))
        const totalFreeableBytes = imgFree + ctrFree + bldFree

        // Bar segments are proportional to drive total when available;
        // otherwise proportional to dockerTotal + backups.
        const barMax = diskStats ? diskStats.total_bytes : (dockerTotal + backupBytes || 1)
        const pct    = (b: number) => Math.max(b / barMax * 100, b > 0 ? 0.4 : 0)

        const SEGS = [
          { key: 'images',     bytes: imgBytes,    color: 'images',     label: 'Images',      freeBytes: imgFree },
          { key: 'containers', bytes: ctrBytes,    color: 'containers', label: 'Containers',  freeBytes: ctrFree },
          { key: 'volumes',    bytes: volBytes,    color: 'volumes',    label: 'Volumes',     freeBytes: 0 },
          { key: 'cache',      bytes: bldBytes,    color: 'cache',      label: 'Build Cache', freeBytes: bldFree },
          { key: 'backups',    bytes: backupBytes, color: 'backups',    label: 'Backups',     freeBytes: 0 },
        ].filter(s => s.bytes > 0)

        return (
          <div className="overview-section">
            <div className="overview-section-head overview-section-head--static">
              <span className="section-label" style={{ margin: 0 }}>Disk Usage</span>
              {diskStats && (
                <span className="overview-section-meta">
                  {diskStats.drive_label} — {bytesToHuman(diskStats.total_bytes)} total · {bytesToHuman(diskStats.free_bytes)} free
                </span>
              )}
            </div>

            <div style={{ padding: '14px 14px 4px' }}>
              {/* Stacked horizontal bar */}
              <div className="disk-stacked-bar">
                {SEGS.map(s => (
                  <div
                    key={s.key}
                    className={`disk-seg disk-seg--${s.color}`}
                    style={{ width: `${pct(s.bytes)}%` }}
                    title={`${s.label}: ${bytesToHuman(s.bytes)}`}
                  />
                ))}
              </div>

              {/* Legend */}
              <div className="disk-legend">
                {SEGS.map(s => (
                  <div key={s.key} className="disk-legend-row">
                    <span className={`disk-legend-dot disk-seg--${s.color}`} />
                    <span className="disk-legend-label">{s.label}</span>
                    <span className="disk-legend-size">{bytesToHuman(s.bytes)}</span>
                    {s.freeBytes > 0 && (
                      <span className="disk-legend-free">{bytesToHuman(s.freeBytes)} freeable</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Summary line */}
              <div className="disk-summary">
                <span>Docker: <strong>{bytesToHuman(dockerTotal)}</strong></span>
                {backupBytes > 0 && <span>Backups: <strong>{bytesToHuman(backupBytes)}</strong></span>}
                {totalFreeableBytes > 0 && (
                  <span className="disk-summary-free">{bytesToHuman(totalFreeableBytes)} freeable</span>
                )}
                <span className="disk-summary-note">containers: stale ≥ {STALE_DAYS}d</span>
              </div>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
