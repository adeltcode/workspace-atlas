import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  Cpu, MemoryStick, HardDrive, ArrowDownUp, Activity, Boxes, Play, RefreshCw, Network,
} from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import { readWslConfig } from '../api'
import { getIniValue } from '../ini'
import type { WslDistro, DistroMetrics } from '../types'
import { bytesToHuman, formatDuration } from '../../../utils/format'

type BarColor = 'accent' | 'success' | 'warning' | 'danger'

/** Severity colour for a saturation gauge: neutral, then amber, then red. */
function levelColor(pct: number): BarColor {
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'accent'
}

const POLL_MS = 10_000

function Gauge({ icon: Icon, label, pct, value, sub, color }: {
  icon: typeof Cpu
  label: string
  pct: number | null
  value: string
  sub?: string
  color: BarColor
}) {
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="sys-card">
      <div className="sys-card-head">
        <Icon size={13} className="sys-card-icon" />
        <span className="sys-card-label">{label}</span>
        <span className="sys-card-val">{value}</span>
      </div>
      <div className="sys-bar">
        <div className={clsx('sys-bar-fill', `sys-bar--${color}`)} style={{ width: `${width}%` }} />
      </div>
      {sub && <div className="sys-card-sub">{sub}</div>}
    </div>
  )
}

function ProcList({ procs, kind }: { procs: DistroMetrics['top_procs']; kind: 'cpu' | 'mem' }) {
  const sorted = [...procs].sort((a, b) =>
    kind === 'cpu' ? b.cpu_pct - a.cpu_pct : b.mem_pct - a.mem_pct,
  ).slice(0, 6)
  const max = Math.max(1, ...sorted.map(p => (kind === 'cpu' ? p.cpu_pct : p.mem_pct)))
  return (
    <div className="stats-col">
      <div className="stats-col-label">{kind === 'cpu' ? 'CPU' : 'Memory'}</div>
      {sorted.length === 0 ? (
        <p className="overview-empty-row">No process data</p>
      ) : sorted.map((p, i) => {
        const v = kind === 'cpu' ? p.cpu_pct : p.mem_pct
        return (
          <div key={`${p.command}-${i}`} className="stats-row">
            <span className="stats-name" title={p.command}>{p.command}</span>
            <div className="stats-bar-wrap">
              <div className={clsx('stats-bar', kind === 'cpu' ? 'stats-bar--cpu' : 'stats-bar--mem')}
                style={{ width: `${(v / max) * 100}%` }} />
            </div>
            <span className="stats-value">{v.toFixed(1)}%</span>
          </div>
        )
      })}
    </div>
  )
}

/** Limit-vs-actual row for the .wslconfig comparison. `limit` is the raw config
 *  string (e.g. "8GB"); undefined means unset / default. */
function LimitRow({ label, limit, actual }: { label: string; limit?: string; actual: string }) {
  return (
    <div className="wsl-limit-row">
      <span className="wsl-limit-label">{label}</span>
      <span className="wsl-limit-actual">{actual}</span>
      <span className="wsl-limit-cap">{limit ? `cap ${limit}` : 'default'}</span>
    </div>
  )
}

export default function WslDashboardTab({ distros }: { distros: WslDistro[] }) {
  const selected = useAppStore(s => s.wslSelectedDistro) ?? ''
  const [metrics, setMetrics] = useState<DistroMetrics | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Distros the user has explicitly opted to start by loading metrics. Reading
  // a stopped distro boots it, so we never poll one silently.
  const [activated, setActivated] = useState<Set<string>>(() => new Set())
  // .wslconfig limits (VM-wide; shared across distros).
  const [limits, setLimits] = useState<{ memory?: string; processors?: string; swap?: string }>({})

  const current  = distros.find(d => d.name === selected)
  const running  = current?.running ?? false
  const polling  = !!selected && (running || activated.has(selected))

  const load = useCallback(async (showSpinner: boolean) => {
    if (!selected) return
    if (showSpinner) setLoading(true)
    try {
      const m = await api.wslDistroMetrics(selected)
      setMetrics(m)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [selected])

  // Reset view when the distro changes.
  useEffect(() => { setMetrics(null); setError(null) }, [selected])

  // Read .wslconfig limits once (they are global, not per-distro).
  useEffect(() => {
    readWslConfig()
      .then(c => setLimits({
        memory:     getIniValue(c.content, 'wsl2', 'memory'),
        processors: getIniValue(c.content, 'wsl2', 'processors'),
        swap:       getIniValue(c.content, 'wsl2', 'swap'),
      }))
      .catch(() => {})
  }, [])

  // Poll every 10 s while a started distro is selected.
  useEffect(() => {
    if (!polling) return
    let active = true
    const tick = () => { if (active) load(false) }
    load(true)
    const id = setInterval(tick, POLL_MS)
    return () => { active = false; clearInterval(id) }
  }, [polling, load])

  if (distros.length === 0) {
    return <p className="empty-state" style={{ marginTop: 24 }}>No distributions found.</p>
  }

  const memUsedKb = metrics ? metrics.mem_total_kb - metrics.mem_available_kb : 0
  const memPct    = metrics && metrics.mem_total_kb > 0 ? (memUsedKb / metrics.mem_total_kb) * 100 : null
  const swapUsedKb = metrics ? metrics.swap_total_kb - metrics.swap_free_kb : 0
  const swapPct   = metrics && metrics.swap_total_kb > 0 ? (swapUsedKb / metrics.swap_total_kb) * 100 : null
  const loadPct   = metrics && metrics.cpu_count > 0 ? (metrics.load1 / metrics.cpu_count) * 100 : null
  const diskPct   = metrics && metrics.disk_total_bytes > 0
    ? ((metrics.disk_total_bytes - metrics.disk_used_bytes < 0 ? 0 : metrics.disk_used_bytes) / metrics.disk_total_bytes) * 100
    : null

  return (
    <div className="wsl-dashboard">
      {polling && (
        <div className="wsl-dash-statusline">
          <span className="wsl-live-dot" />
          <span className="wsl-live-text">Live · auto-refreshing every 10s</span>
          <button className="btn-icon" onClick={() => load(true)} disabled={loading} title="Refresh now" style={{ marginLeft: 'auto' }}>
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>
      )}

      {!polling && (
        <div className="offline-card" style={{ marginTop: 16 }}>
          <p className="offline-title">{selected} is stopped</p>
          <p className="offline-desc">
            Loading live metrics will start this distribution. Nothing runs until you choose to.
          </p>
          <button
            className="btn-filled btn-filled--accent"
            onClick={() => setActivated(prev => new Set(prev).add(selected))}
          >
            <Play size={13} /> Start &amp; load metrics
          </button>
        </div>
      )}

      {error && (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {polling && metrics && (
        <>
          <div className="sys-metrics" style={{ marginTop: 16 }}>
            <Gauge
              icon={Cpu}
              label="CPU load"
              pct={loadPct}
              value={metrics.load1.toFixed(2)}
              sub={`${metrics.cpu_count} cores · ${metrics.load5.toFixed(2)} / ${metrics.load15.toFixed(2)} (5m/15m)`}
              color={loadPct === null ? 'accent' : levelColor(loadPct)}
            />
            <Gauge
              icon={MemoryStick}
              label="Memory"
              pct={memPct}
              value={memPct === null ? '—' : `${Math.round(memPct)}%`}
              sub={`${bytesToHuman(memUsedKb * 1024)} / ${bytesToHuman(metrics.mem_total_kb * 1024)}`}
              color={memPct === null ? 'accent' : levelColor(memPct)}
            />
            <Gauge
              icon={ArrowDownUp}
              label="Swap"
              pct={swapPct}
              value={swapPct === null ? 'off' : `${Math.round(swapPct)}%`}
              sub={metrics.swap_total_kb > 0
                ? `${bytesToHuman(swapUsedKb * 1024)} / ${bytesToHuman(metrics.swap_total_kb * 1024)}`
                : 'no swap configured'}
              color={swapPct === null ? 'accent' : levelColor(swapPct)}
            />
            <Gauge
              icon={HardDrive}
              label="Disk (/)"
              pct={diskPct}
              value={diskPct === null ? '—' : `${Math.round(diskPct)}%`}
              sub={`${bytesToHuman(metrics.disk_used_bytes)} / ${bytesToHuman(metrics.disk_total_bytes)}`}
              color={diskPct === null ? 'accent' : levelColor(diskPct)}
            />
          </div>

          <div className="wsl-dash-chips">
            <div className={clsx('wsl-chip', metrics.systemd ? 'wsl-chip--ok' : 'wsl-chip--muted')}>
              <Activity size={12} />
              <span className="wsl-chip-label">init</span>
              <span className="wsl-chip-val">
                {metrics.systemd ? `systemd${metrics.systemd_state ? ` · ${metrics.systemd_state}` : ''}` : (metrics.pid1 || 'unknown')}
              </span>
            </div>
            <div className={clsx('wsl-chip', metrics.docker_present ? 'wsl-chip--ok' : 'wsl-chip--muted')}>
              <Boxes size={12} />
              <span className="wsl-chip-label">docker</span>
              <span className="wsl-chip-val">
                {metrics.docker_present ? `${metrics.docker_running} running` : 'not installed'}
              </span>
            </div>
            <div className={clsx('wsl-chip', metrics.zombies > 0 ? 'wsl-chip--warn' : 'wsl-chip--ok')}>
              <Activity size={12} />
              <span className="wsl-chip-label">zombies</span>
              <span className="wsl-chip-val">{metrics.zombies}</span>
            </div>
            <div className="wsl-chip wsl-chip--muted">
              <RefreshCw size={12} />
              <span className="wsl-chip-label">uptime</span>
              <span className="wsl-chip-val">{formatDuration(metrics.uptime_secs)}</span>
            </div>
          </div>

          <div className="wsl-dash-cols">
            <div className="overview-section" style={{ margin: 0 }}>
              <div className="overview-section-head overview-section-head--static">
                <span className="section-label" style={{ margin: 0 }}>Top processes</span>
              </div>
              <div className="stats-grid">
                <ProcList procs={metrics.top_procs} kind="cpu" />
                <ProcList procs={metrics.top_procs} kind="mem" />
              </div>
            </div>

            <div className="overview-section" style={{ margin: 0 }}>
              <div className="overview-section-head overview-section-head--static">
                <span className="section-label" style={{ margin: 0 }}>Network &amp; DNS</span>
              </div>
              <div className="wsl-net-card">
                <div className="wsl-net-row">
                  <Network size={13} className="wsl-net-icon" />
                  <span className="wsl-net-key">{metrics.iface || 'interface'}</span>
                  <span className="wsl-net-val">{metrics.ip || '—'}</span>
                </div>
                <div className="wsl-net-row">
                  <ArrowDownUp size={13} className="wsl-net-icon" />
                  <span className="wsl-net-key">traffic</span>
                  <span className="wsl-net-val">
                    ↓ {bytesToHuman(metrics.rx_bytes)} · ↑ {bytesToHuman(metrics.tx_bytes)}
                  </span>
                </div>
                <div className="wsl-net-row">
                  <span className="wsl-net-key" style={{ marginLeft: 21 }}>DNS</span>
                  <span className="wsl-net-val">
                    {metrics.nameservers.length ? metrics.nameservers.join(', ') : 'none configured'}
                  </span>
                </div>
              </div>

              <div className="overview-section-head overview-section-head--static" style={{ marginTop: 14 }}>
                <span className="section-label" style={{ margin: 0 }}>Config limits vs actual</span>
              </div>
              <div className="wsl-limits">
                <LimitRow label="Memory" limit={limits.memory} actual={bytesToHuman(metrics.mem_total_kb * 1024)} />
                <LimitRow label="Processors" limit={limits.processors} actual={`${metrics.cpu_count} cores`} />
                <LimitRow label="Swap" limit={limits.swap}
                  actual={metrics.swap_total_kb > 0 ? bytesToHuman(metrics.swap_total_kb * 1024) : 'off'} />
              </div>
              <p className="wsl-limits-note">Limits come from <code>.wslconfig</code> and apply to the whole WSL2 VM.</p>
            </div>
          </div>
        </>
      )}

      {polling && !metrics && !error && (
        <DashboardSkeleton />
      )}
    </div>
  )
}

/** Loading placeholder that reserves the gauge + columns layout so switching to
 *  this tab does not shift the page while metrics load. */
function DashboardSkeleton() {
  return (
    <div style={{ marginTop: 16 }}>
      <div className="sys-metrics">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="sys-card">
            <div className="sk-line w-16" style={{ height: 10 }} />
            <div className="sk-line" style={{ height: 6, marginTop: 12 }} />
            <div className="sk-line w-24" style={{ height: 9, marginTop: 8 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
