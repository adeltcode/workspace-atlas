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

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="sparkline-ph" />
  const max = Math.max(...values, 0.001)
  const W = 64, H = 28
  const pts = values.map((v, i) =>
    `${(i / (values.length - 1)) * W},${H - (v / max) * (H - 4) - 1}`
  ).join(' ')
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
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

  // ── Container stats — polled every 5 s while Overview tab is mounted ────────
  // Polling stops automatically when the component unmounts (tab switch).
  const [containerStats, setContainerStats] = useState<ContainerStats[]>([])
  const [statsLoading, setStatsLoading]     = useState(true)
  const [statsError, setStatsError]         = useState<string | null>(null)
  const [statHistory, setStatHistory]       = useState<Map<string, { cpu: number[]; mem: number[] }>>(() => new Map())
  const [resourceView, setResourceView]     = useState<'top' | 'all'>('top')
  const [lastPolledAt, setLastPolledAt]     = useState(0)
  const [pollSecTick, setPollSecTick]       = useState(0)

  const pollStats = useCallback(() => {
    if (!status?.available) { setStatsLoading(false); return }
    api.dockerStats()
      .then(snaps => {
        setContainerStats(snaps)
        setStatsError(null)
        setStatsLoading(false)
        setLastPolledAt(Date.now())
        setStatHistory(prev => {
          const next = new Map(prev)
          const active = new Set(snaps.map(s => s.name))
          for (const k of next.keys()) if (!active.has(k)) next.delete(k)
          snaps.forEach(s => {
            const h = next.get(s.name) ?? { cpu: [], mem: [] }
            next.set(s.name, {
              cpu: [...h.cpu.slice(-14), s.cpu_pct],
              mem: [...h.mem.slice(-14), s.mem_used_bytes],
            })
          })
          return next
        })
      })
      .catch(e => { setStatsError(String(e)); setStatsLoading(false) })
  }, [status?.available]) // eslint-disable-line

  // Reset history and restart interval on global refresh or availability change.
  useEffect(() => {
    if (!status?.available) { setStatsLoading(false); return }
    setStatsLoading(true)
    setStatsError(null)
    setStatHistory(new Map())
    pollStats()
    const id = setInterval(pollStats, 5000)
    return () => clearInterval(id)
  }, [refreshTick, status?.available]) // eslint-disable-line

  // Tick every second to keep the "Xs ago" freshness label current.
  useEffect(() => {
    if (!status?.available) return
    const id = setInterval(() => setPollSecTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [status?.available]) // eslint-disable-line

  // ── Disk stats — fetched separately for Docker's drive and the backup drive ──
  // Docker data on Windows Desktop lives on the system drive (C:).
  // Backups may be on a completely different drive (e.g. F:).
  const [dockerDiskStats, setDockerDiskStats] = useState<DiskStats | null>(null)
  const [backupDiskStats, setBackupDiskStats] = useState<DiskStats | null>(null)
  const [backupBytes,     setBackupBytes]     = useState(0)

  useEffect(() => {
    // Pass empty string → Rust falls back to %SYSTEMDRIVE% (the Docker drive on Windows)
    api.getDiskStats('').then(setDockerDiskStats).catch(() => setDockerDiskStats(null))
  }, [refreshTick]) // eslint-disable-line

  useEffect(() => {
    if (!backupDir) { setBackupDiskStats(null); return }
    api.getDiskStats(backupDir).then(setBackupDiskStats).catch(() => setBackupDiskStats(null))
  }, [refreshTick, backupDir]) // eslint-disable-line

  useEffect(() => {
    if (!backupDir) { setBackupBytes(0); return }
    api.getBackupSize(backupDir).then(setBackupBytes).catch(() => setBackupBytes(0))
  }, [refreshTick, backupDir]) // eslint-disable-line

  const topCpu = useMemo(() => [...containerStats].sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 3), [containerStats])
  const topMem = useMemo(() => [...containerStats].sort((a, b) => b.mem_used_bytes - a.mem_used_bytes).slice(0, 3), [containerStats])

  const secondsSincePoll = useMemo(
    () => lastPolledAt > 0 ? Math.floor((Date.now() - lastPolledAt) / 1000) : null,
    [lastPolledAt, pollSecTick], // eslint-disable-line
  )

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

            <button className="hero-tile hero-tile--clickable" onClick={() => setDockerTab('containers')} aria-label={`Containers: ${runningCtrs} running`}>
              <span className="hero-tile-label">Containers</span>
              <span className="hero-tile-value">{runningCtrs}</span>
              <span className="hero-tile-sub">running</span>
              {notRunning && <span className="hero-tile-sub">{notRunning}</span>}
            </button>

            <button className="hero-tile hero-tile--clickable" onClick={() => setDockerTab('images')} aria-label={`Images: ${images.length}`}>
              <span className="hero-tile-label">Images</span>
              <span className="hero-tile-value">{images.length}</span>
              <span className="hero-tile-sub">{df?.images.size ?? '—'}</span>
            </button>

            <button className="hero-tile hero-tile--clickable" onClick={() => setDockerTab('volumes')} aria-label={`Volumes: ${volumes.length}`}>
              <span className="hero-tile-label">Volumes</span>
              <span className="hero-tile-value">{volumes.length}</span>
              {unusedVols.length > 0
                ? <span className="hero-tile-sub">{unusedVols.length} unused</span>
                : <span className="hero-tile-sub">all in use</span>
              }
            </button>

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

      {/* ── Resource Monitoring (Top Offenders + Live Activity) ──────── */}
      <div className="overview-section" style={{ marginTop: 8 }}>
        <div className="overview-section-head overview-section-head--static">
          <span className="section-label" style={{ margin: 0 }}>Resource Monitoring</span>
          <div className="resource-tab-strip" style={{ marginLeft: 'auto' }}>
            <button
              className={clsx('resource-tab', resourceView === 'top' && 'resource-tab--active')}
              onClick={() => setResourceView('top')}
            >
              Top Offenders
            </button>
            <button
              className={clsx('resource-tab', resourceView === 'all' && 'resource-tab--active')}
              onClick={() => setResourceView('all')}
            >
              Live Activity
            </button>
          </div>
          {secondsSincePoll !== null && (
            <span className="overview-section-meta">{secondsSincePoll}s ago</span>
          )}
          <button
            className="stats-refresh-btn"
            onClick={pollStats}
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
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 46px', gap: 8, marginBottom: 10 }}>
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
        ) : resourceView === 'top' ? (
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
        ) : (
          <div style={{ padding: '10px 14px' }}>
            <div className="realtime-header">
              <span />
              <span className="realtime-col-label">CPU</span>
              <span />
              <span className="realtime-col-label">Memory</span>
              <span />
            </div>
            {[...containerStats].sort((a, b) => b.cpu_pct - a.cpu_pct).map(s => {
              const hist = statHistory.get(s.name)
              return (
                <div key={s.name} className="realtime-row">
                  <span className="stats-name" title={s.name}>{s.name}</span>
                  <Sparkline values={hist?.cpu ?? [s.cpu_pct]} color="var(--color-accent)" />
                  <span className="stats-value">{s.cpu_pct.toFixed(1)}%</span>
                  <Sparkline values={hist?.mem ?? [s.mem_used_bytes]} color="var(--color-warning)" />
                  <span className="stats-value">{bytesToHuman(s.mem_used_bytes)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Compose Stacks ───────────────────────────────────────────── */}
      <div className="overview-section" style={{ marginTop: 8 }}>
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

      {/* ── Disk usage ───────────────────────────────────────────────── */}
      {(() => {
        if (!patchedDf) return !loading ? (
          <div className="overview-empty">No disk data available. Is Docker running?</div>
        ) : null

        const imgBytes    = parseSizeBytes(patchedDf.images.size)
        const ctrBytes    = parseSizeBytes(patchedDf.containers.size)
        const volBytes    = parseSizeBytes(patchedDf.volumes.size)
        const bldBytes    = parseSizeBytes(patchedDf.build_cache.size)
        const dockerTotal = imgBytes + ctrBytes + volBytes + bldBytes

        const imgFree  = parseSizeBytes(parseReclaimSize(patchedDf.images.reclaimable))
        const ctrFree  = parseSizeBytes(parseReclaimSize(patchedDf.containers.reclaimable))
        const bldFree  = parseSizeBytes(parseReclaimSize(patchedDf.build_cache.reclaimable))
        const totalFreeableBytes = imgFree + ctrFree + bldFree

        const sameDrive = dockerDiskStats && backupDiskStats &&
          dockerDiskStats.drive_label === backupDiskStats.drive_label

        // Build segments for a single drive bar: known categories + Other + Free.
        // "Other" = drive used space not accounted for by the categories we track.
        type Seg = { key: string; label: string; bytes: number; color: string }
        const buildBar = (stats: DiskStats, cats: Seg[], extraBytes: number): Seg[] => {
          const driveUsed = stats.total_bytes - stats.free_bytes
          const tracked   = cats.reduce((s, c) => s + c.bytes, 0) + extraBytes
          const other     = Math.max(0, driveUsed - tracked)
          return [
            ...cats,
            ...(extraBytes > 0 ? [{ key: 'backups', label: 'Backups', bytes: extraBytes, color: 'backups' }] : []),
            ...(other > 0      ? [{ key: 'other',   label: 'Other apps', bytes: other,    color: 'other'   }] : []),
            { key: 'free', label: 'Free', bytes: stats.free_bytes, color: 'free' },
          ]
        }

        const dockerCats: Seg[] = [
          { key: 'images',     label: 'Images',      bytes: imgBytes, color: 'images' },
          { key: 'containers', label: 'Containers',  bytes: ctrBytes, color: 'containers' },
          { key: 'volumes',    label: 'Volumes',     bytes: volBytes, color: 'volumes' },
          { key: 'cache',      label: 'Build Cache', bytes: bldBytes, color: 'cache' },
        ].filter(s => s.bytes > 0)

        // Docker drive bar
        const dockerBarSegs = dockerDiskStats
          ? buildBar(dockerDiskStats, dockerCats, sameDrive ? backupBytes : 0)
          : dockerCats  // fallback: no drive stats, show categories only

        // Backup drive bar — only when backups are on a separate drive
        const backupBarSegs = !sameDrive && backupDiskStats && backupBytes > 0
          ? buildBar(backupDiskStats, [], backupBytes)
          : null

        const segPct = (bytes: number, driveTotal: number) =>
          driveTotal > 0 ? Math.max(bytes / driveTotal * 100, bytes > 0 ? 0.3 : 0) : 0

        // Legend rows — categories across all drives
        const legendRows: { key: string; label: string; bytes: number; color: string; freeBytes: number; driveNote?: string }[] = [
          { key: 'images',     label: 'Images',      bytes: imgBytes,    color: 'images',     freeBytes: imgFree },
          { key: 'containers', label: 'Containers',  bytes: ctrBytes,    color: 'containers', freeBytes: ctrFree },
          { key: 'volumes',    label: 'Volumes',     bytes: volBytes,    color: 'volumes',    freeBytes: 0 },
          { key: 'cache',      label: 'Build Cache', bytes: bldBytes,    color: 'cache',      freeBytes: bldFree },
          { key: 'backups',    label: 'Backups',     bytes: backupBytes, color: 'backups',    freeBytes: 0,
            driveNote: !sameDrive && backupDiskStats ? backupDiskStats.drive_label : undefined },
        ].filter(r => r.bytes > 0)

        return (
          <div className="overview-section">
            <div className="overview-section-head overview-section-head--static">
              <span className="section-label" style={{ margin: 0 }}>Disk Usage</span>
            </div>

            <div style={{ padding: '12px 14px 4px' }}>
              <div className="drive-bars-grid">

              {/* Docker drive bar */}
              <div className="drive-bar-group">
                <div className="drive-bar-header">
                  <span className="drive-bar-title">
                    {dockerDiskStats ? dockerDiskStats.drive_label : 'Docker'}
                  </span>
                  {dockerDiskStats && (
                    <span className="drive-bar-meta">
                      {bytesToHuman(dockerDiskStats.total_bytes)} disk size · {bytesToHuman(dockerDiskStats.free_bytes)} free
                    </span>
                  )}
                </div>
                <div className="disk-stacked-bar">
                  {dockerBarSegs.map(s => (
                    <div
                      key={s.key}
                      className={`disk-seg disk-seg--${s.color}`}
                      style={{ width: dockerDiskStats ? `${segPct(s.bytes, dockerDiskStats.total_bytes)}%` : 'auto', flex: dockerDiskStats ? undefined : s.bytes }}
                      title={`${s.label}: ${bytesToHuman(s.bytes)}`}
                    />
                  ))}
                </div>
              </div>

              {/* Backup drive bar — only rendered when backups are on a separate drive */}
              {backupBarSegs && backupDiskStats && (
                <div className="drive-bar-group">
                  <div className="drive-bar-header">
                    <span className="drive-bar-title">{backupDiskStats.drive_label}</span>
                    <span className="drive-bar-meta">
                      {bytesToHuman(backupDiskStats.total_bytes)} disk size · {bytesToHuman(backupDiskStats.free_bytes)} free
                    </span>
                  </div>
                  <div className="disk-stacked-bar">
                    {backupBarSegs.map(s => (
                      <div
                        key={s.key}
                        className={`disk-seg disk-seg--${s.color}`}
                        style={{ width: `${segPct(s.bytes, backupDiskStats.total_bytes)}%` }}
                        title={`${s.label}: ${bytesToHuman(s.bytes)}`}
                      />
                    ))}
                  </div>
                </div>
              )}

              </div>{/* end drive-bars-grid */}

              {/* Legend */}
              <div className="disk-legend">
                {legendRows.map(r => (
                  <div key={r.key} className="disk-legend-row">
                    <span className={`disk-legend-dot disk-seg--${r.color}`} />
                    <span className="disk-legend-label">
                      {r.label}
                      {r.driveNote && <span className="disk-legend-drive-note">{r.driveNote}</span>}
                    </span>
                    <span className="disk-legend-size">{bytesToHuman(r.bytes)}</span>
                    {r.freeBytes > 0 && (
                      <span className="disk-legend-free">{bytesToHuman(r.freeBytes)} freeable</span>
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
                <span className="disk-summary-note" title="docker system df — may not include Buildx cache on Docker Desktop for Windows">via docker system df</span>
              </div>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
