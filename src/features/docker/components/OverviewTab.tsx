import { useState, useEffect, useMemo, useRef } from 'react'
import { CheckCircle, AlertTriangle, ChevronRight, ChevronDown, RefreshCw, Trash2 } from 'lucide-react'
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

// ── Live Charts ───────────────────────────────────────────────────────────────

function getChartColors(): string[] {
  const style = getComputedStyle(document.documentElement)
  return Array.from({ length: 8 }, (_, i) =>
    style.getPropertyValue(`--chart-${i + 1}`).trim()
  )
}

interface LiveSeries {
  name:  string
  color: string
  cpu:   number[]
  mem:   number[]
}

function padLeft(arr: number[], n: number): number[] {
  if (arr.length >= n) return arr.slice(-n)
  return [...Array(n - arr.length).fill(0), ...arr]
}

// Chart layout constants
const CH = 148    // chart SVG height (px)
const YT = 8      // top padding
const YB = 22     // bottom padding (x-axis labels)
const XL = 44     // left padding (y-axis labels)
const XR = 8      // right padding

function ChartPanel({
  type, series, numPoints, hidden, hoverIdx, maxMem, onHover, onLeave,
}: {
  type:      'cpu' | 'mem'
  series:    LiveSeries[]
  numPoints: number
  hidden:    Set<string>
  hoverIdx:  number | null
  maxMem:    number
  onHover:   (idx: number) => void
  onLeave:   () => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [svgW, setSvgW] = useState(300)

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSvgW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const innerW = svgW - XL - XR
  const innerH = CH - YT - YB

  const xAt = (i: number) =>
    XL + (numPoints <= 1 ? innerW / 2 : (i / (numPoints - 1)) * innerW)

  const yFor = (v: number) => {
    const scale = type === 'cpu' ? 100 : maxMem
    return YT + (1 - Math.min(v, scale) / (scale || 1)) * innerH
  }

  const ticks = type === 'cpu'
    ? [0, 25, 50, 75, 100]
    : (() => {
        const step = maxMem / 4
        return [0, step, step * 2, step * 3, maxMem]
      })()

  const tickLabel = (v: number) =>
    type === 'cpu' ? `${Math.round(v)}%` : bytesToHuman(v)

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = Math.round((e.clientX - rect.left - XL) / innerW * (numPoints - 1))
    onHover(Math.max(0, Math.min(numPoints - 1, raw)))
  }

  const visible = series.filter(s => !hidden.has(s.name))
  const timeLabels = Array.from(new Set([0, Math.floor((numPoints - 1) / 2), numPoints - 1]))

  return (
    <div className="live-chart-wrap">
      <div className="live-chart-title">{type === 'cpu' ? 'CPU %' : 'Memory'}</div>
      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          className="live-chart-svg"
          height={CH}
          width="100%"
          onMouseMove={handleMove}
          onMouseLeave={onLeave}
        >
          {/* Grid lines + Y-axis */}
          {ticks.map(v => {
            const y = yFor(v)
            return (
              <g key={v}>
                <line x1={XL} y1={y} x2={svgW - XR} y2={y}
                  stroke="var(--color-border-light)"
                  strokeWidth={v === 0 ? 1 : 0.5} />
                <text x={XL - 5} y={y} fontSize={9}
                  fill="var(--color-text-tertiary)" textAnchor="end"
                  dominantBaseline="middle" fontFamily="inherit">
                  {tickLabel(v)}
                </text>
              </g>
            )
          })}

          {/* Series lines */}
          {visible.map(s => {
            const vals = padLeft(type === 'cpu' ? s.cpu : s.mem, numPoints)
            const pts  = vals.map((v, i) => ({ x: xAt(i), y: yFor(v) }))
            const line = pts.map(p => `${p.x},${p.y}`).join(' ')
            const area = [
              ...pts,
              { x: xAt(numPoints - 1), y: YT + innerH },
              { x: xAt(0), y: YT + innerH },
            ].map(p => `${p.x},${p.y}`).join(' ')
            const gid  = `lcg-${type}-${s.name.replace(/\W/g, '_')}`
            const last = pts[pts.length - 1]
            return (
              <g key={s.name}>
                <defs>
                  <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={s.color} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <polygon points={area} fill={`url(#${gid})`} />
                <polyline points={line} fill="none" stroke={s.color}
                  strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                {hoverIdx === null && (
                  <circle cx={last.x} cy={last.y} r={3} fill={s.color} />
                )}
              </g>
            )
          })}

          {/* Crosshair + intersection dots */}
          {hoverIdx !== null && (
            <>
              <line
                x1={xAt(hoverIdx)} y1={YT}
                x2={xAt(hoverIdx)} y2={YT + innerH}
                stroke="var(--color-text-secondary)"
                strokeWidth={1} strokeDasharray="3 3"
              />
              {visible.map(s => {
                const vals = padLeft(type === 'cpu' ? s.cpu : s.mem, numPoints)
                return (
                  <circle key={s.name}
                    cx={xAt(hoverIdx)} cy={yFor(vals[hoverIdx])}
                    r={4} fill={s.color}
                    stroke="var(--color-bg-secondary)" strokeWidth={1.5}
                  />
                )
              })}
            </>
          )}

          {/* X-axis time labels */}
          {timeLabels.map(i => {
            const sAgo = (numPoints - 1 - i) * 5
            return (
              <text key={i} x={xAt(i)} y={CH - 5} fontSize={9}
                fill="var(--color-text-tertiary)" textAnchor="middle"
                fontFamily="inherit">
                {sAgo === 0 ? 'now' : `-${sAgo}s`}
              </text>
            )
          })}
        </svg>

        {/* Hover tooltip */}
        {hoverIdx !== null && (() => {
          const x     = xAt(hoverIdx)
          const left  = x > svgW / 2 ? x - 144 : x + 12
          const sAgo  = (numPoints - 1 - hoverIdx) * 5
          const items = visible
            .map(s => {
              const vals = padLeft(type === 'cpu' ? s.cpu : s.mem, numPoints)
              return { name: s.name, color: s.color, v: vals[hoverIdx] }
            })
            .sort((a, b) => b.v - a.v)
          return (
            <div className="live-chart-tooltip" style={{ left, top: YT + 4 }}>
              {items.map(it => (
                <div key={it.name} className="live-chart-tooltip-row">
                  <span className="live-chart-tooltip-dot" style={{ background: it.color }} />
                  <span className="live-chart-tooltip-name" title={it.name}>{it.name}</span>
                  <span className="live-chart-tooltip-val">
                    {type === 'cpu' ? `${it.v.toFixed(1)}%` : bytesToHuman(it.v)}
                  </span>
                </div>
              ))}
              <div className="live-chart-tooltip-time">
                {sAgo === 0 ? 'current' : `${sAgo}s ago`}
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

function LiveCharts({
  containerStats, statHistory,
}: {
  containerStats: ContainerStats[]
  statHistory:    Map<string, { cpu: number[]; mem: number[] }>
}) {
  const theme = useAppStore(s => s.theme)
  const [hidden,   setHidden]   = useState<Set<string>>(() => new Set())
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const sorted = useMemo(
    () => [...containerStats].sort((a, b) => b.cpu_pct - a.cpu_pct),
    [containerStats],
  )

  const series: LiveSeries[] = useMemo(
    () => {
      const colors = getChartColors()
      return sorted.map((s, i) => ({
        name:  s.name,
        color: colors[i % colors.length],
        cpu:   statHistory.get(s.name)?.cpu?.length ? statHistory.get(s.name)!.cpu : [s.cpu_pct],
        mem:   statHistory.get(s.name)?.mem?.length ? statHistory.get(s.name)!.mem : [s.mem_used_bytes],
      }))
    },
    [sorted, statHistory, theme], // eslint-disable-line — theme invalidates chart colors on toggle
  )

  const numPoints = useMemo(
    () => Math.max(2, ...series.map(s => Math.max(s.cpu.length, s.mem.length))),
    [series],
  )

  const maxMem = useMemo(() => {
    let m = 1024 * 1024
    series.forEach(s => { if (!hidden.has(s.name)) m = Math.max(m, ...s.mem) })
    return m * 1.15
  }, [series, hidden])

  function toggleHide(name: string) {
    setHidden(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const shared = { series, numPoints, hidden, hoverIdx, maxMem,
    onHover: setHoverIdx, onLeave: () => setHoverIdx(null) }

  return (
    <div className="live-charts">
      <div className="live-charts-grid">
        <ChartPanel type="cpu" {...shared} />
        <ChartPanel type="mem" {...shared} />
      </div>
      <div className="live-chart-legend">
        {series.map(s => (
          <button
            key={s.name}
            className={clsx('live-chart-legend-btn', hidden.has(s.name) && 'live-chart-legend-btn--off')}
            onClick={() => toggleHide(s.name)}
          >
            <span className="live-chart-legend-dot"
              style={{ background: hidden.has(s.name) ? 'transparent' : s.color, borderColor: s.color }} />
            <span className="live-chart-legend-name">{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Cleanup row ───────────────────────────────────────────────────────────────

type CleanupItem = { id: string; label: string; sublabel?: string; size?: string | null }

function CleanupRow({
  color, label, count, size, sizeEst, onNavigate, items, onRemoveSelected,
}: {
  color:             string
  label:             string
  count?:            number
  size:              string | null
  sizeEst?:          boolean
  onNavigate:        () => void
  items?:            CleanupItem[]
  onRemoveSelected?: (ids: string[]) => Promise<void>
}) {
  const [expanded,  setExpanded]  = useState(false)
  const [selected,  setSelected]  = useState<Set<string>>(new Set())
  const [removing,  setRemoving]  = useState(false)
  const [removeErr, setRemoveErr] = useState<string | null>(null)

  const expandable = items != null && onRemoveSelected != null

  function handleHeaderClick() {
    if (expandable) { setExpanded(e => !e); setRemoveErr(null) }
    else onNavigate()
  }

  function toggleItem(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function toggleAll() {
    setSelected(prev => prev.size === items!.length ? new Set() : new Set(items!.map(i => i.id)))
  }

  async function handleRemove() {
    if (!onRemoveSelected || selected.size === 0) return
    setRemoving(true); setRemoveErr(null)
    try {
      await onRemoveSelected([...selected])
      setExpanded(false); setSelected(new Set())
    } catch (e) {
      setRemoveErr(String(e))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className={clsx('cleanup-row-wrap', expanded && 'cleanup-row-wrap--open')}>
      <button className="cleanup-row" onClick={handleHeaderClick}>
        <span className={clsx('cleanup-dot', `cleanup-dot--${color}`)} />
        <span className="cleanup-row-label">{label}</span>
        {count != null && <span className="cleanup-row-count">{count}</span>}
        <span className="cleanup-row-size">
          {size ?? '—'}
          {sizeEst && size && <span className="cleanup-row-size-note"> est.</span>}
        </span>
        {expandable
          ? <ChevronDown size={11} className={clsx('cleanup-row-arrow', expanded && 'cleanup-row-arrow--open')} />
          : <ChevronRight size={11} className="cleanup-row-arrow" />
        }
      </button>

      {expandable && expanded && (
        <div className="cleanup-expand">
          <label className="cleanup-expand-all">
            <input type="checkbox"
              checked={items.length > 0 && selected.size === items.length}
              onChange={toggleAll}
            />
            <span>Select all ({items.length})</span>
          </label>
          <div className="cleanup-expand-list">
            {items.map(item => (
              <label key={item.id} className="cleanup-expand-item">
                <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleItem(item.id)} />
                <span className="cleanup-expand-item-label">{item.label}</span>
                {item.sublabel && <span className="cleanup-expand-item-sub">{item.sublabel}</span>}
                {item.size    && <span className="cleanup-expand-item-size">{item.size}</span>}
              </label>
            ))}
          </div>
          {removeErr && <div className="cleanup-expand-error">{removeErr}</div>}
          <div className="cleanup-expand-actions">
            <button
              className="btn-execute btn-execute--danger btn-sm"
              disabled={selected.size === 0 || removing}
              onClick={handleRemove}
            >
              <Trash2 size={11} />
              {removing ? 'Removing…' : `Remove${selected.size > 0 ? ` ${selected.size}` : ''}`}
            </button>
            <button className="btn-reset btn-sm" onClick={onNavigate}>View in tab</button>
          </div>
        </div>
      )}
    </div>
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
  onRefresh,
  containerStats,
  statsLoading,
  statsError,
  statHistory,
  onPollStats,
}: {
  df: DockerSystemDf | null
  containers: DockerContainer[]
  images: DockerImage[]
  volumes: DockerVolume[]
  status: DockerStatus | null
  loading: boolean
  refreshTick?: number
  onRefresh?: () => void
  containerStats: ContainerStats[]
  statsLoading: boolean
  statsError: string | null
  statHistory: Map<string, { cpu: number[]; mem: number[] }>
  onPollStats: () => void
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

  const [resourceView, setResourceView] = useState<'top' | 'all'>('top')

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
          {!loading && totalFreeBytes > 0 && (
            <button className="overview-prune-btn" onClick={() => setDockerTab('prune')}>
              <Trash2 size={11} />
              Prune all
            </button>
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
                  onNavigate={() => { setImagesFilter('dangling'); setDockerTab('images') }}
                  items={trueDangling.map(i => ({
                    id:       i.id,
                    label:    i.id.replace('sha256:', '').slice(0, 12),
                    sublabel: i.created_since,
                    size:     i.size,
                  }))}
                  onRemoveSelected={async ids => { await api.dockerPruneRun(2, ids); onRefresh?.() }}
                />
              )}
              {unusedTagged.length > 0 && (
                <CleanupRow
                  color="accent"
                  label="Unused tagged images"
                  count={unusedTagged.length}
                  size={unusedTaggedBytes > 0 ? bytesToHuman(unusedTaggedBytes) : null}
                  onNavigate={() => { setImagesFilter('unused-tagged'); setDockerTab('images') }}
                  items={unusedTagged.map(i => ({
                    id:       i.id,
                    label:    `${i.repository}:${i.tag}`,
                    sublabel: i.created_since,
                    size:     i.size,
                  }))}
                  onRemoveSelected={async ids => { await api.dockerPruneRun(2, ids); onRefresh?.() }}
                />
              )}
              {stale.length > 0 && (
                <CleanupRow
                  color="success"
                  label={`Stale containers ≥${STALE_DAYS}d`}
                  count={stale.length}
                  size={staleContainerBytes > 0 ? bytesToHuman(staleContainerBytes) : null}
                  sizeEst
                  onNavigate={() => setDockerTab('prune')}
                  items={stale.map(c => ({
                    id:       c.id,
                    label:    c.name,
                    sublabel: c.status,
                  }))}
                  onRemoveSelected={async ids => {
                    try { for (const id of ids) await api.dockerContainerAction(id, 'remove') }
                    finally { onRefresh?.() }
                  }}
                />
              )}
              {unusedVols.length > 0 && (
                <CleanupRow
                  color="warning"
                  label="Unused volumes"
                  count={unusedVols.length}
                  size={unusedVolBytes > 0 ? bytesToHuman(unusedVolBytes) : null}
                  onNavigate={() => { setVolumesFilter('unused'); setDockerTab('volumes') }}
                  items={unusedVols.map(v => ({
                    id:       v.name,
                    label:    v.name,
                    sublabel: v.compose_project ?? undefined,
                    size:     v.size_bytes > 0 ? bytesToHuman(v.size_bytes) : null,
                  }))}
                  onRemoveSelected={async ids => {
                    try { for (const id of ids) await api.dockerVolumeRemove(id) }
                    finally { onRefresh?.() }
                  }}
                />
              )}
              {showBuildCache && (
                <CleanupRow
                  color="danger"
                  label="Build cache"
                  size={buildCacheFree}
                  onNavigate={() => setDockerTab('prune')}
                />
              )}
            </div>
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
          <button
            className="stats-refresh-btn"
            onClick={onPollStats}
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
          <LiveCharts containerStats={containerStats} statHistory={statHistory} />
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

            <div className="disk-body">
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
