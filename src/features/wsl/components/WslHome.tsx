import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  Star, SquareTerminal, Terminal, ChevronRight, Search, HardDrive,
  RotateCw, Square, Play, Upload, Settings2, History,
} from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import { readWslConfig } from '../api'
import { getIniValue } from '../ini'
import type { WslDistro, DistroExtras } from '../types'
import { bytesToHuman, formatDuration, timeAgo } from '../../../utils/format'
import { Modal, Field } from './Dialog'

type StateFilter = 'all' | 'running' | 'stopped'
type Lifecycle = { d: WslDistro; action: 'stop' | 'restart' }

export default function WslHome({ distros, loading, onReload }: {
  distros: WslDistro[]
  loading: boolean
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

  // .wslconfig caps for the limits panel (machine-wide).
  const [limits, setLimits] = useState<{ memory?: string; processors?: string; swap?: string }>({})

  // ── Import dialog ──────────────────────────────────────────────────────────
  const [showImport, setShowImport] = useState(false)
  const [importTar, setImportTar]   = useState('')
  const [importName, setImportName] = useState('')
  const [importDir, setImportDir]   = useState('')
  const [importing, setImporting]   = useState(false)
  const [importErr, setImportErr]   = useState<string | null>(null)

  // ── Per-distro extras (packages, uptime, disk usage) ────────────────────────
  const [extras, setExtras]             = useState<Record<string, DistroExtras>>({})
  const [extrasBusy, setExtrasBusy]     = useState<Set<string>>(() => new Set())
  const [extrasFailed, setExtrasFailed] = useState<Set<string>>(() => new Set())

  // ── Lifecycle ────────────────────────────────────────────────────────────
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [lifecycle, setLifecycle]   = useState<Lifecycle | null>(null)

  // Header "Import distro" button opens the dialog via the store flag.
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

  // Auto-scan running distros once; never boot a stopped one silently.
  useEffect(() => {
    for (const d of distros) {
      if (d.running && !extras[d.name] && !extrasBusy.has(d.name) && !extrasFailed.has(d.name)) loadExtras(d.name)
    }
  }, [distros, extras, extrasBusy, extrasFailed, loadExtras])

  const busy = busyAction !== null

  // Explicit navigation: opening a card IS allowed to change the active distro.
  // Card action buttons never touch the selection (decoupling contract).
  const openDistro = (name: string) => { setSelected(name); setWslView('distro') }

  const openTerminal = (d: WslDistro) => {
    api.wslOpenTerminal(d.name).catch(() => {})
    addActivity({ module: 'wsl', action: `Opened terminal · ${d.name}`, outcome: 'info' })
  }

  const runImport = async () => {
    const name = importName.trim()
    if (!importTar || !name || !importDir) return
    setImporting(true); setImportErr(null)
    try {
      await api.wslImportDistro(name, importDir, importTar)
      addActivity({ module: 'wsl', action: `Imported ${name}`, outcome: 'success' })
      setShowImport(false); setImportTar(''); setImportName(''); setImportDir('')
      await onReload()
    } catch (e) {
      setImportErr(String(e))
      addActivity({ module: 'wsl', action: `Imported ${name}`, outcome: 'failure', detail: String(e) })
    } finally { setImporting(false) }
  }

  const runLifecycle = async (l: Lifecycle) => {
    const { d, action } = l
    setLifecycle(null); setBusyAction(d.name)
    try {
      if (action === 'stop') await api.wslTerminateDistro(d.name)
      else await api.wslRestartDistro(d.name)
      addActivity({ module: 'wsl', action: `${action === 'stop' ? 'Stopped' : 'Restarted'} ${d.name}`, outcome: 'success' })
      setExtras(prev => { const n = { ...prev }; delete n[d.name]; return n })
      await onReload()
    } catch (e) {
      addActivity({ module: 'wsl', action: `${action} ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyAction(null) }
  }

  const runStart = async (d: WslDistro) => {
    setBusyAction(d.name)
    try {
      await api.wslStartDistro(d.name)
      addActivity({ module: 'wsl', action: `Started ${d.name}`, outcome: 'success' })
      await onReload()
    } catch (e) {
      addActivity({ module: 'wsl', action: `Start ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyAction(null) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const runningCnt = distros.filter(d => d.running).length
  const stoppedCnt = distros.length - runningCnt
  const totalVhd   = distros.reduce((s, d) => s + d.vhd_size_bytes, 0)
  const scanned    = distros.filter(d => extras[d.name] && extras[d.name].disk_used_bytes > 0 && d.vhd_size_bytes > 0)
  const reclaimable = scanned.reduce((s, d) => s + Math.max(0, d.vhd_size_bytes - extras[d.name].disk_used_bytes), 0)
  const defaultDistro = distros.find(d => d.is_default)
  // Operations only: terminal-opened info entries would drown out the real ones.
  const wslActivity = activityLog.filter(a => a.module === 'wsl' && a.outcome !== 'info').slice(0, 6)

  const filtered = distros.filter(d => {
    if (filter === 'running' && !d.running) return false
    if (filter === 'stopped' && d.running) return false
    const q = query.trim().toLowerCase()
    return !q || d.name.toLowerCase().includes(q)
  })

  if (!loading && distros.length === 0) {
    return (
      <p className="empty-state" style={{ marginTop: 8 }}>
        WSL is installed but no distributions were found. Install one with <code>wsl --install -d Ubuntu</code>.
      </p>
    )
  }

  return (
    <div className="wsl-home">
      {/* ── Summary tiles ───────────────────────────────────────────── */}
      <div className="wsl-tiles">
        <div className="hero-tile">
          <span className="hero-tile-label">Distributions</span>
          <span className="hero-tile-value hero-tile-value--text">{distros.length}</span>
          <span className="hero-tile-sub">
            {stoppedCnt > 0 ? `${runningCnt} running · ${stoppedCnt} stopped` : 'all running'}
          </span>
        </div>
        <div className="hero-tile">
          <span className="hero-tile-label">On disk</span>
          <span className="hero-tile-value hero-tile-value--text">{totalVhd > 0 ? bytesToHuman(totalVhd) : '--'}</span>
          <span className="hero-tile-sub">total VHD size</span>
        </div>
        <div className="hero-tile">
          <span className="hero-tile-label">Reclaimable</span>
          <span className="hero-tile-value hero-tile-value--text">{scanned.length > 0 ? `≈ ${bytesToHuman(reclaimable)}` : '--'}</span>
          <span className="hero-tile-sub">
            {scanned.length > 0 ? `estimated from ${scanned.length} scan${scanned.length !== 1 ? 's' : ''}` : 'scan a distro to estimate'}
          </span>
        </div>
        <div className="hero-tile">
          <span className="hero-tile-label">Default</span>
          <span className="hero-tile-value hero-tile-value--text">{defaultDistro?.name ?? '--'}</span>
          <span className="hero-tile-sub">
            {defaultDistro ? `WSL ${defaultDistro.version === 1 ? '1' : '2'} · ${defaultDistro.running ? 'running' : 'stopped'}` : 'none set'}
          </span>
        </div>
      </div>

      {/* ── Search + filter ─────────────────────────────────────────── */}
      <div className="wsl-distros-toolbar">
        <div className="wsl-distros-search">
          <Search size={14} className="wsl-distros-search-icon" />
          <input
            className="wsl-distros-search-input"
            placeholder="Find a distribution…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="wsl-seg">
          {(['all', 'running', 'stopped'] as StateFilter[]).map(f => (
            <button key={f} className={clsx('wsl-seg-btn', filter === f && 'wsl-seg-btn--active')} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Stopped'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Distro cards ────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <p className="empty-state" style={{ marginTop: 8 }}>No distributions match.</p>
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
              onScan={() => loadExtras(d.name)}
              onTerminal={() => openTerminal(d)}
              onReveal={() => api.revealPath(d.vhd_path).catch(() => {})}
              onStart={() => runStart(d)}
              onStop={() => setLifecycle({ d, action: 'stop' })}
              onRestart={() => setLifecycle({ d, action: 'restart' })}
            />
          ))}
        </div>
      )}

      {/* ── Activity + limits ───────────────────────────────────────── */}
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
                  <span className="activity-action">{a.action}</span>
                  {a.detail && <span className="activity-detail">{a.detail}</span>}
                  <span className="activity-time">{timeAgo(a.ts)}</span>
                </li>
              ))}
            </ul>
          )}
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

      {/* ── Modals ──────────────────────────────────────────────────── */}
      {lifecycle && (
        <Modal
          icon={lifecycle.action === 'stop' ? <Square size={16} /> : <RotateCw size={16} />} iconWarning
          title={`${lifecycle.action === 'stop' ? 'Stop' : 'Restart'} ${lifecycle.d.name}?`}
          onClose={() => setLifecycle(null)}
        >
          <p className="modal-body">
            This runs <code>wsl --terminate {lifecycle.d.name}</code>, stopping every process inside it immediately.
            {lifecycle.action === 'restart' ? ' It then boots the distro straight back up.' : ' It stays stopped until next use.'}
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
        <Modal icon={<Upload size={16} />} title="Import distribution" onClose={() => setShowImport(false)} closable>
          <p className="modal-body">Create a new distro from a <code>.tar</code> archive. Use a new name to clone, or a new location to relocate.</p>
          <Field label="Source archive">
            <div className="wsl-import-row">
              <input className="settings-dir-input" value={importTar} readOnly placeholder="Choose a .tar file…" />
              <button className="settings-dir-btn" onClick={async () => { const p = await api.pickTarFile(); if (p) setImportTar(p) }}>Browse…</button>
            </div>
          </Field>
          <Field label="New distro name">
            <input className="settings-dir-input" value={importName} onChange={e => setImportName(e.target.value)} placeholder="e.g. Ubuntu-Dev" spellCheck={false} />
          </Field>
          <Field label="Install location">
            <div className="wsl-import-row">
              <input className="settings-dir-input" value={importDir} readOnly placeholder="Choose a folder…" />
              <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setImportDir(p) }}>Browse…</button>
            </div>
          </Field>
          {importErr && <div className="settings-status settings-status--error">{importErr}</div>}
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

// ── Distro card ───────────────────────────────────────────────────────────────
// Lean by design: lifecycle + terminal only. Management actions (files, export,
// clone, migrate, optimize) live on the distribution's own page.

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
  return (
    <div className="wsl-bcard">
      <button className="wsl-bcard-head" onClick={onOpen} title="Open this distribution's page">
        <span className={clsx('wsl-distro-tile', !d.running && 'wsl-distro-tile--off')}><SquareTerminal size={15} /></span>
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
          <span className="wsl-bstat-v">{d.vhd_size_bytes > 0 ? bytesToHuman(d.vhd_size_bytes) : '--'}</span>
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
            {x ? (x.package_manager === 'unknown' ? '--' : x.package_count)
              : scanning ? '…'
              : d.running ? '--'
              : <button className="wsl-scan-btn" onClick={onScan} title="Reads inside the distro and starts it if stopped">Scan</button>}
          </span>
        </div>
        <div className="wsl-bstat">
          <span className="wsl-bstat-k">Uptime</span>
          <span className="wsl-bstat-v">{x ? formatDuration(x.uptime_secs) : scanning ? '…' : '--'}</span>
        </div>
        <div className="wsl-bstat">
          <span className="wsl-bstat-k">Version</span>
          <span className="wsl-bstat-v">WSL {d.version === 1 ? '1' : '2'}</span>
        </div>
      </div>

      {d.vhd_path && (
        <button className="wsl-bcard-path" onClick={onReveal} title="Reveal ext4.vhdx in Explorer">
          <HardDrive size={12} />
          <span className="wsl-bcard-path-text">{d.vhd_path}</span>
        </button>
      )}

      <div className="wsl-bcard-actions">
        {d.running ? (
          <>
            <button className="btn-secondary btn-sm" onClick={onRestart} disabled={busy} title="Stop, then boot back up">
              <RotateCw size={12} /> {busyAction === d.name ? 'Working…' : 'Restart'}
            </button>
            <button className="btn-secondary btn-sm" onClick={onStop} disabled={busy} title="Terminate this distro">
              <Square size={12} /> Stop
            </button>
          </>
        ) : (
          <button className="btn-secondary btn-sm" onClick={onStart} disabled={busy} title="Boot this distro">
            <Play size={12} /> {busyAction === d.name ? 'Starting…' : 'Start'}
          </button>
        )}
        <button className="btn-secondary btn-sm wsl-bcard-primary" onClick={onTerminal} title="Open a terminal in this distro">
          <Terminal size={12} /> Terminal
        </button>
      </div>
    </div>
  )
}
