import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  Cpu, MemoryStick, HardDrive, ArrowDownUp, Activity, Boxes, Play, Network, Info, Skull, Clock,
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
const HISTORY = 30

const TIP = {
  init:    'systemd is PID 1. “degraded” means systemd is up but one or more units failed to start — the distro still works.',
  zombies: 'Defunct Linux processes that exited but were not reaped by their parent. A few are normal; many point to a buggy parent process.',
  swap:    'WSL2’s on-disk swap file for the whole VM. Linux pages memory out here when RAM fills up.',
  disk:    'Used / total of the ext4 root filesystem inside the distro — not the .vhdx file size on Windows, and not your Windows drive.',
  net:     'Interface and DNS are refreshed live every 10s. The traffic figures are cumulative totals since the distro booted, not a live rate.',
  cpu:     'Load average ÷ logical cores. 100% means the run queue equals the core count.',
  limits:  '“Actual” is what the running VM has now. “Cap” is the limit set in %USERPROFILE%\\.wslconfig — “none” means WSL chose the default.',
}

function InfoDot({ tip }: { tip: string }) {
  return <span className="wsl-info" title={tip}><Info size={11} /></span>
}

/** Compact trend sparkline for a gauge card. Auto-scales Y to the data (with a
 *  floor) so low-but-varying utilisation still reads as a shape, not a flat
 *  line glued to the axis. */
function Sparkline({ values }: { values: number[] }) {
  const n = values.length
  // Until there are at least two samples, show a quiet placeholder rather than a
  // degenerate one-point shape.
  if (n < 2) return <div className="wsl-spark wsl-spark--empty" title="Collecting trend data…" />
  const ceil = Math.max(10, ...values) * 1.25
  const pts = values.map((v, i) => {
    const x = (i / (n - 1)) * 100
    const y = 100 - Math.max(0, Math.min(100, (v / ceil) * 100))
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return (
    <svg className="wsl-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polygon className="wsl-spark-area" points={`0,100 ${pts} 100,100`} />
      <polyline className="wsl-spark-line" points={pts} fill="none" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

function Gauge({ icon: Icon, label, pct, value, sub, color, tip, spark }: {
  icon: typeof Cpu
  label: string
  pct: number | null
  value: string
  sub?: string
  color: BarColor
  tip?: string
  spark?: number[]
}) {
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="sys-card">
      <div className="sys-card-head">
        <Icon size={13} className="sys-card-icon" />
        <span className="sys-card-label">{label}</span>
        {tip && <InfoDot tip={tip} />}
        <span className="sys-card-val">{value}</span>
      </div>
      <div className="sys-bar">
        <div className={clsx('sys-bar-fill', `sys-bar--${color}`)} style={{ width: `${width}%` }} />
      </div>
      {sub && <div className="sys-card-sub">{sub}</div>}
      {spark && <Sparkline values={spark} />}
    </div>
  )
}

/** Status colour for the systemd init chip — never contradicts the word shown. */
function initChipClass(m: DistroMetrics): string {
  if (!m.systemd) return 'wsl-chip--muted'
  const s = m.systemd_state
  if (s === 'degraded' || s === 'maintenance' || s === 'starting' || s === 'stopping') return 'wsl-chip--warn'
  return 'wsl-chip--ok'
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

export default function WslDashboardTab({ distros }: { distros: WslDistro[] }) {
  const selected = useAppStore(s => s.wslSelectedDistro) ?? ''
  const [metrics, setMetrics] = useState<DistroMetrics | null>(null)
  const [history, setHistory] = useState<{ cpu: number; mem: number; swap: number; disk: number }[]>([])
  const [error, setError]     = useState<string | null>(null)
  // Distros the user opted to start by loading metrics. Reading a stopped distro
  // boots it, so we never poll one silently.
  const [activated, setActivated] = useState<Set<string>>(() => new Set())
  // .wslconfig limits (VM-wide; shared across distros).
  const [limits, setLimits] = useState<{ memory?: string; processors?: string; swap?: string }>({})

  const current  = distros.find(d => d.name === selected)
  const running  = current?.running ?? false
  const polling  = !!selected && (running || activated.has(selected))

  const load = useCallback(async () => {
    if (!selected) return
    try {
      const m = await api.wslDistroMetrics(selected)
      setMetrics(m)
      setError(null)
      const cpu  = m.cpu_count > 0 ? (m.load1 / m.cpu_count) * 100 : 0
      const mem  = m.mem_total_kb > 0 ? ((m.mem_total_kb - m.mem_available_kb) / m.mem_total_kb) * 100 : 0
      const swap = m.swap_total_kb > 0 ? ((m.swap_total_kb - m.swap_free_kb) / m.swap_total_kb) * 100 : 0
      const disk = m.disk_total_bytes > 0 ? (Math.min(m.disk_used_bytes, m.disk_total_bytes) / m.disk_total_bytes) * 100 : 0
      setHistory(prev => [...prev, { cpu, mem, swap, disk }].slice(-HISTORY))
    } catch (e) {
      setError(String(e))
    }
  }, [selected])

  // Reset view + trend history when the distro changes.
  useEffect(() => { setMetrics(null); setHistory([]); setError(null) }, [selected])

  // Read .wslconfig limits once (global, not per-distro).
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
    load()
    const id = setInterval(() => { if (active) load() }, POLL_MS)
    return () => { active = false; clearInterval(id) }
  }, [polling, load])

  if (distros.length === 0) {
    return <p className="empty-state" style={{ marginTop: 8 }}>No distributions found.</p>
  }

  const memUsedKb  = metrics ? metrics.mem_total_kb - metrics.mem_available_kb : 0
  const memPct     = metrics && metrics.mem_total_kb > 0 ? (memUsedKb / metrics.mem_total_kb) * 100 : null
  const swapUsedKb = metrics ? metrics.swap_total_kb - metrics.swap_free_kb : 0
  const swapPct    = metrics && metrics.swap_total_kb > 0 ? (swapUsedKb / metrics.swap_total_kb) * 100 : null
  const loadPct    = metrics && metrics.cpu_count > 0 ? (metrics.load1 / metrics.cpu_count) * 100 : null
  const diskPct    = metrics && metrics.disk_total_bytes > 0
    ? (Math.min(metrics.disk_used_bytes, metrics.disk_total_bytes) / metrics.disk_total_bytes) * 100
    : null

  return (
    <div className="wsl-dashboard">
      {!polling && (
        <div className="offline-card">
          <p className="offline-title">{selected} is stopped</p>
          <p className="offline-desc">
            Loading live metrics will start this distribution. Nothing runs until you choose to.
          </p>
          <button className="btn-filled btn-filled--accent" onClick={() => setActivated(prev => new Set(prev).add(selected))}>
            <Play size={13} /> Start &amp; load metrics
          </button>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {polling && !metrics && !error && <DashboardSkeleton />}

      {polling && metrics && (
        <>
          {/* ── Resource monitoring ─────────────────────────────────── */}
          <div className="overview-section" style={{ margin: 0 }}>
            <div className="overview-section-head overview-section-head--static">
              <span className="section-label" style={{ margin: 0 }}>Resource Monitoring</span>
              <span className="wsl-live-pill" style={{ marginLeft: 'auto' }}>
                <span className="wsl-live-dot" />Live · every 10s
              </span>
            </div>

            <div className="sys-metrics">
              <Gauge icon={Cpu} label="CPU load" tip={TIP.cpu} pct={loadPct}
                value={metrics.load1.toFixed(2)}
                sub={`${metrics.cpu_count} cores · ${metrics.load5.toFixed(2)} / ${metrics.load15.toFixed(2)} (5m/15m)`}
                color={loadPct === null ? 'accent' : levelColor(loadPct)}
                spark={history.map(h => h.cpu)} />
              <Gauge icon={MemoryStick} label="Memory" pct={memPct}
                value={memPct === null ? '—' : `${Math.round(memPct)}%`}
                sub={`${bytesToHuman(memUsedKb * 1024)} / ${bytesToHuman(metrics.mem_total_kb * 1024)}`}
                color={memPct === null ? 'accent' : levelColor(memPct)}
                spark={history.map(h => h.mem)} />
              <Gauge icon={ArrowDownUp} label="Swap" tip={TIP.swap} pct={swapPct}
                value={swapPct === null ? 'off' : `${Math.round(swapPct)}%`}
                sub={metrics.swap_total_kb > 0
                  ? `${bytesToHuman(swapUsedKb * 1024)} / ${bytesToHuman(metrics.swap_total_kb * 1024)}`
                  : 'no swap configured'}
                color={swapPct === null ? 'accent' : levelColor(swapPct)}
                spark={history.map(h => h.swap)} />
              <Gauge icon={HardDrive} label="Disk (/)" tip={TIP.disk} pct={diskPct}
                value={diskPct === null ? '—' : `${Math.round(diskPct)}%`}
                sub={`${bytesToHuman(metrics.disk_used_bytes)} / ${bytesToHuman(metrics.disk_total_bytes)}`}
                color={diskPct === null ? 'accent' : levelColor(diskPct)}
                spark={history.map(h => h.disk)} />
            </div>
          </div>

          {/* ── System status strip ─────────────────────────────────── */}
          <div className="wsl-dash-chips">
            <div className={clsx('wsl-chip', initChipClass(metrics))}>
              <Activity size={12} />
              <span className="wsl-chip-label">init</span>
              <span className="wsl-chip-val">
                {metrics.systemd ? `systemd${metrics.systemd_state ? ` · ${metrics.systemd_state}` : ''}` : (metrics.pid1 || 'unknown')}
              </span>
              <InfoDot tip={TIP.init} />
            </div>
            <div className={clsx('wsl-chip', metrics.docker_present ? 'wsl-chip--ok' : 'wsl-chip--muted')}>
              <Boxes size={12} />
              <span className="wsl-chip-label">docker</span>
              <span className="wsl-chip-val">{metrics.docker_present ? `${metrics.docker_running} running` : 'not installed'}</span>
            </div>
            <div className={clsx('wsl-chip', metrics.zombies > 0 ? 'wsl-chip--warn' : 'wsl-chip--ok')}>
              <Skull size={12} />
              <span className="wsl-chip-label">zombies</span>
              <span className="wsl-chip-val">{metrics.zombies}</span>
              <InfoDot tip={TIP.zombies} />
            </div>
            <div className="wsl-chip wsl-chip--muted">
              <Clock size={12} />
              <span className="wsl-chip-label">uptime</span>
              <span className="wsl-chip-val">{formatDuration(metrics.uptime_secs)}</span>
            </div>
          </div>

          {/* ── Detail columns ──────────────────────────────────────── */}
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
                <InfoDot tip={TIP.net} />
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
                  <span className="wsl-net-val">↓ {bytesToHuman(metrics.rx_bytes)} · ↑ {bytesToHuman(metrics.tx_bytes)} <span className="wsl-net-sub">since boot</span></span>
                </div>
                <div className="wsl-net-row">
                  <span className="wsl-net-key" style={{ marginLeft: 21 }}>DNS</span>
                  <span className="wsl-net-val">{metrics.nameservers.length ? metrics.nameservers.join(', ') : 'none configured'}</span>
                </div>
              </div>

              <div className="overview-section-head overview-section-head--static" style={{ marginTop: 14 }}>
                <span className="section-label" style={{ margin: 0 }}>Resource limits</span>
                <InfoDot tip={TIP.limits} />
              </div>
              <table className="wsl-limits-table">
                <thead>
                  <tr><th>Resource</th><th>Configured cap</th><th>Actual</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Memory</td>
                    <td className={limits.memory ? '' : 'wsl-limit-default'}>{limits.memory ?? 'none (default)'}</td>
                    <td className="wsl-limit-actual-cell">{bytesToHuman(metrics.mem_total_kb * 1024)}</td>
                  </tr>
                  <tr>
                    <td>Processors</td>
                    <td className={limits.processors ? '' : 'wsl-limit-default'}>{limits.processors ?? 'none (default)'}</td>
                    <td className="wsl-limit-actual-cell">{metrics.cpu_count} cores</td>
                  </tr>
                  <tr>
                    <td>Swap</td>
                    <td className={limits.swap ? '' : 'wsl-limit-default'}>{limits.swap ?? 'none (default)'}</td>
                    <td className="wsl-limit-actual-cell">{metrics.swap_total_kb > 0 ? bytesToHuman(metrics.swap_total_kb * 1024) : 'off'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Loading placeholder that reserves the gauge layout so switching to this tab
 *  does not shift the page while metrics load. */
function DashboardSkeleton() {
  return (
    <div className="overview-section" style={{ margin: 0 }}>
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
