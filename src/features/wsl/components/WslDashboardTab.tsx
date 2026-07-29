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
import { useVisiblePoll } from '../../../hooks/useVisiblePoll'
import { ErrorBanner } from '../../../components/ui'

type BarColor = 'accent' | 'success' | 'warning' | 'danger'

/** Severity colour for a saturation bar: neutral, then amber, then red. */
function levelColor(pct: number): BarColor {
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'accent'
}

const POLL_MS = 10_000

const TIP = {
  cpu:     'Load average ÷ logical cores. 100% means the run queue equals the core count.',
  mem:     'Used vs total RAM in the distro’s VM. Linux uses free RAM as cache, so “available” already accounts for reclaimable cache.',
  swap:    'WSL2’s on-disk swap file for the whole VM. Linux pages memory out here when RAM fills up.',
  disk:    'Used / total of the ext4 root filesystem inside the distro - not the .vhdx file size on Windows, and not your Windows drive.',
  init:    'systemd is PID 1. “degraded” means systemd is up but one or more units failed to start - the distro still works.',
  zombies: 'Defunct Linux processes that exited but were not reaped by their parent. A few are normal; many point to a buggy parent process.',
  net:     'Interface and DNS are refreshed live every 10s. The traffic figures are cumulative totals since the distro booted, not a live rate.',
  limits:  '“Actual” is what the running VM has now. “Cap” is the limit set in %USERPROFILE%\\.wslconfig - “none” means WSL chose the default.',
}

function InfoDot({ tip }: { tip: string }) {
  return <span className="wsl-info" title={tip}><Info size={11} /></span>
}

/** Gauge card: header (icon + label + value), a sub-row (detail + %), and a thin
 *  track with a dot marker at the current value. */
function Gauge({ icon: Icon, label, value, pct, sub, color, tip }: {
  icon: typeof Cpu
  label: string
  value: string
  pct: number | null
  sub: string
  color: BarColor
  tip: string
}) {
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="wsl-gauge">
      <div className="wsl-gauge-head">
        <Icon size={14} className="wsl-gauge-icon" />
        <span className="wsl-gauge-label">{label}</span>
        <InfoDot tip={tip} />
        <span className="wsl-gauge-value">{value}</span>
      </div>
      <div className="wsl-gauge-sub">
        <span className="wsl-gauge-sublabel">{sub}</span>
        <span className="wsl-gauge-pct">{pct === null ? '-' : `${Math.round(pct)}%`}</span>
      </div>
      <div className="wsl-gauge-track">
        <div className={clsx('wsl-gauge-fill', `wsl-gauge-fill--${color}`)} style={{ transform: `scaleX(${width / 100})` }} />
        <span className={clsx('wsl-gauge-dot', `wsl-gauge-dot--${color}`)} style={{ left: `${width}%` }} />
      </div>
    </div>
  )
}

function ProcList({ procs, kind, limit }: {
  procs: DistroMetrics['top_procs']
  kind: 'cpu' | 'mem'
  limit: number
}) {
  // CPU column is a percentage; memory column shows real RSS (in bytes), since the
  // per-process mem% rounds to 0.0 on a large-RAM VM and reads as broken.
  const metric = (p: DistroMetrics['top_procs'][number]) => (kind === 'cpu' ? p.cpu_pct : p.rss_kb)
  const sorted = [...procs].sort((a, b) => metric(b) - metric(a)).slice(0, limit)
  const max = Math.max(1, ...sorted.map(metric))
  return (
    <div className="stats-col">
      <div className="wsl-proc-head">
        <span>Process</span>
        <span>{kind === 'cpu' ? 'CPU' : 'Memory'}</span>
      </div>
      {sorted.length === 0 ? (
        <p className="overview-empty-row">No process data</p>
      ) : sorted.map((p, i) => (
        <div key={`${p.command}-${i}`} className="stats-row">
          <span className="stats-name" title={p.command}>{p.command}</span>
          <div className="stats-bar-wrap">
            <div className={clsx('stats-bar', kind === 'cpu' ? 'stats-bar--cpu' : 'stats-bar--mem')}
              style={{ width: `${(metric(p) / max) * 100}%` }} />
          </div>
          <span className="stats-value">
            {kind === 'cpu' ? `${p.cpu_pct.toFixed(1)}%` : bytesToHuman(p.rss_kb * 1024)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Status colour for the systemd init chip - never contradicts the word shown. */
function initChipClass(m: DistroMetrics): string {
  if (!m.systemd) return 'wsl-chip--muted'
  const s = m.systemd_state
  if (s === 'degraded' || s === 'maintenance' || s === 'starting' || s === 'stopping') return 'wsl-chip--warn'
  return 'wsl-chip--ok'
}

export default function WslDashboardTab({ distros, onReload }: {
  distros: WslDistro[]
  onReload: () => Promise<void> | void
}) {
  const selected = useAppStore(s => s.wslSelectedDistro) ?? ''
  const busyDistro = useAppStore(s => s.wslBusyDistro)
  // Metrics are cached per distro in the store, so reopening this page (tab switch,
  // distro switch, leaving and returning) shows the last sample immediately and
  // refreshes in the background - no skeleton flash every time.
  const metrics = useAppStore(s => s.wslMetrics[selected]) ?? null
  const setWslMetric = useAppStore(s => s.setWslMetric)
  const [error, setError]     = useState<string | null>(null)
  const [expandProc, setExpandProc] = useState(false)
  const [starting, setStarting] = useState(false)
  // .wslconfig limits (VM-wide; shared across distros).
  const [limits, setLimits] = useState<{ memory?: string; processors?: string; swap?: string }>({})

  const current  = distros.find(d => d.name === selected)
  const running  = current?.running ?? false
  // What we render follows the distro's real running state (kept fresh by the
  // list poll) so this page never contradicts the title. Whether we *probe* is a
  // separate decision: skip a distro mid lifecycle action so the metrics probe
  // can't reboot one that's being stopped.
  const shouldPoll = running && selected !== busyDistro

  const load = useCallback(async () => {
    if (!selected) return
    try {
      setWslMetric(selected, await api.wslDistroMetrics(selected))
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [selected, setWslMetric])

  // Explicit start from the offline card: actually boot the distro and refresh
  // the shared list, so every view updates to "running" together.
  const startDistro = async () => {
    setStarting(true); setError(null)
    try {
      await api.wslStartDistro(selected)
      await onReload()
    } catch (e) {
      setError(String(e))
    } finally {
      setStarting(false)
    }
  }

  // Clear only the transient error when the distro changes; metrics come from the
  // per-distro cache so there's no reset-to-skeleton on switch.
  useEffect(() => { setError(null) }, [selected])

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

  // Poll every 10 s while a running, non-transitioning distro is selected and
  // the window is on screen.
  useEffect(() => {
    if (shouldPoll) load()
  }, [shouldPoll, load])
  useVisiblePoll(load, POLL_MS, shouldPoll)

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
  const procLimit = expandProc ? 99 : 6

  return (
    <div className="wsl-dashboard">
      {!running && (
        <div className="offline-card">
          <p className="offline-title">{selected} is stopped</p>
          <p className="offline-desc">
            Start it to load live metrics. Nothing runs until you choose to.
          </p>
          {error && <p className="wsl-opt-error" style={{ margin: '0 0 12px' }}>{error}</p>}
          <button className="btn-filled btn-filled--accent" onClick={startDistro} disabled={starting}>
            <Play size={13} /> {starting ? 'Starting…' : 'Start distribution'}
          </button>
        </div>
      )}

      {running && error && (
        <ErrorBanner error={error} />
      )}

      {running && !metrics && !error && <DashboardSkeleton />}

      {running && metrics && (
        <>
          {/* ── Resource monitoring ─────────────────────────────────── */}
          <div className="wsl-dash-rm">
            <div className="wsl-dash-section-head">
              <span className="wsl-dash-section-label">Resource Monitoring</span>
              <span className="wsl-live-pill" style={{ marginLeft: 'auto' }}><span className="wsl-live-dot" />Live · every 10s</span>
            </div>

            <div className="wsl-gauges">
              <Gauge icon={Cpu} label="CPU load" tip={TIP.cpu}
                value={metrics.load1.toFixed(2)} pct={loadPct}
                sub={`${metrics.cpu_count} cores · ${metrics.load5.toFixed(2)} / ${metrics.load15.toFixed(2)} (5m/15m)`}
                color={loadPct === null ? 'accent' : levelColor(loadPct)} />
              <Gauge icon={MemoryStick} label="Memory" tip={TIP.mem}
                value={memPct === null ? '-' : `${Math.round(memPct)}%`} pct={memPct}
                sub={`${bytesToHuman(memUsedKb * 1024)} / ${bytesToHuman(metrics.mem_total_kb * 1024)}`}
                color={memPct === null ? 'accent' : levelColor(memPct)} />
              <Gauge icon={ArrowDownUp} label="Swap" tip={TIP.swap}
                value={metrics.swap_total_kb === 0 ? 'off' : swapPct === null ? '-' : `${Math.round(swapPct)}%`}
                pct={swapPct}
                sub={metrics.swap_total_kb > 0
                  ? `${bytesToHuman(swapUsedKb * 1024)} / ${bytesToHuman(metrics.swap_total_kb * 1024)}`
                  : 'no swap configured'}
                color={swapPct === null ? 'accent' : levelColor(swapPct)} />
              <Gauge icon={HardDrive} label="Disk (/)" tip={TIP.disk}
                value={diskPct === null ? '-' : `${Math.round(diskPct)}%`} pct={diskPct}
                sub={`${bytesToHuman(metrics.disk_used_bytes)} / ${bytesToHuman(metrics.disk_total_bytes)}`}
                color={diskPct === null ? 'accent' : levelColor(diskPct)} />
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
            {/* Zombies only earn a chip when there are some. "zombies 0" is a
                stat that reports nothing, and it sat next to three that do. */}
            {metrics.zombies > 0 && (
              <div className="wsl-chip wsl-chip--warn">
                <Skull size={12} />
                <span className="wsl-chip-label">zombies</span>
                <span className="wsl-chip-val">{metrics.zombies}</span>
                <InfoDot tip={TIP.zombies} />
              </div>
            )}
            <div className="wsl-chip wsl-chip--muted">
              <Clock size={12} />
              <span className="wsl-chip-label">uptime</span>
              <span className="wsl-chip-val">{formatDuration(metrics.uptime_secs)}</span>
            </div>
          </div>

          {/* ── Detail columns ──────────────────────────────────────── */}
          <div className="wsl-dash-cols">
            <div className="wsl-dash-section">
              <div className="wsl-dash-section-head">
                <span className="wsl-dash-section-label">Top processes</span>
                {metrics.top_procs.length > 6 && (
                  <button className="wsl-viewall" onClick={() => setExpandProc(v => !v)}>
                    {expandProc ? 'Show less' : 'View all'}
                  </button>
                )}
              </div>
              <div className="stats-grid">
                <ProcList procs={metrics.top_procs} kind="cpu" limit={procLimit} />
                <ProcList procs={metrics.top_procs} kind="mem" limit={procLimit} />
              </div>
            </div>

            <div className="wsl-dash-side">
              <div className="wsl-dash-section">
                <div className="wsl-dash-section-head">
                  <span className="wsl-dash-section-label">Network &amp; DNS</span>
                  <InfoDot tip={TIP.net} />
                </div>
                <div className="wsl-net">
                  <div className="wsl-net-item">
                    <Network size={14} className="wsl-net-icon" />
                    <div className="wsl-net-text">
                      <span className="wsl-net-k">{metrics.iface || 'interface'}</span>
                      <span className="wsl-net-v">{metrics.ip || '-'}</span>
                    </div>
                  </div>
                  <div className="wsl-net-item">
                    <ArrowDownUp size={14} className="wsl-net-icon" />
                    <div className="wsl-net-text">
                      <span className="wsl-net-k">Traffic <span className="wsl-net-sub">since boot</span></span>
                      <span className="wsl-net-v">↓ {bytesToHuman(metrics.rx_bytes)} · ↑ {bytesToHuman(metrics.tx_bytes)}</span>
                    </div>
                  </div>
                  <div className="wsl-net-item">
                    <span className="wsl-net-icon-spacer" />
                    <div className="wsl-net-text wsl-net-text--inline">
                      <span className="wsl-net-k">DNS</span>
                      <span className="wsl-net-v">{metrics.nameservers.length ? metrics.nameservers.join(', ') : 'none configured'}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="wsl-dash-section">
                <div className="wsl-dash-section-head">
                  <span className="wsl-dash-section-label">Resource limits</span>
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
    <div className="wsl-dash-rm">
      <div className="wsl-gauges">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="wsl-gauge">
            <div className="sk-line w-16" style={{ height: 10 }} />
            <div className="sk-line w-24" style={{ height: 9, marginTop: 14 }} />
            <div className="sk-line" style={{ height: 4, marginTop: 12 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
