import { useCallback, useEffect, useState } from 'react'
import { HardDrive, RefreshCw, FolderOpen, Star, Disc3, Boxes, Settings2, FileCog, Zap, ShieldAlert, Download, Upload, X, LayoutDashboard, Copy, RotateCw, FolderInput } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../store/appStore'
import * as api from '../features/wsl/api'
import type { WslStatus, WslDistro, OptimizeResult, DistroExtras } from '../features/wsl/types'
import { bytesToHuman, formatDuration } from '../utils/format'
import { useDistroSelection } from '../features/wsl/hooks'
import WslDashboardTab from '../features/wsl/components/WslDashboardTab'
import WslConfigTab from '../features/wsl/components/WslConfigTab'
import WslConfTab from '../features/wsl/components/WslConfTab'

type WslTab = 'dashboard' | 'distros' | 'config' | 'conf'

export default function WslView() {
  const addActivity = useAppStore(s => s.addActivity)

  const [status, setStatus]   = useState<WslStatus | null>(null)
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [tab, setTab]         = useState<WslTab>('dashboard')
  const [selected, setSelected] = useDistroSelection(distros)

  // ── VHD optimization (per distro) ────────────────────────────────────────
  const [confirmOpt, setConfirmOpt] = useState<WslDistro | null>(null)
  const [optName, setOptName]       = useState<string | null>(null)
  const [optResults, setOptResults] = useState<Record<string, OptimizeResult>>({})
  const [optError, setOptError]     = useState<Record<string, string>>({})

  // ── Export / import (.tar) ───────────────────────────────────────────────
  const [exportName, setExportName] = useState<string | null>(null)
  const [exportInfo, setExportInfo] = useState<Record<string, string>>({})
  const [exportErr, setExportErr]   = useState<Record<string, string>>({})
  const [showImport, setShowImport] = useState(false)
  const [importTar, setImportTar]   = useState('')
  const [importName, setImportName] = useState('')
  const [importDir, setImportDir]   = useState('')
  const [importing, setImporting]   = useState(false)
  const [importErr, setImportErr]   = useState<string | null>(null)

  // ── Comparison extras (package count + uptime, per distro) ───────────────
  const [extras, setExtras]             = useState<Record<string, DistroExtras>>({})
  const [extrasBusy, setExtrasBusy]     = useState<Set<string>>(() => new Set())

  // ── Restart / clone / migrate ────────────────────────────────────────────
  const [busyAction, setBusyAction]     = useState<string | null>(null)
  const [confirmRestart, setConfirmRestart] = useState<WslDistro | null>(null)
  const [cloneFor, setCloneFor]         = useState<WslDistro | null>(null)
  const [cloneName, setCloneName]       = useState('')
  const [cloneDir, setCloneDir]         = useState('')
  const [cloneErr, setCloneErr]         = useState<string | null>(null)
  const [migrateFor, setMigrateFor]     = useState<WslDistro | null>(null)
  const [migrateDir, setMigrateDir]     = useState('')
  const [migrateErr, setMigrateErr]     = useState<string | null>(null)
  const [migrateInfo, setMigrateInfo]   = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const st = await api.wslCheck()
      setStatus(st)
      if (st.available) {
        setDistros(await api.wslListDistros())
      } else {
        setDistros([])
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const runOptimize = async (d: WslDistro) => {
    setConfirmOpt(null)
    setOptName(d.name)
    setOptError(prev => { const n = { ...prev }; delete n[d.name]; return n })
    try {
      const r = await api.wslOptimizeVhd(d.vhd_path)
      setOptResults(prev => ({ ...prev, [d.name]: r }))
      addActivity({ module: 'wsl', action: `Optimized ${d.name}`, outcome: 'success', detail: `reclaimed ${bytesToHuman(r.reclaimed_bytes)}` })
      await load()
    } catch (e) {
      setOptError(prev => ({ ...prev, [d.name]: String(e) }))
      addActivity({ module: 'wsl', action: `Optimized ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally {
      setOptName(null)
    }
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
    } finally {
      setExportName(null)
    }
  }

  const runImport = async () => {
    const name = importName.trim()
    if (!importTar || !name || !importDir) return
    setImporting(true)
    setImportErr(null)
    try {
      await api.wslImportDistro(name, importDir, importTar)
      addActivity({ module: 'wsl', action: `Imported ${name}`, outcome: 'success' })
      setShowImport(false)
      setImportTar(''); setImportName(''); setImportDir('')
      await load()
    } catch (e) {
      setImportErr(String(e))
      addActivity({ module: 'wsl', action: `Imported ${name}`, outcome: 'failure', detail: String(e) })
    } finally {
      setImporting(false)
    }
  }

  const loadExtras = useCallback(async (name: string) => {
    setExtrasBusy(prev => new Set(prev).add(name))
    try {
      const x = await api.wslDistroExtras(name)
      setExtras(prev => ({ ...prev, [name]: x }))
    } catch {
      // Leave as "—"; the comparison table tolerates missing extras.
    } finally {
      setExtrasBusy(prev => { const n = new Set(prev); n.delete(name); return n })
    }
  }, [])

  // Auto-fetch package count + uptime for running distros (reading a stopped one
  // would boot it, so those stay "—" until the user clicks Scan).
  useEffect(() => {
    for (const d of distros) {
      if (d.running && !extras[d.name] && !extrasBusy.has(d.name)) loadExtras(d.name)
    }
  }, [distros, extras, extrasBusy, loadExtras])

  const runRestart = async (d: WslDistro) => {
    setConfirmRestart(null)
    setBusyAction(d.name)
    try {
      await api.wslTerminateDistro(d.name)
      addActivity({ module: 'wsl', action: `Restarted ${d.name}`, outcome: 'success' })
      setExtras(prev => { const n = { ...prev }; delete n[d.name]; return n })
      await load()
    } catch (e) {
      addActivity({ module: 'wsl', action: `Restarted ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally {
      setBusyAction(null)
    }
  }

  const runClone = async () => {
    if (!cloneFor) return
    const name = cloneName.trim()
    if (!name || !cloneDir) return
    setBusyAction(cloneFor.name)
    setCloneErr(null)
    try {
      await api.wslCloneDistro(cloneFor.name, name, cloneDir)
      addActivity({ module: 'wsl', action: `Cloned ${cloneFor.name} → ${name}`, outcome: 'success' })
      setCloneFor(null); setCloneName(''); setCloneDir('')
      await load()
    } catch (e) {
      setCloneErr(String(e))
      addActivity({ module: 'wsl', action: `Cloned ${cloneFor.name}`, outcome: 'failure', detail: String(e) })
    } finally {
      setBusyAction(null)
    }
  }

  const runMigrate = async () => {
    if (!migrateFor || !migrateDir) return
    const d = migrateFor
    setBusyAction(d.name)
    setMigrateErr(null)
    try {
      const r = await api.wslMigrateDistro(d.name, migrateDir, d.is_default)
      setMigrateInfo(prev => ({ ...prev, [d.name]: `Migrated. Backup kept at ${r.backup_tar}` }))
      addActivity({ module: 'wsl', action: `Migrated ${d.name}`, outcome: 'success', detail: migrateDir })
      setMigrateFor(null); setMigrateDir('')
      await load()
    } catch (e) {
      setMigrateErr(String(e))
      addActivity({ module: 'wsl', action: `Migrated ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally {
      setBusyAction(null)
    }
  }

  const available  = status?.available ?? false
  const totalVhd   = distros.reduce((sum, d) => sum + d.vhd_size_bytes, 0)
  const runningCnt = distros.filter(d => d.running).length

  return (
    <div className="view-container">
      <div className="view-header">
        <div className="view-header-icon"><HardDrive size={18} /></div>
        <div style={{ flex: 1 }}>
          <div className="view-header-title-row">
            <h1 className="view-title">WSL2 Optimizer</h1>
            {status && (
              <>
                <span className={clsx('status-dot', available ? 'online' : 'offline')} />
                <span className="status-text">
                  {available
                    ? `${distros.length} distro${distros.length !== 1 ? 's' : ''}${runningCnt ? ` · ${runningCnt} running` : ''}`
                    : 'not installed'}
                </span>
              </>
            )}
          </div>
          <p className="view-subtitle">Compact VHDs, manage distros, and reclaim disk space</p>
        </div>
        <button className="btn-refresh" onClick={load} disabled={loading} title="Refresh">
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="error-banner" style={{ marginTop: 20 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {!loading && status && !available && (
        <div className="offline-card" style={{ marginTop: 20 }}>
          <p className="offline-title">WSL is not installed</p>
          <p className="offline-desc">
            The Windows Subsystem for Linux is required for this module.
            Install it from an elevated terminal, then click Refresh.
          </p>
          <code className="offline-code">wsl --install</code>
        </div>
      )}

      {available && (
        <div className="wsl-tabs">
          <button className={clsx('wsl-tab', tab === 'dashboard' && 'active')} onClick={() => setTab('dashboard')}>
            <LayoutDashboard size={13} /> Dashboard
          </button>
          <button className={clsx('wsl-tab', tab === 'distros' && 'active')} onClick={() => setTab('distros')}>
            <Boxes size={13} /> Distributions
          </button>
          <button className={clsx('wsl-tab', tab === 'config' && 'active')} onClick={() => setTab('config')}>
            <Settings2 size={13} /> .wslconfig
          </button>
          <button className={clsx('wsl-tab', tab === 'conf' && 'active')} onClick={() => setTab('conf')}>
            <FileCog size={13} /> wsl.conf
          </button>
        </div>
      )}

      {available && tab === 'dashboard' && (
        <WslDashboardTab distros={distros} selected={selected} onSelect={setSelected} />
      )}

      {available && tab === 'config' && (
        <WslConfigTab
          runningNames={distros.filter(d => d.running).map(d => d.name)}
          onAfterShutdown={load}
        />
      )}

      {available && tab === 'conf' && (
        <WslConfTab
          distros={distros}
          runningNames={distros.filter(d => d.running).map(d => d.name)}
          onAfterShutdown={load}
        />
      )}

      {available && tab === 'distros' && !loading && distros.length === 0 && (
        <p className="empty-state" style={{ marginTop: 24 }}>
          WSL is installed but no distributions were found. Install one with <code>wsl --install -d Ubuntu</code>.
        </p>
      )}

      {available && tab === 'distros' && distros.length > 0 && (
        <>
          <div className="wsl-summary">
            <span>{bytesToHuman(totalVhd)} total on disk</span>
            <button className="btn-secondary wsl-import-btn" onClick={() => { setImportErr(null); setShowImport(true) }}>
              <Upload size={13} /> Import distro
            </button>
          </div>

          <div className="wsl-compare-wrap">
            <table className="wsl-compare">
              <thead>
                <tr>
                  <th>Distribution</th>
                  <th>WSL</th>
                  <th>State</th>
                  <th className="wsl-compare-num">VHD size</th>
                  <th className="wsl-compare-num">Packages</th>
                  <th className="wsl-compare-num">Uptime</th>
                </tr>
              </thead>
              <tbody>
                {distros.map(d => {
                  const x = extras[d.name]
                  return (
                    <tr key={d.name}>
                      <td>
                        <span className="wsl-compare-name">{d.name}</span>
                        {d.is_default && <Star size={9} className="wsl-compare-star" />}
                      </td>
                      <td>{d.version === 1 ? 'WSL1' : 'WSL2'}</td>
                      <td>
                        <span className={clsx('wsl-state', d.running ? 'wsl-state--running' : 'wsl-state--stopped')}>
                          <span className="wsl-state-dot" />
                          {d.running ? 'Running' : 'Stopped'}
                        </span>
                      </td>
                      <td className="wsl-compare-num">{d.vhd_size_bytes > 0 ? bytesToHuman(d.vhd_size_bytes) : '—'}</td>
                      <td className="wsl-compare-num">
                        {x ? `${x.package_count} (${x.package_manager})`
                          : extrasBusy.has(d.name) ? '…'
                          : d.running ? '—'
                          : <button className="wsl-scan-btn" onClick={() => loadExtras(d.name)} title="Reads inside the distro — starts it if stopped">Scan</button>}
                      </td>
                      <td className="wsl-compare-num">{x ? formatDuration(x.uptime_secs) : extrasBusy.has(d.name) ? '…' : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="wsl-distro-grid">
            {distros.map(d => (
              <div key={d.name} className={clsx('wsl-distro-card', d.running && 'wsl-distro-card--running')}>
                <div className="wsl-distro-head">
                  <Disc3 size={15} className="wsl-distro-icon" />
                  <span className="wsl-distro-name">{d.name}</span>
                  {d.is_default && (
                    <span className="wsl-badge wsl-badge--default" title="Default distro">
                      <Star size={9} /> default
                    </span>
                  )}
                  <span className="wsl-badge">{d.version === 1 ? 'WSL1' : 'WSL2'}</span>
                  <span className={clsx('wsl-state', d.running ? 'wsl-state--running' : 'wsl-state--stopped')}>
                    <span className="wsl-state-dot" />
                    {d.running ? 'Running' : 'Stopped'}
                  </span>
                </div>

                <div className="wsl-distro-size">
                  <span className="wsl-distro-size-val">
                    {d.vhd_size_bytes > 0 ? bytesToHuman(d.vhd_size_bytes) : '—'}
                  </span>
                  <span className="wsl-distro-size-label">virtual disk</span>
                </div>

                {d.vhd_path && (
                  <button
                    className="wsl-distro-path"
                    onClick={() => api.revealPath(d.vhd_path).catch(() => {})}
                    title="Reveal ext4.vhdx in Explorer"
                  >
                    <FolderOpen size={12} />
                    <span className="wsl-distro-path-text">{d.vhd_path}</span>
                  </button>
                )}

                <div className="wsl-distro-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => runExport(d)}
                    disabled={exportName !== null || optName !== null}
                    title="Export this distro to a .tar archive"
                  >
                    <Download size={12} />
                    {exportName === d.name ? 'Exporting…' : 'Export'}
                  </button>
                  {d.version === 2 && d.vhd_path && (
                    <button
                      className="btn-secondary wsl-optimize-btn"
                      onClick={() => setConfirmOpt(d)}
                      disabled={optName !== null || exportName !== null}
                      title="Compact the virtual disk — requires administrator approval"
                    >
                      <Zap size={12} />
                      {optName === d.name ? 'Optimizing…' : 'Optimize'}
                      <ShieldAlert size={11} className="btn-admin-badge" />
                    </button>
                  )}
                  {d.running && (
                    <button
                      className="btn-secondary"
                      onClick={() => setConfirmRestart(d)}
                      disabled={busyAction !== null || exportName !== null || optName !== null}
                      title="Terminate this distro (it restarts on next use)"
                    >
                      <RotateCw size={12} />
                      {busyAction === d.name ? 'Working…' : 'Restart'}
                    </button>
                  )}
                  <button
                    className="btn-secondary"
                    onClick={() => { setCloneErr(null); setCloneName(`${d.name}-clone`); setCloneDir(''); setCloneFor(d) }}
                    disabled={busyAction !== null || exportName !== null || optName !== null}
                    title="Clone this distro under a new name"
                  >
                    <Copy size={12} /> Clone
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => { setMigrateErr(null); setMigrateDir(''); setMigrateFor(d) }}
                    disabled={busyAction !== null || exportName !== null || optName !== null}
                    title="Move this distro to another drive or folder"
                  >
                    <FolderInput size={12} /> Migrate
                  </button>
                </div>

                {migrateInfo[d.name] && busyAction !== d.name && (
                  <p className="wsl-opt-result">{migrateInfo[d.name]}</p>
                )}

                {exportInfo[d.name] && exportName !== d.name && (
                  <p className="wsl-opt-result">{exportInfo[d.name]}</p>
                )}
                {exportErr[d.name] && exportName !== d.name && (
                  <p className="wsl-opt-error">{exportErr[d.name]}</p>
                )}

                {optName === d.name && (
                  <p className="wsl-opt-progress">Approve the UAC prompt to compact the disk…</p>
                )}
                {optResults[d.name] && optName !== d.name && (
                  <p className="wsl-opt-result">
                    Reclaimed {bytesToHuman(optResults[d.name].reclaimed_bytes)}
                    <span className="wsl-opt-delta">
                      {' '}({bytesToHuman(optResults[d.name].before_bytes)} → {bytesToHuman(optResults[d.name].after_bytes)} · {optResults[d.name].method})
                    </span>
                  </p>
                )}
                {optError[d.name] && optName !== d.name && (
                  <p className="wsl-opt-error">{optError[d.name]}</p>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {confirmOpt && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap warning"><ShieldAlert size={16} /></div>
              <h2 className="modal-title">Optimize {confirmOpt.name}?</h2>
            </div>
            <p className="modal-body">
              This compacts <code>ext4.vhdx</code> to reclaim unused space. It shuts down
              <strong> all WSL distributions</strong> and requires <strong>administrator approval</strong>.
              {runningCnt > 0
                ? <> Running now: <strong>{distros.filter(d => d.running).map(d => d.name).join(', ')}</strong>.</>
                : ' No distributions are currently running.'}
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmOpt(null)}>Cancel</button>
              <button className="btn-filled btn-filled--accent" onClick={() => runOptimize(confirmOpt)}>
                <Zap size={13} /> Optimize
              </button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap"><Upload size={16} /></div>
              <h2 className="modal-title">Import distribution</h2>
              <button className="modal-close" onClick={() => setShowImport(false)} title="Close"><X size={14} /></button>
            </div>
            <p className="modal-body">
              Create a new distro from a <code>.tar</code> archive. Use a new name to clone,
              or a new location to relocate.
            </p>

            <div className="wsl-import-field">
              <label className="wsl-import-label">Source archive</label>
              <div className="wsl-import-row">
                <input className="settings-dir-input" value={importTar} readOnly placeholder="Choose a .tar file…" />
                <button className="settings-dir-btn" onClick={async () => { const p = await api.pickTarFile(); if (p) setImportTar(p) }}>Browse…</button>
              </div>
            </div>

            <div className="wsl-import-field">
              <label className="wsl-import-label">New distro name</label>
              <input
                className="settings-dir-input"
                value={importName}
                onChange={e => setImportName(e.target.value)}
                placeholder="e.g. Ubuntu-Dev"
                spellCheck={false}
              />
            </div>

            <div className="wsl-import-field">
              <label className="wsl-import-label">Install location</label>
              <div className="wsl-import-row">
                <input className="settings-dir-input" value={importDir} readOnly placeholder="Choose a folder…" />
                <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setImportDir(p) }}>Browse…</button>
              </div>
            </div>

            {importErr && <div className="settings-status settings-status--error">{importErr}</div>}

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowImport(false)} disabled={importing}>Cancel</button>
              <button
                className="btn-filled btn-filled--accent"
                onClick={runImport}
                disabled={importing || !importTar || !importName.trim() || !importDir}
              >
                <Upload size={13} /> {importing ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRestart && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap warning"><RotateCw size={16} /></div>
              <h2 className="modal-title">Restart {confirmRestart.name}?</h2>
            </div>
            <p className="modal-body">
              This terminates <strong>{confirmRestart.name}</strong> (<code>wsl --terminate</code>). Any
              running processes inside it stop immediately; it relaunches on next use.
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmRestart(null)}>Cancel</button>
              <button className="btn-filled btn-filled--accent" onClick={() => runRestart(confirmRestart)}>
                <RotateCw size={13} /> Restart
              </button>
            </div>
          </div>
        </div>
      )}

      {cloneFor && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap"><Copy size={16} /></div>
              <h2 className="modal-title">Clone {cloneFor.name}</h2>
              <button className="modal-close" onClick={() => setCloneFor(null)} title="Close"><X size={14} /></button>
            </div>
            <p className="modal-body">
              Export <strong>{cloneFor.name}</strong> and re-import it as an independent copy. The source
              distro is left unchanged.
            </p>

            <div className="wsl-import-field">
              <label className="wsl-import-label">New distro name</label>
              <input
                className="settings-dir-input"
                value={cloneName}
                onChange={e => setCloneName(e.target.value)}
                placeholder="e.g. workstation-kali-clone"
                spellCheck={false}
              />
            </div>

            <div className="wsl-import-field">
              <label className="wsl-import-label">Install location</label>
              <div className="wsl-import-row">
                <input className="settings-dir-input" value={cloneDir} readOnly placeholder="Choose a folder…" />
                <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setCloneDir(p) }}>Browse…</button>
              </div>
            </div>

            {cloneErr && <div className="settings-status settings-status--error">{cloneErr}</div>}

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setCloneFor(null)} disabled={busyAction === cloneFor.name}>Cancel</button>
              <button
                className="btn-filled btn-filled--accent"
                onClick={runClone}
                disabled={busyAction === cloneFor.name || !cloneName.trim() || !cloneDir}
              >
                <Copy size={13} /> {busyAction === cloneFor.name ? 'Cloning…' : 'Clone'}
              </button>
            </div>
          </div>
        </div>
      )}

      {migrateFor && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap warning"><FolderInput size={16} /></div>
              <h2 className="modal-title">Migrate {migrateFor.name}</h2>
              <button className="modal-close" onClick={() => setMigrateFor(null)} title="Close"><X size={14} /></button>
            </div>
            <p className="modal-body">
              Move <strong>{migrateFor.name}</strong> to another drive or folder. The flow is safe: it
              exports a <code>.tar</code> backup, imports + boot-verifies the copy at the new location, and
              only then unregisters the original. The <strong>backup is kept</strong> as a rollback artifact.
            </p>

            <div className="wsl-import-field">
              <label className="wsl-import-label">Destination folder</label>
              <div className="wsl-import-row">
                <input className="settings-dir-input" value={migrateDir} readOnly placeholder="Choose a folder on the target drive…" />
                <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setMigrateDir(p) }}>Browse…</button>
              </div>
            </div>

            {migrateErr && <div className="settings-status settings-status--error">{migrateErr}</div>}

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setMigrateFor(null)} disabled={busyAction === migrateFor.name}>Cancel</button>
              <button
                className="btn-filled btn-filled--accent"
                onClick={runMigrate}
                disabled={busyAction === migrateFor.name || !migrateDir}
              >
                <FolderInput size={13} /> {busyAction === migrateFor.name ? 'Migrating…' : 'Migrate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
