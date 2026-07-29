import { useState, useEffect, useMemo } from 'react'
import {
  CheckCircle, AlertTriangle, ChevronRight, ChevronDown, RefreshCw, Trash2,
} from 'lucide-react'
import LiveMetricsCharts from '../../../components/LiveMetricsCharts'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type {
  DockerStatus, DiskStats, DockerSystemDf, DockerContainer, DockerImage,
  DockerVolume, DiskUsageRow, ComposeProject, ContainerStats,
} from '../types'
import { bytesToHuman, composeStatusLabel } from '../../../utils/format'
import {
  SectionHead, Panel, StatCard, StatRow, Button, Segmented, SegmentedItem, EmptyState,
} from '../../../components/ui'
import * as api from '../api'

const STALE_DAYS = 7

function parseReclaimSize(reclaimable: string): string {
  return reclaimable.split(' (')[0].trim()
}

function parseSizeBytes(s: string): number {
  const n = parseFloat(s)
  if (s.endsWith('GB')) return n * 1e9
  if (s.endsWith('MB')) return n * 1e6
  if (s.endsWith('kB')) return n * 1e3
  return n
}

function buildContainersRow(dfRow: DiskUsageRow, containers: DockerContainer[]): DiskUsageRow {
  const stopped = containers.filter(c => c.stopped_days >= 0)
  const stale   = containers.filter(c => c.stopped_days >= STALE_DAYS)
  if (stopped.length === 0 || stale.length === 0) return { ...dfRow, reclaimable: `0B (0%)` }
  const dfReclaimBytes = parseSizeBytes(parseReclaimSize(dfRow.reclaimable))
  const estimated      = Math.round(dfReclaimBytes * (stale.length / stopped.length))
  const totalBytes     = parseSizeBytes(dfRow.size)
  const pct            = totalBytes > 0 ? Math.round(estimated / totalBytes * 100) : 0
  return { ...dfRow, reclaimable: `${bytesToHuman(estimated)} (${pct}%)` }
}

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

// ── New helpers ───────────────────────────────────────────────────────────────

function projectContainerNames(projectName: string, containers: DockerContainer[], allProjectNames: string[]): string[] {
  const p1 = `${projectName}-`, p2 = `${projectName}_`
  return containers
    .filter(c => {
      if (!c.name.startsWith(p1) && !c.name.startsWith(p2)) return false
      // Exclude containers that belong to a longer-named sibling project
      // e.g. container "web-debug-db-1" matches prefix "web-" but actually belongs to "web-debug"
      return !allProjectNames.some(
        other => other !== projectName &&
          other.length > projectName.length &&
          (c.name.startsWith(`${other}-`) || c.name.startsWith(`${other}_`))
      )
    })
    .map(c => c.name)
}

function sumProjectStat(names: string[], stats: ContainerStats[], get: (s: ContainerStats) => number): number {
  return stats.filter(s => names.includes(s.name)).reduce((sum, s) => sum + get(s), 0)
}

function extractHostPort(mapping: string): string {
  // Published port: "0.0.0.0:8080->80/tcp" | "[::]:8080->80/tcp" → "8080"
  const published = mapping.match(/:(\d+)->/)
  if (published) return published[1]
  // Exposed-only port: "80/tcp" → "80"
  const exposed = mapping.match(/^(\d+)\//)
  return exposed ? exposed[1] : ''
}

// ── Skeletons ─────────────────────────────────────────────────────────────────

function HeroSkeleton() {
  return (
    <StatRow>
      {[0, 1, 2].map(i => (
        <div key={i} className="stat">
          <div className="sk-line w-16" style={{ height: 9 }} />
          <div className="sk-line w-20" style={{ height: 22, marginTop: 4 }} />
          <div className="sk-line w-24" style={{ height: 10, marginTop: 4 }} />
        </div>
      ))}
    </StatRow>
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
          {size ?? '-'}
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
              className="btn-filled btn-filled--danger btn-sm"
              disabled={selected.size === 0 || removing}
              onClick={handleRemove}
            >
              <Trash2 size={11} />
              {removing ? 'Removing…' : `Remove${selected.size > 0 ? ` ${selected.size}` : ''}`}
            </button>
            <button className="btn-ghost btn-sm" onClick={onNavigate}>View in tab</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Project Card ──────────────────────────────────────────────────────────────

function ProjectCard({
  project, containers, containerStats, allProjectNames, onOpen,
}: {
  project:         ComposeProject
  containers:      DockerContainer[]
  containerStats:  ContainerStats[]
  allProjectNames: string[]
  onOpen:          () => void
}) {
  const { text, dot, running, total } = composeStatusLabel(project.status)
  const names   = projectContainerNames(project.name, containers, allProjectNames)
  const memUsed = sumProjectStat(names, containerStats, s => s.mem_used_bytes)
  const cpuUsed = sumProjectStat(names, containerStats, s => s.cpu_pct)
  const ports = [...new Set(
    containers
      .filter(c => names.includes(c.name) && c.ports)
      .flatMap(c => c.ports.split(',').map(p => extractHostPort(p.trim())).filter(Boolean))
  )].slice(0, 5)

  const statusColor =
    dot === 'running' ? 'var(--color-success)' :
    dot === 'partial' ? 'var(--color-warning)' :
    'var(--color-text-tertiary)'

  return (
    <button className="project-card" onClick={onOpen}>
      <span className={clsx('compose-status-dot', dot)} />
      <div className="project-card-main">
        <div className="project-card-name">{project.name}</div>
        <div className="project-card-meta">
          <span style={{ color: statusColor }}>{text}</span>
          {cpuUsed > 0 && (
            <span className="project-card-metric">{cpuUsed.toFixed(1)}% CPU</span>
          )}
          {memUsed > 0 && (
            <span className="project-card-metric">{bytesToHuman(memUsed)} RAM</span>
          )}
          {ports.length > 0 && (
            <span className="project-card-ports">{ports.map(p => `:${p}`).join(' ')}</span>
          )}
        </div>
      </div>
      <div className="project-card-counts">
        <span className="project-card-count"
          style={{ color: running > 0 ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}>
          {running}/{total}
        </span>
        <span className="project-card-count-label">running</span>
      </div>
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

  // ── Compose projects ──────────────────────────────────────────────────────
  const [composeProjects, setComposeProjects] = useState<ComposeProject[]>([])
  const [composeLoading,  setComposeLoading]  = useState(true)

  useEffect(() => {
    if (!status?.available) { setComposeLoading(false); return }
    setComposeLoading(true)
    api.dockerComposeLs()
      .then(setComposeProjects)
      .catch(() => setComposeProjects([]))
      .finally(() => setComposeLoading(false))
  }, [refreshTick, status?.available]) // eslint-disable-line

  const [resourceView, setResourceView] = useState<'top' | 'all'>('all')

  // ── Disk stats ────────────────────────────────────────────────────────────
  const [dockerDiskStats, setDockerDiskStats] = useState<DiskStats | null>(null)
  const [backupDiskStats, setBackupDiskStats] = useState<DiskStats | null>(null)
  const [backupBytes,     setBackupBytes]     = useState(0)

  useEffect(() => {
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

  const { topCpu, topMem } = useMemo(() => ({
    topCpu: [...containerStats].sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 3),
    topMem: [...containerStats].sort((a, b) => b.mem_used_bytes - a.mem_used_bytes).slice(0, 3),
  }), [containerStats])

  // Series for the shared live charts: history when available, else the
  // current sample as a single point.
  const liveItems = useMemo(
    () => [...containerStats]
      .sort((a, b) => b.cpu_pct - a.cpu_pct)
      .map(s => ({
        name: s.name,
        cpu: statHistory.get(s.name)?.cpu?.length ? statHistory.get(s.name)!.cpu : [s.cpu_pct],
        mem: statHistory.get(s.name)?.mem?.length ? statHistory.get(s.name)!.mem : [s.mem_used_bytes],
      })),
    [containerStats, statHistory],
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

  const runningProjects = useMemo(
    () => composeProjects.filter(p => composeStatusLabel(p.status).dot === 'running').length,
    [composeProjects],
  )
  const issueCount       = restarting.length + dead.length
  const allProjectNames  = useMemo(() => composeProjects.map(p => p.name), [composeProjects])

  // ── Disk totals ───────────────────────────────────────────────────────────
  const patchedDf = df ? { ...df, containers: buildContainersRow(df.containers, containers) } : null
  const totalRow  = patchedDf ? buildTotalRow(patchedDf) : null
  const totalFree = totalRow ? parseReclaimSize(totalRow.reclaimable) : null
  const hasFree   = totalFree != null && parseSizeBytes(totalFree) > 0

  // ── Cleanup data ──────────────────────────────────────────────────────────
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

  const allClean   = trueDangling.length === 0 && unusedTagged.length === 0 &&
                     stale.length === 0 && unusedVols.length === 0 && !showBuildCache
  const hasWarnings = !loading && (restarting.length > 0 || dead.length > 0)

  return (
    <div className="overview-tab">

      {/* ── 1. Workspace Summary ─────────────────────────────────────── */}
      {/* Three facts, not six. Engine state is already in the page header,
          project counts are already on the Active projects heading below, and
          an "Issues: None" tile reports nothing, so it only appears when there
          is actually something wrong. */}
      {loading ? <HeroSkeleton /> : (
        <StatRow>
          <StatCard
            label="Containers"
            value={String(runningCtrs)}
            sub={`running${notRunning ? ` · ${notRunning}` : ''}`}
            onClick={() => setDockerTab('containers')}
            ariaLabel={`Containers: ${runningCtrs} running. Open Containers.`}
          />
          <StatCard
            label="Images"
            value={String(images.length)}
            sub={df?.images.size ?? '-'}
            onClick={() => setDockerTab('images')}
            ariaLabel={`Images: ${images.length}. Open Images.`}
          />
          <StatCard
            label="Disk"
            value={totalRow?.size ?? '-'}
            sub={hasFree ? `${totalFree} reclaimable` : 'nothing to reclaim'}
            onClick={() => setDockerTab('prune')}
            ariaLabel={`Disk used by Docker: ${totalRow?.size ?? 'unknown'}. Open Prune.`}
          />
          {issueCount > 0 && (
            <StatCard
              label="Issues"
              value={String(issueCount)}
              tone="danger"
              sub={<span className="stat-sub--err">need attention</span>}
              onClick={() => setDockerTab('containers')}
              ariaLabel={`${issueCount} containers need attention. Open Containers.`}
            />
          )}
        </StatRow>
      )}

      {hasWarnings && (
        <div className="hero-warnings">
          {restarting.length > 0 && (
            <button className="hero-warning-row hero-warning-row--critical" onClick={() => setDockerTab('containers')}>
              <AlertTriangle size={13} aria-hidden="true" />
              {restarting.length} container{restarting.length !== 1 ? 's' : ''} in a restart loop
              <ChevronRight size={13} className="hero-warning-arrow" aria-hidden="true" />
            </button>
          )}
          {dead.length > 0 && (
            <button className="hero-warning-row hero-warning-row--critical" onClick={() => setDockerTab('containers')}>
              <AlertTriangle size={13} aria-hidden="true" />
              {dead.length} dead container{dead.length !== 1 ? 's' : ''}
              <ChevronRight size={13} className="hero-warning-arrow" aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* ── 2. Active Projects ───────────────────────────────────────── */}
      <SectionHead
        title="Active projects"
        meta={composeLoading ? '…' : `${runningProjects} running · ${composeProjects.length} total`}
        actions={<Button size="sm" variant="ghost" onClick={() => setDockerTab('compose')}>Open Compose</Button>}
      />
      <Panel>
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
          <p className="overview-empty-row">
            No compose projects found - create a compose.yaml file to manage multi-container apps.
          </p>
        ) : (
          <div className="project-cards">
            {composeProjects.map(p => (
              <ProjectCard
                key={p.name}
                project={p}
                containers={containers}
                containerStats={containerStats}
                allProjectNames={allProjectNames}
                onOpen={() => { setComposePreselect(p.name); setDockerTab('compose') }}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* ── 3. Resource Monitoring ───────────────────────────────────── */}
      <SectionHead
        title="Resource monitoring"
        actions={
          <>
            <Segmented label="Resource view">
              <SegmentedItem active={resourceView === 'all'} onClick={() => setResourceView('all')}>
                Live activity
              </SegmentedItem>
              <SegmentedItem active={resourceView === 'top'} onClick={() => setResourceView('top')}>
                Top offenders
              </SegmentedItem>
            </Segmented>
            <Button
              size="sm" variant="ghost" icon
              onClick={onPollStats}
              disabled={statsLoading}
              aria-label="Refresh container stats"
              title="Refresh stats"
            >
              <RefreshCw size={12} className={statsLoading ? 'spin' : ''} />
            </Button>
          </>
        }
      />
      <Panel className="panel--pad">
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
          <LiveMetricsCharts items={liveItems} stepSecs={5} />
        )}
      </Panel>

      {/* ── 4. Disk Usage ────────────────────────────────────────────── */}
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

        const dockerBarSegs = dockerDiskStats
          ? buildBar(dockerDiskStats, dockerCats, sameDrive ? backupBytes : 0)
          : dockerCats

        const backupBarSegs = !sameDrive && backupDiskStats && backupBytes > 0
          ? buildBar(backupDiskStats, [], backupBytes)
          : null

        const segPct = (bytes: number, driveTotal: number) =>
          driveTotal > 0 ? Math.max(bytes / driveTotal * 100, bytes > 0 ? 0.3 : 0) : 0

        const legendRows: { key: string; label: string; bytes: number; color: string; freeBytes: number; driveNote?: string }[] = [
          { key: 'images',     label: 'Images',      bytes: imgBytes,    color: 'images',     freeBytes: imgFree },
          { key: 'containers', label: 'Containers',  bytes: ctrBytes,    color: 'containers', freeBytes: ctrFree },
          { key: 'volumes',    label: 'Volumes',     bytes: volBytes,    color: 'volumes',    freeBytes: 0 },
          { key: 'cache',      label: 'Build Cache', bytes: bldBytes,    color: 'cache',      freeBytes: bldFree },
          { key: 'backups',    label: 'Backups',     bytes: backupBytes, color: 'backups',    freeBytes: 0,
            driveNote: !sameDrive && backupDiskStats ? backupDiskStats.drive_label : undefined },
        ].filter(r => r.bytes > 0)

        return (
          <>
            <SectionHead
              title="Disk usage"
              meta={totalFreeableBytes > 0 ? `${bytesToHuman(totalFreeableBytes)} freeable` : undefined}
            />
            <Panel>
            <div className="disk-body">
              <div className="drive-bars-grid">

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

              </div>

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

              <div className="disk-summary">
                <span>Docker: <strong>{bytesToHuman(dockerTotal)}</strong></span>
                {backupBytes > 0 && <span>Backups: <strong>{bytesToHuman(backupBytes)}</strong></span>}
                {totalFreeableBytes > 0 && (
                  <span className="disk-summary-free">{bytesToHuman(totalFreeableBytes)} freeable</span>
                )}
                <span className="disk-summary-note" title="docker system df - may not include Buildx cache on Docker Desktop for Windows">
                  via docker system df
                </span>
              </div>
            </div>
            </Panel>
          </>
        )
      })()}

      {/* ── 5. Cleanup Opportunities ─────────────────────────────────── */}
      <SectionHead
        title="Cleanup opportunities"
        meta={!loading && totalFreeBytes > 0 ? `~${bytesToHuman(totalFreeBytes)} freeable` : undefined}
        actions={!loading && totalFreeBytes > 0 && (
          <Button size="sm" variant="danger-outline" onClick={() => setDockerTab('prune')}>
            <Trash2 size={11} />
            Prune all
          </Button>
        )}
      />
      <Panel>
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
          <EmptyState
            icon={CheckCircle}
            title="Nothing to reclaim"
            description="No dangling images, stale containers, unused volumes, or build cache. This is what a clean engine looks like."
          />
        ) : (
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
                  try { await Promise.all(ids.map(id => api.dockerContainerAction(id, 'remove'))) }
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
                  try { await Promise.all(ids.map(id => api.dockerVolumeRemove(id))) }
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
        )}
      </Panel>

    </div>
  )
}
