import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import type { DockerNetwork } from '../types'

/** Format an ISO date string as relative ("3 months ago") for recent dates,
 *  or a short absolute date for older ones. */
function fmtDate(raw: string): string {
  if (!raw) return '—'
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw   // fallback: return as-is
  const diffMs  = Date.now() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 60)   return diffMin <= 1 ? 'just now' : `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24)     return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 30)     return `${diffD}d ago`
  const diffMo = Math.floor(diffD / 30)
  if (diffMo < 12)    return `${diffMo} month${diffMo !== 1 ? 's' : ''} ago`
  const diffY = Math.floor(diffMo / 12)
  return `${diffY} year${diffY !== 1 ? 's' : ''} ago`
}

// Built-in Docker networks that cannot (and should not) be removed.
const PROTECTED = new Set(['bridge', 'host', 'none'])

function ScopeBadge({ scope }: { scope: string }) {
  if (scope === 'local')  return <span className="badge badge-idle">local</span>
  if (scope === 'swarm')  return <span className="badge badge-paused">swarm</span>
  if (scope === 'global') return <span className="badge badge-running">global</span>
  return <span className="badge badge-idle">{scope}</span>
}

export default function NetworksTab() {
  const [networks, setNetworks]       = useState<DockerNetwork[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [search, setSearch]           = useState('')
  const [confirmId, setConfirmId]     = useState<string | null>(null)
  const [busy, setBusy]               = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setError(null)
    try { setNetworks(await api.dockerNetworks()) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const doRemove = async (id: string) => {
    setBusy(id); setConfirmId(null); setActionError(null)
    try {
      await api.dockerNetworkRemove(id)
      setNetworks(prev => prev.filter(n => n.id !== id))
    } catch (e) {
      setActionError(String(e))
    } finally { setBusy(null) }
  }

  const filtered = networks.filter(n => {
    const q = search.toLowerCase()
    return !q || n.name.toLowerCase().includes(q) || n.driver.toLowerCase().includes(q)
  })

  if (loading) return <div className="img-loading">Loading networks…</div>

  return (
    <div className="img-tab">
      <div className="img-toolbar">
        <input
          className="img-search"
          type="search"
          placeholder="Filter by name or driver…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span className="img-count">
          {filtered.length} network{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {error && (
        <div className="error-banner" style={{ marginBottom: 0 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {actionError && (
        <div className="error-banner" style={{ marginBottom: 0 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{actionError}</span>
        </div>
      )}

      {filtered.length === 0 && !error && (
        <p className="empty-state">No networks found.</p>
      )}

      <div className="img-table-wrap">
        <table className="img-table">
          <thead>
            <tr>
              <th className="img-th">Name</th>
              <th className="img-th">Driver</th>
              <th className="img-th">Scope</th>
              <th className="img-th">Created</th>
              <th className="img-th ctr-th-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(n => {
              const isProtected  = PROTECTED.has(n.name)
              const isBusy       = busy === n.id
              const isConfirming = confirmId === n.id

              return (
                <tr key={n.id} className="img-row">
                  <td className="img-td">
                    <div className="net-name-row">
                      <span className={clsx('img-repo', isProtected && 'net-protected-name')}>
                        {n.name}
                      </span>
                      {n.internal && <span className="badge badge-paused net-inline-flag">internal</span>}
                      {n.ipv6     && <span className="badge badge-created net-inline-flag">IPv6</span>}
                    </div>
                    <span className="img-colon net-id-hint" title={n.id}>
                      {n.id.slice(0, 12)}
                    </span>
                  </td>
                  <td className="img-td img-age">{n.driver}</td>
                  <td className="img-td"><ScopeBadge scope={n.scope} /></td>
                  <td className="img-td img-age">{fmtDate(n.created)}</td>
                  <td className="img-td ctr-td-actions">
                    {isProtected ? (
                      <span className="img-colon" title="Built-in network — cannot be removed">—</span>
                    ) : isConfirming ? (
                      <button
                        className="ctr-action-btn ctr-action-confirm"
                        onClick={() => doRemove(n.id)}
                        disabled={isBusy}
                        title="Confirm removal"
                      >
                        <Trash2 size={12} /><span>?</span>
                      </button>
                    ) : (
                      <button
                        className="ctr-action-btn ctr-action-remove"
                        onClick={() => { setConfirmId(n.id); setActionError(null) }}
                        disabled={isBusy}
                        title="Remove network"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
