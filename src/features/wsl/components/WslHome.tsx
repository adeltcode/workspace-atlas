import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Star, Terminal, ChevronRight, HardDrive,
  RotateCw, Square, Play, Upload, Settings2, History, Activity,
} from 'lucide-react'
import DriveBar from '../../../components/DriveBar'
import { useAppStore, type ActivityEntry } from '../../../store/appStore'
import * as api from '../api'
import { readWslConfig } from '../api'
import { getDiskStats } from '../../docker/api'
import type { DiskStats } from '../../docker/types'
import { getIniValue } from '../ini'
import type { WslDistro, DistroExtras } from '../types'
import { bytesToHuman, formatDuration, timeAgo } from '../../../utils/format'
import { Toolbar, SearchField, EmptyState, Button, FilterSegments } from '../../../components/ui'
import { Modal, Field } from './Dialog'
import { DistroLogo } from '../DistroLogo'
import { useAsyncAction } from '../../../hooks/useAsyncAction'
import { useVisiblePoll } from '../../../hooks/useVisiblePoll'
import LiveMetricsCharts, { getChartColors } from '../../../components/LiveMetricsCharts'
import { OutputDialog, OutputText } from '../../../components/CommandOutput'

type StateFilter = 'all' | 'running' | 'stopped'
const STATE_FILTERS: { key: StateFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'stopped', label: 'Stopped' },
]
type Lifecycle = { d: WslDistro; action: 'stop' | 'restart' }

export default function WslHome({ distros, onReload }: {
  distros: WslDistro[]
  onReload: () => Promise<void> | void
}) {
  const addActivity   = useAppStore(s => s.addActivity)
  const activityLog   = useAppStore(s => s.activityLog)
  const setWslView    = useAppStore(s => s.setWslView)
  const setSelected   = useAppStore(s => s.setWslSelectedDistro)
  const importOpen    = useAppStore(s => s.wslImportOpen)
  const setImportOpen = useAppStore(s => s.setWslImportOpen)

  const [query, setQuery]   = useState('')
  const [filter, setFilter] = useState<StateFilter>('all')
  const [activityDetail, setActivityDetail] = useState<ActivityEntry | null>(null)

  const [limits, setLimits] = useState<{ memory?: string; processors?: string; swap?: string }>({})

  const [showImport, setShowImport] = useState(false)
  const [importTar, setImportTar]   = useState('')
  const [importName, setImportName] = useState('')
  const [importDir, setImportDir]   = useState('')
  const [importing, setImporting]   = useState(false)
  const [importErr, setImportErr]   = useState<string | null>(null)

  const [extras, setExtras]             = useState<Record<string, DistroExtras>>({})
  const [extrasBusy, setExtrasBusy]     = useState<Set<string>>(() => new Set())
  const [extrasFailed, setExtrasFailed] = useState<Set<string>>(() => new Set())

  // `busyAction` drives only this dashboard's buttons. `wslBusyDistro` (store) tells pollers to skip a
  // distro in transition; every op that boots or stops one sets it, so it must not gate these buttons.
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const busyDistro    = useAppStore(s => s.wslBusyDistro)
  const setBusyDistro = useAppStore(s => s.setWslBusyDistro)
  const [lifecycle, setLifecycle]   = useState<Lifecycle | null>(null)

  const theme = useAppStore(s => s.theme)
  const [statHistory, setStatHistory] = useState<Map<string, { cpu: number[]; mem: number[] }>>(() => new Map())
  const [drives, setDrives] = useState<Record<string, DiskStats>>({})

  useEffect(() => {
    if (importOpen) { setImportErr(null); setShowImport(true); setImportOpen(false) }
  }, [importOpen, setImportOpen])

  useEffect(() => {
    readWslConfig()
      .then(c => setLimits({
        memory:     getIniValue(c.content, 'wsl2', 'memory'),
        processors: getIniValue(c.content, 'wsl2', 'processors'),
        swap:       getIniValue(c.content, 'wsl2', 'swap'),
      }))
      .catch(() => {})
  }, [])

  const loadExtras = useCallback(async (name: string) => {
    setExtrasBusy(prev => new Set(prev).add(name))
    setExtrasFailed(prev => { const n = new Set(prev); n.delete(name); return n })
    try {
      const x = await api.wslDistroExtras(name)
      setExtras(prev => ({ ...prev, [name]: x }))
    } catch {
      setExtrasFailed(prev => new Set(prev).add(name))
    } finally {
      setExtrasBusy(prev => { const n = new Set(prev); n.delete(name); return n })
    }
  }, [])

  // Never boot a stopped distro silently. Skip the one mid-action: while it stops, the list can still
  // show it as running, and a scan would boot it straight back up.
  useEffect(() => {
    for (const d of distros) {
      if (d.running && d.name !== busyDistro && !extras[d.name] && !extrasBusy.has(d.name) && !extrasFailed.has(d.name)) loadExtras(d.name)
    }
  }, [distros, extras, extrasBusy, extrasFailed, loadExtras, busyDistro])

  // Uptime and disk use change while this page is hidden. WslView only shows it again once the
  // running flags are current, so this cannot boot a stopped distro.
  const shownBefore = useRef(false)
  useEffect(() => {
    if (shownBefore.current) {
      for (const d of distros) if (d.running && d.name !== busyDistro) loadExtras(d.name)
    }
    shownBefore.current = true
  }, []) // eslint-disable-line

  // The probe runs a command inside the distro, so it would reboot one that is mid-stop: leave the
  // busy distro out of the poll set. The probe itself takes about 1 s (jiffies delta).
  const runningKey = distros.filter(d => d.running && d.name !== busyDistro).map(d => d.name).join('|')
  const poll = useCallback(async () => {
    const running = runningKey ? runningKey.split('|') : []
    if (running.length === 0) return
    const results = await Promise.all(running.map(async name => {
      try { return { name, s: await api.wslDistroStats(name) } } catch { return null }
    }))
    setStatHistory(prev => {
      const next = new Map(prev)
      for (const k of next.keys()) if (!running.includes(k)) next.delete(k)
      for (const r of results) {
        if (!r) continue
        const h = next.get(r.name) ?? { cpu: [], mem: [] }
        next.set(r.name, {
          cpu: [...h.cpu.slice(-14), r.s.cpu_pct],
          mem: [...h.mem.slice(-14), r.s.mem_used_bytes],
        })
      }
      return next
    })
  }, [runningKey])

  useEffect(() => {
    if (!runningKey) { setStatHistory(new Map()); return }
    poll()
  }, [runningKey, poll])
  useVisiblePoll(poll, 10_000, !!runningKey)

  const driveLetters = [...new Set(distros.filter(d => d.vhd_path).map(d => d.vhd_path.slice(0, 1).toUpperCase()))].join('|')
  useEffect(() => {
    if (!driveLetters) return
    for (const letter of driveLetters.split('|')) {
      getDiskStats(`${letter}:\\`)
        .then(s => setDrives(prev => ({ ...prev, [letter]: s })))
        .catch(() => {})
    }
  }, [driveLetters])

  const busy = busyAction !== null || busyDistro !== null
  const op = useAsyncAction()

  // Opening a card may change the active distro. Card action buttons never touch the selection.
  const openDistro = (name: string) => { setSelected(name); setWslView('distro') }

  const openTerminal = (d: WslDistro) => {
    addActivity({ module: 'wsl', action: `Opened terminal · ${d.name}`, outcome: 'info' })
    return api.wslOpenTerminal(d.name).catch(() => {})
  }

  const runImport = () => op.run(async () => {
    const name = importName.trim()
    if (!importTar || !name || !importDir || useAppStore.getState().wslBusyDistro) return
    setImporting(true); setBusyDistro(name); setImportErr(null)
    try {
      await api.wslImportDistro(name, importDir, importTar)
      addActivity({ module: 'wsl', action: `Imported ${name}`, outcome: 'success' })
      setShowImport(false); setImportTar(''); setImportName(''); setImportDir('')
      await onReload()
    } catch (e) {
      setImportErr(String(e))
      addActivity({ module: 'wsl', action: `Import ${name}`, outcome: 'failure', detail: String(e) })
    } finally { setImporting(false); setBusyDistro(null) }
  })

  const runLifecycle = (l: Lifecycle) => op.run(async () => {
    if (useAppStore.getState().wslBusyDistro) return
    const { d, action } = l
    setLifecycle(null); setBusyAction(d.name); setBusyDistro(d.name)
    try {
      if (action === 'stop') await api.wslTerminateDistro(d.name)
      else await api.wslRestartDistro(d.name)
      addActivity({ module: 'wsl', action: `${action === 'stop' ? 'Stopped' : 'Restarted'} ${d.name}`, outcome: 'success' })
      setExtras(prev => { const n = { ...prev }; delete n[d.name]; return n })
      await onReload()
    } catch (e) {
      addActivity({ module: 'wsl', action: `${action === 'stop' ? 'Stop' : 'Restart'} ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyAction(null); setBusyDistro(null) }
  })

  const runStart = (d: WslDistro) => op.run(async () => {
    setBusyAction(d.name); setBusyDistro(d.name)
    try {
      await api.wslStartDistro(d.name)
      addActivity({ module: 'wsl', action: `Started ${d.name}`, outcome: 'success' })
      await onReload()
    } catch (e) {
      addActivity({ module: 'wsl', action: `Start ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyAction(null); setBusyDistro(null) }
  })

  const totalVhd   = distros.reduce((s, d) => s + d.vhd_size_bytes, 0)
  const scanned    = distros.filter(d => extras[d.name] && extras[d.name].disk_used_bytes > 0 && d.vhd_size_bytes > 0)
  const reclaimable = scanned.reduce((s, d) => s + Math.max(0, d.vhd_size_bytes - extras[d.name].disk_used_bytes), 0)
  // Operations only: terminal-opened info entries would drown out the real ones.
  const wslActivity = activityLog.filter(a => a.module === 'wsl' && a.outcome !== 'info').slice(0, 6)

  // One stable colour per distro (registry order) shared by the charts and the
  // disk bars, so a distro is the same colour everywhere.
  const palette = useMemo(() => getChartColors(), [theme]) // eslint-disable-line react-hooks/exhaustive-deps
  const colorOf = useCallback(
    (name: string) => palette[Math.max(0, distros.findIndex(d => d.name === name)) % palette.length],
    [palette, distros],
  )

  const monItems = useMemo(
    () => distros
      .filter(d => statHistory.has(d.name))
      .map(d => {
        const h = statHistory.get(d.name)!
        return { name: d.name, cpu: h.cpu, mem: h.mem, color: colorOf(d.name) }
      }),
    [distros, statHistory, colorOf],
  )

  const driveGroups = useMemo(() => {
    const groups = new Map<string, WslDistro[]>()
    for (const d of distros) {
      if (!d.vhd_path || d.vhd_size_bytes <= 0) continue
      const letter = d.vhd_path.slice(0, 1).toUpperCase()
      groups.set(letter, [...(groups.get(letter) ?? []), d])
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [distros])
  const multiDrive = driveGroups.length > 1

  const filtered = distros.filter(d => {
    if (filter === 'running' && !d.running) return false
    if (filter === 'stopped' && d.running) return false
    const q = query.trim().toLowerCase()
    return !q || d.name.toLowerCase().includes(q)
  })

  if (distros.length === 0) {
    return (
      <EmptyState
        icon={HardDrive}
        title="No distros installed"
        description="WSL itself is installed, but there is nothing to run in it yet. Install one from the catalog, or run the command below."
        actions={<code className="cmd">wsl --install -d Ubuntu</code>}
      />
    )
  }

  return (
    <div className="wsl-home">
      <Toolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search distros"
          label="Search distros by name"
        />
        <FilterSegments label="Filter by state" options={STATE_FILTERS} value={filter} onChange={setFilter} />
      </Toolbar>

      {filtered.length === 0 ? (
        <EmptyState
          title="No distros match"
          description="Try a shorter search, or switch the filter back to All."
          actions={<Button onClick={() => { setQuery(''); setFilter('all') }}>Clear filters</Button>}
        />
      ) : (
        <div className="wsl-home-grid">
          {filtered.map(d => (
            <DistroCard
              key={d.name}
              d={d}
              x={extras[d.name]}
              scanning={extrasBusy.has(d.name)}
              scanFailed={extrasFailed.has(d.name)}
              busy={busy}
              busyAction={busyAction}
              onOpen={() => openDistro(d.name)}
              onScan={() => Promise.resolve(loadExtras(d.name)).then(() => onReload())}
              onTerminal={() => openTerminal(d)}
              onReveal={() => api.revealPath(d.vhd_path).catch(() => {})}
              onStart={() => runStart(d)}
              onStop={() => setLifecycle({ d, action: 'stop' })}
              onRestart={() => setLifecycle({ d, action: 'restart' })}
            />
          ))}
        </div>
      )}

      <div className="wsl-bpanel wsl-home-panel">
        <div className="wsl-bpanel-head">
          <Activity size={13} /><span>Resource monitoring</span>
          <span className="wsl-live-pill" style={{ marginLeft: 'auto' }}>
            <span className="wsl-live-dot" />Live · every 10s
          </span>
        </div>
        {monItems.length === 0 ? (
          distros.some(d => d.running) ? (
            // The first sample (about 1 s) has not landed yet, so show a skeleton rather than a misleading
            // "no data" notice.
            <div className="wsl-mon-skeleton">
              <div className="sk-box wsl-mon-sk" />
              <div className="sk-box wsl-mon-sk" />
            </div>
          ) : (
            <p className="wsl-bpanel-empty">No distros are running. Start one to see live metrics.</p>
          )
        ) : (
          <>
            <LiveMetricsCharts items={monItems} stepSecs={10} />
            <p className="wsl-bpanel-note">Per-distro process totals; all WSL2 distros share one VM and kernel.</p>
          </>
        )}
      </div>

      {driveGroups.length > 0 && (
        <div className="wsl-bpanel wsl-home-panel">
          <div className="wsl-bpanel-head"><HardDrive size={13} /><span>Disk usage</span></div>

          <div className="drive-bars-grid">
            {driveGroups.map(([letter, ds]) => {
              const stats = drives[letter]
              const used = stats ? stats.total_bytes - stats.free_bytes : 0
              const vhdSum = ds.reduce((s, d) => s + d.vhd_size_bytes, 0)
              const other = stats ? Math.max(0, used - vhdSum) : 0
              return (
                <DriveBar
                  key={letter}
                  title={stats ? stats.drive_label : `${letter}:`}
                  stats={stats}
                  segments={[
                    ...ds.map(d => ({ key: d.name, label: d.name, bytes: d.vhd_size_bytes, color: colorOf(d.name) })),
                    ...(other > 0 && stats ? [{ key: 'other', label: 'Other apps', bytes: other, className: 'disk-seg--other' }] : []),
                    ...(stats ? [{ key: 'free', label: 'Free', bytes: stats.free_bytes, className: 'disk-seg--free' }] : []),
                  ]}
                />
              )
            })}
          </div>

          <div className="disk-legend">
            {[...distros].filter(d => d.vhd_size_bytes > 0).sort((a, b) => b.vhd_size_bytes - a.vhd_size_bytes).map(d => {
              const x = extras[d.name]
              const est = x && x.disk_used_bytes > 0 ? Math.max(0, d.vhd_size_bytes - x.disk_used_bytes) : 0
              return (
                <div key={d.name} className="disk-legend-row">
                  <span className="disk-legend-dot" style={{ background: colorOf(d.name) }} />
                  <span className="disk-legend-label">
                    {d.name}
                    {multiDrive && <span className="disk-legend-drive-note">{d.vhd_path.slice(0, 2)}</span>}
                  </span>
                  <span className="disk-legend-size">{bytesToHuman(d.vhd_size_bytes)}</span>
                  {est > 0 && <span className="disk-legend-free">{bytesToHuman(est)} reclaimable (est.)</span>}
                </div>
              )
            })}
            <div className="disk-legend-row disk-legend-row--key">
              <span className="disk-legend-dot disk-legend-dot--other" />
              <span className="disk-legend-label">Other apps &amp; system</span>
            </div>
            <div className="disk-legend-row disk-legend-row--key">
              <span className="disk-legend-dot disk-legend-dot--free" />
              <span className="disk-legend-label">Free space</span>
            </div>
          </div>

          <div className="disk-summary">
            <span>WSL: <strong>{bytesToHuman(totalVhd)}</strong></span>
            {scanned.length > 0 && reclaimable > 0 && (
              <span className="disk-summary-free">≈ {bytesToHuman(reclaimable)} reclaimable (est.)</span>
            )}
            <span className="disk-summary-note" title="VHD sizes from the Lxss registry; usage scanned inside running distros">
              via registry + df
            </span>
          </div>
        </div>
      )}

      <div className="wsl-home-bottom">
        <div className="wsl-bpanel">
          <div className="wsl-bpanel-head"><History size={13} /><span>Recent WSL activity</span></div>
          {wslActivity.length === 0 ? (
            <p className="wsl-bpanel-empty">No WSL operations yet. Actions you run will appear here.</p>
          ) : (
            <ul className="activity-list">
              {wslActivity.map(a => (
                <li key={a.id} className="activity-row">
                  <span className={clsx('activity-dot', `activity-dot--${a.outcome}`)} />
                  <div className="activity-main">
                    <span className="activity-action" title={a.action}>{a.action}</span>
                    {a.detail && <button className="activity-detail" onClick={() => setActivityDetail(a)} aria-label={`View details: ${a.action}`}>{a.detail}</button>}
                  </div>
                  <span className="activity-time">{timeAgo(a.ts)}</span>
                </li>
              ))}
            </ul>
          )}
          {activityDetail && <OutputDialog title={activityDetail.action} onClose={() => setActivityDetail(null)}>
            <OutputText text={activityDetail.detail ?? ''} />
          </OutputDialog>}
        </div>

        <div className="wsl-bpanel">
          <div className="wsl-bpanel-head">
            <Settings2 size={13} /><span>Resource limits</span>
            <button className="wsl-link" onClick={() => setWslView('wslconfig')}>Edit</button>
          </div>
          <div className="wsl-blimits">
            <div className="wsl-blimit"><span>Memory cap</span><strong className={limits.memory ? '' : 'wsl-blimit-default'}>{limits.memory ?? 'none (default)'}</strong></div>
            <div className="wsl-blimit"><span>Processor cap</span><strong className={limits.processors ? '' : 'wsl-blimit-default'}>{limits.processors ?? 'none (default)'}</strong></div>
            <div className="wsl-blimit"><span>Swap cap</span><strong className={limits.swap ? '' : 'wsl-blimit-default'}>{limits.swap ?? 'none (default)'}</strong></div>
          </div>
          <p className="wsl-bpanel-note">From <code>.wslconfig</code>, applies to the whole WSL2 VM.</p>
        </div>
      </div>

      {lifecycle && (
        <Modal
          icon={lifecycle.action === 'stop' ? <Square size={16} /> : <RotateCw size={16} />} iconWarning
          title={`${lifecycle.action === 'stop' ? 'Stop' : 'Restart'} ${lifecycle.d.name}?`}
          onClose={() => setLifecycle(null)}
        >
          <p className="modal-body">
            This runs <code>wsl --terminate {lifecycle.d.name}</code>, stopping every process inside it immediately.
            {lifecycle.action === 'restart' ? ' It then starts the distro again.' : ' It stays stopped until next use.'}
          </p>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setLifecycle(null)}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={() => runLifecycle(lifecycle)}>
              {lifecycle.action === 'stop' ? <><Square size={13} /> Stop</> : <><RotateCw size={13} /> Restart</>}
            </button>
          </div>
        </Modal>
      )}

      {showImport && (
        <Modal icon={<Upload size={16} />} title="Import distro" onClose={() => setShowImport(false)} blocking={importing}>
          <p className="modal-body">Create a new distro from a <code>.tar</code> archive. Use a new name to clone, or a new location to relocate.</p>
          <Field label="Source archive">
            <div className="wsl-import-row">
              <input className="settings-dir-input" aria-label="Source archive" value={importTar} readOnly placeholder="Choose a .tar file…" />
              <button className="settings-dir-btn" disabled={importing} onClick={async () => { const p = await api.pickTarFile(); if (p) setImportTar(p) }}>Browse…</button>
            </div>
          </Field>
          <Field label="New distro name">
            <input className="settings-dir-input" aria-label="New distro name" value={importName} onChange={e => setImportName(e.target.value)} placeholder="e.g. Ubuntu-Dev" spellCheck={false} disabled={importing} />
          </Field>
          <Field label="Install location">
            <div className="wsl-import-row">
              <input className="settings-dir-input" aria-label="Install location" value={importDir} readOnly placeholder="Choose a folder…" />
              <button className="settings-dir-btn" disabled={importing} onClick={async () => { const p = await api.pickDirectory(); if (p) setImportDir(p) }}>Browse…</button>
            </div>
          </Field>
          {importErr && <div className="settings-status settings-status--error" role="alert">{importErr}</div>}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setShowImport(false)} disabled={importing}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={runImport} disabled={importing || !importTar || !importName.trim() || !importDir}>
              <Upload size={13} /> {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function DistroCard({
  d, x, scanning, scanFailed, busy, busyAction,
  onOpen, onScan, onTerminal, onReveal, onStart, onStop, onRestart,
}: {
  d: WslDistro
  x?: DistroExtras
  scanning: boolean
  scanFailed: boolean
  busy: boolean
  busyAction: string | null
  onOpen: () => void
  onScan: () => void
  onTerminal: () => void
  onReveal: () => void
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}) {
  const term = useAsyncAction()
  return (
    <div className="wsl-bcard">
      <button className="wsl-bcard-head" onClick={onOpen} title="Open this distro's page">
        <DistroLogo name={d.name} size={30} dimmed={!d.running} />
        <span className="wsl-bcard-name">{d.name}</span>
        {d.is_default && <Star size={11} className="wsl-distro-star" />}
        <span className={clsx('wsl-state-pill', d.running ? 'wsl-state-pill--running' : 'wsl-state-pill--stopped')}>
          <span className="wsl-state-pill-dot" />{d.running ? 'Running' : 'Stopped'}
        </span>
        <span className="wsl-bcard-open"><ChevronRight size={14} /></span>
      </button>

      <div className="wsl-bcard-stats">
        <div className="wsl-bstat">
          <span className="wsl-bstat-k">VHD</span>
          <span className="wsl-bstat-v">{d.vhd_size_bytes > 0 ? bytesToHuman(d.vhd_size_bytes) : '-'}</span>
        </div>
        <div className="wsl-bstat">
          <span className="wsl-bstat-k">Packages</span>
          <span
            className="wsl-bstat-v"
            title={
              x ? (x.package_manager === 'unknown' ? 'No supported package manager detected' : x.package_manager)
              : scanFailed ? 'Scan unavailable for this distro'
              : undefined
            }
          >
            {x ? (x.package_manager === 'unknown' ? '-' : x.package_count)
              : scanning ? <span className="sk-line wsl-bstat-sk" />
              : d.running ? '-'
              : <button className="btn btn--sm" onClick={onScan} title="Reads inside the distro and starts it if stopped">Scan</button>}
          </span>
        </div>
        <div className="wsl-bstat">
          <span className="wsl-bstat-k">Uptime</span>
          <span className="wsl-bstat-v">{x ? formatDuration(x.uptime_secs) : scanning ? '…' : '-'}</span>
        </div>
        <div className="wsl-bstat">
          <span className="wsl-bstat-k">Version</span>
          <span className="wsl-bstat-v">WSL {d.version === 1 ? '1' : '2'}</span>
        </div>
      </div>

      {d.vhd_path && (
        <button className="wsl-bcard-path" onClick={onReveal} title="Show ext4.vhdx in Explorer">
          <HardDrive size={12} />
          <span className="wsl-bcard-path-text">{d.vhd_path}</span>
        </button>
      )}

      <div className="wsl-bcard-actions">
        {d.running ? (
          <>
            <button className="btn-secondary btn-sm" onClick={onRestart} disabled={busy} title="Stop, then start again">
              <RotateCw size={12} /> {busyAction === d.name ? 'Working…' : 'Restart'}
            </button>
            <button className="btn-secondary btn-sm" onClick={onStop} disabled={busy} title="Stop this distro">
              <Square size={12} /> Stop
            </button>
          </>
        ) : (
          <button className="btn-secondary btn-sm" onClick={onStart} disabled={busy} title="Start this distro">
            <Play size={12} /> {busyAction === d.name ? 'Starting…' : 'Start'}
          </button>
        )}
        <button className="btn-secondary btn-sm wsl-bcard-primary" onClick={() => term.run(onTerminal)} disabled={term.pending || busy} title="Open a terminal in this distro">
          <Terminal size={12} /> Terminal
        </button>
      </div>
    </div>
  )
}
