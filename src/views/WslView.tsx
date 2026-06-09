import { useCallback, useEffect, useState } from 'react'
import { HardDrive, RefreshCw, FolderOpen, Star, Disc3, Boxes, Settings2, Zap, ShieldAlert, Download, Upload, X } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../store/appStore'
import * as api from '../features/wsl/api'
import type { WslStatus, WslDistro, OptimizeResult } from '../features/wsl/types'
import { bytesToHuman } from '../utils/format'
import WslConfigTab from '../features/wsl/components/WslConfigTab'

type WslTab = 'distros' | 'config'

export default function WslView() {
  const addActivity = useAppStore(s => s.addActivity)

  const [status, setStatus]   = useState<WslStatus | null>(null)
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [tab, setTab]         = useState<WslTab>('distros')

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
          <button className={clsx('wsl-tab', tab === 'distros' && 'active')} onClick={() => setTab('distros')}>
            <Boxes size={13} /> Distributions
          </button>
          <button className={clsx('wsl-tab', tab === 'config' && 'active')} onClick={() => setTab('config')}>
            <Settings2 size={13} /> .wslconfig
          </button>
        </div>
      )}

      {available && tab === 'config' && (
        <WslConfigTab
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
                </div>

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
    </div>
  )
}
