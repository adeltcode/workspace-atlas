import { useCallback, useEffect, useState } from 'react'
import { HardDrive, RefreshCw, FolderOpen, Star, Disc3 } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../features/wsl/api'
import type { WslStatus, WslDistro } from '../features/wsl/types'
import { bytesToHuman } from '../utils/format'

export default function WslView() {
  const [status, setStatus]   = useState<WslStatus | null>(null)
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

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

      {available && !loading && distros.length === 0 && (
        <p className="empty-state" style={{ marginTop: 24 }}>
          WSL is installed but no distributions were found. Install one with <code>wsl --install -d Ubuntu</code>.
        </p>
      )}

      {available && distros.length > 0 && (
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
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
