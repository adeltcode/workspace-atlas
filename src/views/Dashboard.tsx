/* Overview.
 *
 * A user arrives here because something is wrong, so the page answers what is
 * the state of this machine, what can I get back, and what has been done to it.
 * Reclaimable space leads, because "my disk is full" is the reason this product
 * exists. */
import { useEffect, useState } from 'react'
import { Box, HardDrive, Package, Layers, Database, ChevronRight, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type ActivityModule, type DockerTab } from '../store/appStore'
import { useVisiblePoll } from '../hooks/useVisiblePoll'
import { getSystemMetrics, type SystemMetrics } from '../features/system/api'
import { bytesToHuman, timeAgo } from '../utils/format'
import { SheetHead, SectionHead, EmptyState, Button, StatCard, StatRow } from '../components/ui'

const MODULE_ICON: Record<ActivityModule, typeof Box> = { docker: Box, wsl: HardDrive, packages: Package }

/** Split "12.4GB (61%)" into the amount and the share, so the row can show the
 *  number large and the qualifier small. Docker gives us this as one string. */
function splitReclaim(s: string): { amount: string; note: string } {
  const m = s.match(/^([^(]+?)\s*(?:\(([^)]*)\))?$/)
  return { amount: (m?.[1] ?? s).trim(), note: m?.[2] ?? '' }
}

export default function Dashboard() {
  const setActiveView = useAppStore(s => s.setActiveView)
  const setDockerTab  = useAppStore(s => s.setDockerTab)
  const activityLog   = useAppStore(s => s.activityLog)
  const dockerCache   = useAppStore(s => s.dockerCache)
  const distros       = useAppStore(s => s.wslDistrosNav)
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)

  const poll = () => { getSystemMetrics().then(setMetrics).catch(() => {}) }
  useEffect(poll, [])
  useVisiblePoll(poll, 2000)

  const memPct = metrics && metrics.mem_total_bytes > 0
    ? (metrics.mem_used_bytes / metrics.mem_total_bytes) * 100
    : null
  const disk = metrics?.disks?.[0]
  const diskPct = disk && disk.total_bytes > 0
    ? ((disk.total_bytes - disk.free_bytes) / disk.total_bytes) * 100
    : null

  const goDocker = (tab: DockerTab) => { setActiveView('docker'); setDockerTab(tab) }

  const df = dockerCache?.df
  const reclaim = df ? ([
    { key: 'images', label: 'Docker images', icon: Layers,   raw: df.images.reclaimable,      tab: 'images'  as DockerTab, sub: `${df.images.total} images, ${df.images.total - df.images.active} unused` },
    { key: 'cache',  label: 'Build cache',   icon: Layers,   raw: df.build_cache.reclaimable, tab: 'prune'   as DockerTab, sub: 'Safe to remove entirely' },
    { key: 'vols',   label: 'Docker volumes', icon: Database, raw: df.volumes.reclaimable,    tab: 'volumes' as DockerTab, sub: 'May contain data you want' },
  ]).filter(r => r.raw && !/^0\s*B/i.test(r.raw)) : []

  const running = distros.filter(d => d.running).length

  return (
    <div className="view-container">
      <div className="page-head">
        <SheetHead
          crumbs={[{ label: 'Workspace Atlas' }, { label: 'Overview' }]}
          title="Overview"
          status={
            <>
              {dockerCache?.status && (
                <span className="pill">
                  <span className={clsx('rail-dot', dockerCache.status.state === 'running' ? 'running' : 'stopped')} />
                  Docker {dockerCache.status.version ?? 'unknown'}
                </span>
              )}
              {distros.length > 0 && (
                <span className="pill">
                  <span className={clsx('rail-dot', running ? 'running' : 'stopped')} />
                  {distros.length} distro{distros.length === 1 ? '' : 's'}{running ? `, ${running} running` : ''}
                </span>
              )}
            </>
          }
          actions={<Button onClick={poll}><RefreshCw size={13} /> Refresh</Button>}
        />
      </div>

      <div className="page-scroll">
        <StatRow>
          <StatCard
            label="CPU"
            value={metrics ? String(Math.round(metrics.cpu_pct)) : '-'}
            unit={metrics ? '%' : undefined}
            pct={metrics ? metrics.cpu_pct : null}
            sub={metrics ? `${metrics.cpu_count} logical cores` : undefined}
          />
          <StatCard
            label="Memory"
            value={metrics ? bytesToHuman(metrics.mem_used_bytes) : '-'}
            pct={memPct}
            sub={metrics ? `of ${bytesToHuman(metrics.mem_total_bytes)}${memPct === null ? '' : ` · ${Math.round(memPct)}%`}` : undefined}
          />
          {disk && (
            <StatCard
              label={`Disk ${disk.mount.replace(/\\$/, '')}`}
              value={bytesToHuman(disk.free_bytes)}
              unit="free"
              pct={diskPct}
              sub={`of ${bytesToHuman(disk.total_bytes)}${diskPct === null ? '' : ` · ${Math.round(diskPct)}% used`}`}
            />
          )}
          {reclaim.length > 0 && (
            <StatCard
              label="Reclaimable"
              value={reclaim.map(r => splitReclaim(r.raw).amount).join(' + ')}
              pct={100}
              tone="ok"
              sub={`across ${reclaim.length} source${reclaim.length === 1 ? '' : 's'}`}
              onClick={() => goDocker('prune')}
              ariaLabel="Reclaimable space, open Prune"
            />
          )}
        </StatRow>

        {reclaim.length > 0 && (
          <>
            <SectionHead title="Reclaimable space" />
            <div className="rowlist">
              {reclaim.map(r => {
                const { amount, note } = splitReclaim(r.raw)
                return (
                  <button key={r.key} className="rowitem" onClick={() => goDocker(r.tab)}>
                    <span className="rowitem-icon"><r.icon size={13} /></span>
                    <span className="rowitem-main">
                      <span className="rowitem-title">{r.label}</span>
                      <span className="rowitem-sub" style={{ display: 'block' }}>
                        {r.sub}{note && ` · ${note}`}
                      </span>
                    </span>
                    <span className="rowitem-value num">{amount}</span>
                    <ChevronRight size={14} className="rowitem-chev" />
                  </button>
                )
              })}
            </div>
          </>
        )}

        <SectionHead title="Recent activity" />
        {activityLog.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            description="Every operation this app performs is listed here with its outcome, and the exact command it ran appears in the command pane below."
            actions={
              <>
                <Button onClick={() => setActiveView('docker')}>Open Docker</Button>
                <Button onClick={() => setActiveView('wsl')}>Open WSL</Button>
              </>
            }
          />
        ) : (
          <ul>
            {activityLog.slice(0, 12).map(a => {
              const Icon = MODULE_ICON[a.module]
              return (
                <li key={a.id} className="act-row">
                  <span className={clsx('act-dot', `act-dot--${a.outcome}`)} />
                  <Icon size={12} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                  <span className="act-title">{a.action}</span>
                  {a.detail && <span className="act-detail">{a.detail}</span>}
                  <span className="act-time">{timeAgo(a.ts)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
