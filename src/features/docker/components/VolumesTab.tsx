import { useState, useMemo } from 'react'
import { Trash2 } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import type { DockerVolume } from '../types'

type UsageFilter = 'all' | 'in-use' | 'unused'

function bytesToHuman(b: number): string {
  if (!b) return '—'
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`
  return `${b} B`
}

export default function VolumesTab({
  volumes,
  loading,
  onRefresh,
}: {
  volumes: DockerVolume[]
  loading: boolean
  onRefresh: () => void
}) {
  const [search, setSearch]           = useState('')
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all')
  const [confirmId, setConfirmId]     = useState<string | null>(null)
  const [busy, setBusy]               = useState<string | null>(null)
  const [pruningAll, setPruningAll]   = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return volumes
      .filter(v => {
        if (usageFilter === 'in-use') return v.in_use
        if (usageFilter === 'unused') return !v.in_use
        return true
      })
      .filter(v => !q || v.name.toLowerCase().includes(q) || v.driver.toLowerCase().includes(q))
  }, [volumes, search, usageFilter])

  const unusedCount = volumes.filter(v => !v.in_use).length

  const doRemove = async (name: string) => {
    setBusy(name)
    setConfirmId(null)
    setActionError(null)
    try {
      await api.dockerVolumeRemove(name)
      onRefresh()
    } catch (e) {
      setActionError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const doPruneAll = async () => {
    setPruningAll(true)
    setActionError(null)
    try {
      await api.dockerVolumesPrune()
      onRefresh()
    } catch (e) {
      setActionError(String(e))
    } finally {
      setPruningAll(false)
    }
  }

  if (loading) return <div className="img-loading">Loading volumes…</div>
  if (!volumes.length) return <p className="empty-state">No volumes found.</p>

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
        <div className="ctr-state-filter">
          {(['all', 'in-use', 'unused'] as UsageFilter[]).map(f => (
            <button
              key={f}
              className={clsx('ctr-filter-btn', usageFilter === f && 'active')}
              onClick={() => setUsageFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        {unusedCount > 0 && (
          <button
            className="btn-prune-unused"
            onClick={doPruneAll}
            disabled={pruningAll}
            title={`Remove all ${unusedCount} unused volumes (docker volume prune -f)`}
          >
            <Trash2 size={11} />
            {pruningAll ? 'Removing…' : `Remove unused (${unusedCount})`}
          </button>
        )}
        <span className="img-count">
          {filtered.length} volume{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {actionError && (
        <div className="error-banner" style={{ marginBottom: 0 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{actionError}</span>
        </div>
      )}

      <div className="img-table-wrap">
        <table className="img-table">
          <thead>
            <tr>
              <th className="img-th">Name</th>
              <th className="img-th">Driver</th>
              <th className="img-th">Size</th>
              <th className="img-th">Status</th>
              <th className="img-th ctr-th-actions">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(v => {
              const isBusy       = busy === v.name
              const isConfirming = confirmId === v.name
              return (
                <tr key={v.name} className="img-row">
                  <td className="img-td">
                    <span className="img-repo">{v.name}</span>
                  </td>
                  <td className="img-td img-age">{v.driver}</td>
                  <td className="img-td img-age">{bytesToHuman(v.size_bytes)}</td>
                  <td className="img-td">
                    {v.in_use
                      ? <span className="badge badge-active">In use</span>
                      : <span className="badge badge-idle">Unused</span>}
                  </td>
                  <td className="img-td ctr-td-actions">
                    {isConfirming ? (
                      <button
                        className="ctr-action-btn ctr-action-confirm"
                        onClick={() => doRemove(v.name)}
                        disabled={isBusy}
                        title="Confirm removal"
                      >
                        <Trash2 size={12} />
                        <span>?</span>
                      </button>
                    ) : (
                      <button
                        className="ctr-action-btn ctr-action-remove"
                        onClick={() => { setConfirmId(v.name); setActionError(null) }}
                        disabled={isBusy || v.in_use}
                        title={v.in_use ? 'Cannot remove: volume is in use' : 'Remove volume'}
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
