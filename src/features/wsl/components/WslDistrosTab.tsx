import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  Star, SquareTerminal, Terminal, FolderOpen, MoreHorizontal, ChevronRight, ChevronDown,
  Search, HardDrive, RotateCw, Square, Play, Download, Copy, ArrowRightLeft, Zap, ShieldAlert,
  Upload, X,
} from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import type { WslDistro, OptimizeResult, DistroExtras } from '../types'
import { bytesToHuman, formatDuration } from '../../../utils/format'

type StateFilter = 'all' | 'running' | 'stopped'
type Lifecycle = { d: WslDistro; action: 'stop' | 'restart' }

export default function WslDistrosTab({ distros, loading, onReload }: {
  distros: WslDistro[]
  loading: boolean
  onReload: () => Promise<void> | void
}) {
  const addActivity     = useAppStore(s => s.addActivity)
  const selected        = useAppStore(s => s.wslSelectedDistro)
  const setSelected     = useAppStore(s => s.setWslSelectedDistro)
  const importOpen      = useAppStore(s => s.wslImportOpen)
  const setImportOpen   = useAppStore(s => s.setWslImportOpen)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [query, setQuery]       = useState('')
  const [filter, setFilter]     = useState<StateFilter>('all')

  // ── VHD optimization ───────────────────────────────────────────────────────
  const [confirmOpt, setConfirmOpt] = useState<WslDistro | null>(null)
  const [optName, setOptName]       = useState<string | null>(null)
  const [optResults, setOptResults] = useState<Record<string, OptimizeResult>>({})
  const [optError, setOptError]     = useState<Record<string, string>>({})

  // ── Export / import ────────────────────────────────────────────────────────
  const [exportName, setExportName] = useState<string | null>(null)
  const [exportInfo, setExportInfo] = useState<Record<string, string>>({})
  const [exportErr, setExportErr]   = useState<Record<string, string>>({})
  const [showImport, setShowImport] = useState(false)
  const [importTar, setImportTar]   = useState('')
  const [importName, setImportName] = useState('')
  const [importDir, setImportDir]   = useState('')
  const [importing, setImporting]   = useState(false)
  const [importErr, setImportErr]   = useState<string | null>(null)

  // ── Comparison extras (package count + uptime + disk) ───────────────────────
  const [extras, setExtras]             = useState<Record<string, DistroExtras>>({})
  const [extrasBusy, setExtrasBusy]     = useState<Set<string>>(() => new Set())
  const [extrasFailed, setExtrasFailed] = useState<Set<string>>(() => new Set())

  // ── Lifecycle / clone / migrate ─────────────────────────────────────────────
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [lifecycle, setLifecycle]   = useState<Lifecycle | null>(null)
  const [cloneFor, setCloneFor]   = useState<WslDistro | null>(null)
  const [cloneName, setCloneName] = useState('')
  const [cloneDir, setCloneDir]   = useState('')
  const [cloneErr, setCloneErr]   = useState<string | null>(null)
  const [migrateFor, setMigrateFor] = useState<WslDistro | null>(null)
  const [migrateDir, setMigrateDir] = useState('')
  const [migrateErr, setMigrateErr] = useState<string | null>(null)
  const [migrateInfo, setMigrateInfo] = useState<Record<string, string>>({})

  // Header "Import distro" button opens the dialog via the store flag.
  useEffect(() => {
    if (importOpen) { setImportErr(null); setShowImport(true); setImportOpen(false) }
  }, [importOpen, setImportOpen])

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

  useEffect(() => {
    for (const d of distros) {
      if (d.running && !extras[d.name] && !extrasBusy.has(d.name) && !extrasFailed.has(d.name)) loadExtras(d.name)
    }
  }, [distros, extras, extrasBusy, extrasFailed, loadExtras])

  const busy = optName !== null || exportName !== null || busyAction !== null

  // ── Actions ──────────────────────────────────────────────────────────────
  const openTerminal = (d: WslDistro) => {
    api.wslOpenTerminal(d.name).catch(() => {})
    addActivity({ module: 'wsl', action: `Opened terminal · ${d.name}`, outcome: 'info' })
  }
  const openFolder = (d: WslDistro) => api.wslOpenDistroFolder(d.name).catch(() => {})

  const runOptimize = async (d: WslDistro) => {
    setConfirmOpt(null); setOptName(d.name)
    setOptError(prev => { const n = { ...prev }; delete n[d.name]; return n })
    try {
      const r = await api.wslOptimizeVhd(d.vhd_path)
      setOptResults(prev => ({ ...prev, [d.name]: r }))
      addActivity({ module: 'wsl', action: `Optimized ${d.name}`, outcome: 'success', detail: `reclaimed ${bytesToHuman(r.reclaimed_bytes)}` })
      await onReload()
    } catch (e) {
      setOptError(prev => ({ ...prev, [d.name]: String(e) }))
      addActivity({ module: 'wsl', action: `Optimized ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setOptName(null) }
  }

  const runExport = async (d: WslDistro) => {
    setExportName(d.name)
    setExportErr(prev => { const n = { ...prev }; delete n[d.name]; return n })
    try {
      const r = await api.wslExportDistro(d.name)
      if (r) {
        setExportInfo(prev => ({ ...prev, [d.name]: `Exported to ${r.path} (${bytesToHuman(r.size_bytes)})` }))
        addActivity({ module: 'wsl', action: `Exported ${d.name}`, outcome: 'success', detail: bytesToHuman(r.size_bytes) })
      }
    } catch (e) {
      setExportErr(prev => ({ ...prev, [d.name]: String(e) }))
      addActivity({ module: 'wsl', action: `Exported ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setExportName(null) }
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

  const runClone = async () => {
    if (!cloneFor) return
    const name = cloneName.trim()
    if (!name || !cloneDir) return
    setBusyAction(cloneFor.name); setCloneErr(null)
    try {
      await api.wslCloneDistro(cloneFor.name, name, cloneDir, cloneFor.version)
      addActivity({ module: 'wsl', action: `Cloned ${cloneFor.name} → ${name}`, outcome: 'success' })
      setCloneFor(null); setCloneName(''); setCloneDir('')
      await onReload()
    } catch (e) {
      setCloneErr(String(e))
      addActivity({ module: 'wsl', action: `Cloned ${cloneFor.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyAction(null) }
  }

  const runMigrate = async () => {
    if (!migrateFor || !migrateDir) return
    const d = migrateFor
    setBusyAction(d.name); setMigrateErr(null)
    try {
      const r = await api.wslMigrateDistro(d.name, migrateDir, d.is_default, d.base_path, d.version)
      setMigrateInfo(prev => ({ ...prev, [d.name]: `Migrated. Backup kept at ${r.backup_tar}` }))
      addActivity({ module: 'wsl', action: `Migrated ${d.name}`, outcome: 'success', detail: migrateDir })
      setMigrateFor(null); setMigrateDir('')
      await onReload()
    } catch (e) {
      setMigrateErr(String(e))
      addActivity({ module: 'wsl', action: `Migrated ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyAction(null) }
  }

  const totalVhd = distros.reduce((sum, d) => sum + d.vhd_size_bytes, 0)
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
    <div className="wsl-distros-tab">
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
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
        <div className="wsl-distros-toolbar-right">
          <div className="wsl-seg">
            {(['all', 'running', 'stopped'] as StateFilter[]).map(f => (
              <button key={f} className={clsx('wsl-seg-btn', filter === f && 'wsl-seg-btn--active')} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Stopped'}
              </button>
            ))}
          </div>
          <span className="wsl-distros-total"><strong>~{bytesToHuman(totalVhd)}</strong> on disk</span>
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────── */}
      <div className="wsl-dtable-wrap">
        <table className="wsl-dtable">
          <thead>
            <tr>
              <th className="wsl-dtable-chev" />
              <th>Distribution</th>
              <th>State</th>
              <th>WSL version</th>
              <th className="wsl-dtable-num">VHD size</th>
              <th className="wsl-dtable-num">Packages</th>
              <th className="wsl-dtable-num">Uptime</th>
              <th className="wsl-dtable-act">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="wsl-dtable-empty">No distributions match.</td></tr>
            )}
            {filtered.map(d => {
              const x = extras[d.name]
              const isOpen = expanded === d.name
              const scanning = extrasBusy.has(d.name)
              return (
                <DistroRow
                  key={d.name}
                  d={d} x={x} scanning={scanning} isOpen={isOpen}
                  isSelected={selected === d.name} busy={busy}
                  optName={optName} exportName={exportName} busyAction={busyAction}
                  optResult={optResults[d.name]} optErr={optError[d.name]}
                  exportInfo={exportInfo[d.name]} exportErrText={exportErr[d.name]}
                  migrateInfo={migrateInfo[d.name]}
                  onToggle={() => { setSelected(d.name); setExpanded(prev => (prev === d.name ? null : d.name)) }}
                  onScan={() => loadExtras(d.name)}
                  onTerminal={() => openTerminal(d)}
                  onFolder={() => openFolder(d)}
                  onExport={() => runExport(d)}
                  onOptimize={() => setConfirmOpt(d)}
                  onRestart={() => setLifecycle({ d, action: 'restart' })}
                  onStop={() => setLifecycle({ d, action: 'stop' })}
                  onStart={() => runStart(d)}
                  onClone={() => { setCloneErr(null); setCloneName(`${d.name}-clone`); setCloneDir(''); setCloneFor(d) }}
                  onMigrate={() => { setMigrateErr(null); setMigrateDir(''); setMigrateFor(d) }}
                  onReveal={() => api.revealPath(d.vhd_path).catch(() => {})}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Modals ──────────────────────────────────────────────────── */}
      {confirmOpt && (
        <Modal icon={<ShieldAlert size={16} />} iconWarning title={`Optimize ${confirmOpt.name}?`} onClose={() => setConfirmOpt(null)}>
          <p className="modal-body">
            This compacts <code>ext4.vhdx</code> to reclaim unused space. It shuts down
            <strong> all WSL distributions</strong> and requires <strong>administrator approval</strong>.
          </p>
          {(() => {
            const x = extras[confirmOpt.name]
            if (!x || x.disk_used_bytes === 0) {
              return <p className="wsl-estimate-note">Reclaim estimate unavailable — scan the distro on the table first.</p>
            }
            const est = Math.max(0, confirmOpt.vhd_size_bytes - x.disk_used_bytes)
            return (
              <div className="wsl-estimate">
                <div className="wsl-estimate-row"><span>VHD file on Windows</span><strong>{bytesToHuman(confirmOpt.vhd_size_bytes)}</strong></div>
                <div className="wsl-estimate-row"><span>Actually used inside</span><strong>{bytesToHuman(x.disk_used_bytes)}</strong></div>
                <div className="wsl-estimate-row wsl-estimate-row--accent"><span>Estimated reclaimable</span><strong>≈ {bytesToHuman(est)}</strong></div>
              </div>
            )
          })()}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setConfirmOpt(null)}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={() => runOptimize(confirmOpt)}><Zap size={13} /> Optimize</button>
          </div>
        </Modal>
      )}

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

      {cloneFor && (
        <Modal icon={<Copy size={16} />} title={`Clone ${cloneFor.name}`} onClose={() => setCloneFor(null)} closable>
          <p className="modal-body">Export <strong>{cloneFor.name}</strong> and re-import it as an independent copy. The source distro is left unchanged.</p>
          <Field label="New distro name">
            <input className="settings-dir-input" value={cloneName} onChange={e => setCloneName(e.target.value)} placeholder="e.g. workstation-kali-clone" spellCheck={false} />
          </Field>
          <Field label="Install location">
            <div className="wsl-import-row">
              <input className="settings-dir-input" value={cloneDir} readOnly placeholder="Choose a folder…" />
              <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setCloneDir(p) }}>Browse…</button>
            </div>
          </Field>
          {cloneErr && <div className="settings-status settings-status--error">{cloneErr}</div>}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setCloneFor(null)} disabled={busyAction === cloneFor.name}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={runClone} disabled={busyAction === cloneFor.name || !cloneName.trim() || !cloneDir}>
              <Copy size={13} /> {busyAction === cloneFor.name ? 'Cloning…' : 'Clone'}
            </button>
          </div>
        </Modal>
      )}

      {migrateFor && (
        <Modal icon={<ArrowRightLeft size={16} />} iconWarning title={`Migrate ${migrateFor.name}`} onClose={() => setMigrateFor(null)} closable>
          <p className="modal-body">
            Move <strong>{migrateFor.name}</strong> to another drive or folder. The flow is safe: it exports a
            <code> .tar</code> backup, imports + boot-verifies the copy at the new location, and only then unregisters
            the original. The <strong>backup is kept</strong> as a rollback artifact.
          </p>
          <Field label="Destination folder">
            <div className="wsl-import-row">
              <input className="settings-dir-input" value={migrateDir} readOnly placeholder="Choose a folder on the target drive…" />
              <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setMigrateDir(p) }}>Browse…</button>
            </div>
          </Field>
          {migrateErr && <div className="settings-status settings-status--error">{migrateErr}</div>}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setMigrateFor(null)} disabled={busyAction === migrateFor.name}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={runMigrate} disabled={busyAction === migrateFor.name || !migrateDir}>
              <ArrowRightLeft size={13} /> {busyAction === migrateFor.name ? 'Migrating…' : 'Migrate'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Row ─────────────────────────────────────────────────────────────────────

function DistroRow({
  d, x, scanning, isOpen, isSelected, busy, optName, exportName, busyAction,
  optResult, optErr, exportInfo, exportErrText, migrateInfo,
  onToggle, onScan, onTerminal, onFolder, onExport, onOptimize, onRestart, onStop, onStart, onClone, onMigrate, onReveal,
}: {
  d: WslDistro
  x?: DistroExtras
  scanning: boolean
  isOpen: boolean
  isSelected: boolean
  busy: boolean
  optName: string | null
  exportName: string | null
  busyAction: string | null
  optResult?: OptimizeResult
  optErr?: string
  exportInfo?: string
  exportErrText?: string
  migrateInfo?: string
  onToggle: () => void
  onScan: () => void
  onTerminal: () => void
  onFolder: () => void
  onExport: () => void
  onOptimize: () => void
  onRestart: () => void
  onStop: () => void
  onStart: () => void
  onClone: () => void
  onMigrate: () => void
  onReveal: () => void
}) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  return (
    <>
      <tr className={clsx('wsl-dtable-row', isOpen && 'wsl-dtable-row--open', isSelected && !isOpen && 'wsl-dtable-row--selected')} onClick={onToggle}>
        <td className="wsl-dtable-chev">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
        <td>
          <div className="wsl-distro-name-cell">
            <span className={clsx('wsl-distro-tile', !d.running && 'wsl-distro-tile--off')}><SquareTerminal size={15} /></span>
            <span className="wsl-distro-name2">{d.name}</span>
            {d.is_default && <Star size={11} className="wsl-distro-star" />}
          </div>
        </td>
        <td>
          <span className={clsx('wsl-state-pill', d.running ? 'wsl-state-pill--running' : 'wsl-state-pill--stopped')}>
            <span className="wsl-state-pill-dot" />{d.running ? 'Running' : 'Stopped'}
          </span>
        </td>
        <td><span className="wsl-ver-badge">WSL {d.version === 1 ? '1' : '2'}</span></td>
        <td className="wsl-dtable-num">{d.vhd_size_bytes > 0 ? bytesToHuman(d.vhd_size_bytes) : '--'}</td>
        <td className="wsl-dtable-num" onClick={e => e.stopPropagation()}>
          {x ? `${x.package_count} (${x.package_manager})`
            : scanning ? '…'
            : d.running ? '--'
            : <button className="wsl-scan-btn" onClick={onScan} title="Reads inside the distro — starts it if stopped">Scan</button>}
        </td>
        <td className="wsl-dtable-num">{x ? formatDuration(x.uptime_secs) : scanning ? '…' : '--'}</td>
        <td className="wsl-dtable-act" onClick={e => e.stopPropagation()}>
          <button className="wsl-row-icon" onClick={stop(onTerminal)} title="Open a terminal in this distro"><Terminal size={14} /></button>
          <button className="wsl-row-icon" onClick={stop(onFolder)} title="Open the distro’s files in Explorer (\\wsl.localhost)"><FolderOpen size={14} /></button>
          <button className={clsx('wsl-row-icon', isOpen && 'wsl-row-icon--active')} onClick={stop(onToggle)} title="More actions"><MoreHorizontal size={14} /></button>
        </td>
      </tr>
      {isOpen && (
        <tr className="wsl-dtable-detail">
          <td colSpan={8}>
            <div className="wsl-detail">
              {d.vhd_path && (
                <div className="wsl-detail-block">
                  <span className="wsl-detail-label">Storage location</span>
                  <button className="wsl-detail-path" onClick={onReveal} title="Reveal ext4.vhdx in Explorer">
                    <HardDrive size={13} />
                    <span className="wsl-detail-path-text">{d.vhd_path}</span>
                  </button>
                </div>
              )}

              <div className="wsl-detail-groups">
                <div className="wsl-agroup">
                  <span className="wsl-alabel">Lifecycle</span>
                  <div className="wsl-arow">
                    {d.running ? (
                      <>
                        <button className="btn-secondary" onClick={onRestart} disabled={busy} title="Stop, then boot back up">
                          <RotateCw size={13} /> {busyAction === d.name ? 'Working…' : 'Restart'}
                        </button>
                        <button className="btn-secondary" onClick={onStop} disabled={busy} title="Terminate this distro">
                          <Square size={13} /> Stop
                        </button>
                      </>
                    ) : (
                      <button className="btn-secondary" onClick={onStart} disabled={busy} title="Boot this distro">
                        <Play size={13} /> {busyAction === d.name ? 'Starting…' : 'Start'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="wsl-agroup">
                  <span className="wsl-alabel">Transfer &amp; backup</span>
                  <div className="wsl-arow">
                    <button className="btn-secondary" onClick={onExport} disabled={busy} title="Export to a .tar archive">
                      <Download size={13} /> {exportName === d.name ? 'Exporting…' : 'Export'}
                    </button>
                    <button className="btn-secondary" onClick={onClone} disabled={busy} title="Clone under a new name">
                      <Copy size={13} /> Clone
                    </button>
                    <button className="btn-secondary" onClick={onMigrate} disabled={busy} title="Move to another drive or folder">
                      <ArrowRightLeft size={13} /> Migrate
                    </button>
                  </div>
                </div>

                {d.version === 2 && d.vhd_path && (
                  <div className="wsl-agroup">
                    <span className="wsl-alabel">Maintenance</span>
                    <div className="wsl-arow">
                      <button className="wsl-optimize-disk" onClick={onOptimize} disabled={busy} title="Compact the virtual disk — requires administrator approval">
                        <Zap size={13} /> {optName === d.name ? 'Optimizing…' : 'Optimize Disk'}
                        <ShieldAlert size={11} className="btn-admin-badge" />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {optName === d.name && <p className="wsl-opt-progress">Approve the UAC prompt to compact the disk…</p>}
              {optResult && optName !== d.name && (
                <p className="wsl-opt-result">
                  Reclaimed {bytesToHuman(optResult.reclaimed_bytes)}
                  <span className="wsl-opt-delta"> ({bytesToHuman(optResult.before_bytes)} → {bytesToHuman(optResult.after_bytes)} · {optResult.method})</span>
                </p>
              )}
              {optErr && optName !== d.name && <p className="wsl-opt-error">{optErr}</p>}
              {exportInfo && exportName !== d.name && <p className="wsl-opt-result">{exportInfo}</p>}
              {exportErrText && exportName !== d.name && <p className="wsl-opt-error">{exportErrText}</p>}
              {migrateInfo && busyAction !== d.name && <p className="wsl-opt-result">{migrateInfo}</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Small shared bits ─────────────────────────────────────────────────────────

function Modal({ icon, iconWarning, title, onClose, closable, children }: {
  icon: React.ReactNode
  iconWarning?: boolean
  title: string
  onClose: () => void
  closable?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <div className={clsx('modal-icon-wrap', iconWarning && 'warning')}>{icon}</div>
          <h2 className="modal-title">{title}</h2>
          {closable && <button className="modal-close" onClick={onClose} title="Close"><X size={14} /></button>}
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wsl-import-field">
      <label className="wsl-import-label">{label}</label>
      {children}
    </div>
  )
}
