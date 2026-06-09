import { useCallback, useEffect, useState } from 'react'
import { HardDrive, RefreshCw, FolderOpen, Star, Disc3, Boxes, Settings2, Zap, ShieldAlert } from 'lucide-react'
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
            <span>{distros.length} distribution{distros.length !== 1 ? 's' : ''}</span>
            <span className="wsl-summary-sep">·</span>
            <span>{bytesToHuman(totalVhd)} total on disk</span>
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

                {d.version === 2 && d.vhd_path && (
                  <div className="wsl-distro-actions">
                    <button
                      className="btn-secondary wsl-optimize-btn"
                      onClick={() => setConfirmOpt(d)}
                      disabled={optName !== null}
                      title="Compact the virtual disk (requires admin)"
                    >
                      <Zap size={12} />
                      {optName === d.name ? 'Optimizing…' : 'Optimize'}
                    </button>
                    <span className="wsl-optimize-shield" title="Requires administrator approval">
                      <ShieldAlert size={12} />
                    </span>
                  </div>
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
              <div className="modal-icon-wrap danger"><ShieldAlert size={16} /></div>
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
    </div>
  )
}
