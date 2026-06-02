import { useState, useMemo } from 'react'
import { Play, Square, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import type { DockerContainer } from '../types'

type SortKey = 'name' | 'image' | 'state' | 'created_since'
type SortDir = 'asc' | 'desc'
type StateFilter = 'all' | 'running' | 'stopped'

function SortHeader({ label, col, sortKey, sortDir, onSort }: {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = col === sortKey
  return (
    <th className={clsx('img-th sortable', active && 'active')} onClick={() => onSort(col)}>
      <span>{label}</span>
      {active
        ? sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
        : <ChevronDown size={12} className="sort-idle" />}
    </th>
  )
}

function StateBadge({ state }: { state: string }) {
  const s = state.toLowerCase()
  if (s === 'running')                  return <span className="badge badge-running">running</span>
  if (s === 'paused')                   return <span className="badge badge-paused">paused</span>
  if (s === 'restarting')               return <span className="badge badge-paused">restarting</span>
  if (s === 'created')                  return <span className="badge badge-created">created</span>
  if (s === 'exited' || s === 'dead')   return <span className="badge badge-idle">{state}</span>
  return <span className="badge badge-idle">{state || 'unknown'}</span>
}

export default function ContainersTab({
  containers,
  loading,
  onRefresh,
}: {
  containers: DockerContainer[]
  loading: boolean
  onRefresh: () => void
}) {
  const [sortKey, setSortKey]           = useState<SortKey>('name')
  const [sortDir, setSortDir]           = useState<SortDir>('asc')
  const [search, setSearch]             = useState('')
  const [stateFilter, setStateFilter]   = useState<StateFilter>('all')
  const [confirmId, setConfirmId]       = useState<string | null>(null)
  const [busy, setBusy]                 = useState<string | null>(null)
  const [actionError, setActionError]   = useState<string | null>(null)

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return [...containers]
      .filter(c => {
        if (stateFilter === 'running') return c.state === 'running'
        if (stateFilter === 'stopped') return c.state !== 'running'
        return true
      })
      .filter(c =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.includes(q)
      )
      .sort((a, b) => {
        const av = a[sortKey]
        const bv = b[sortKey]
        const cmp = av.localeCompare(bv)
        return sortDir === 'asc' ? cmp : -cmp
      })
  }, [containers, sortKey, sortDir, search, stateFilter])

  const doAction = async (id: string, action: 'start' | 'stop' | 'remove') => {
    setBusy(id)
    setConfirmId(null)
    setActionError(null)
    try {
      await api.dockerContainerAction(id, action)
      onRefresh()
    } catch (e) {
      setActionError(String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="img-loading">Loading containers…</div>
  if (!containers.length) return <p className="empty-state">No containers found.</p>

  return (
    <div className="img-tab">
      <div className="img-toolbar">
        <input
          className="img-search"
          type="search"
          placeholder="Filter by name, image, or ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="ctr-state-filter">
          {(['all', 'running', 'stopped'] as StateFilter[]).map(f => (
            <button
              key={f}
              className={clsx('ctr-filter-btn', stateFilter === f && 'active')}
              onClick={() => setStateFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="img-count">
          {filtered.length} container{filtered.length !== 1 ? 's' : ''}
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
              <SortHeader label="Name"    col="name"         sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Image"   col="image"        sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="State"   col="state"        sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <th className="img-th">Status</th>
              <th className="img-th">Ports</th>
              <SortHeader label="Created" col="created_since" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <th className="img-th ctr-th-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const isRunning    = c.state === 'running'
              const isBusy       = busy === c.id
              const isConfirming = confirmId === c.id
              return (
                <tr key={c.id} className="img-row">
                  <td className="img-td">
                    <span className="img-repo">{c.name || <em className="img-colon">unnamed</em>}</span>
                  </td>
                  <td className="img-td img-age">{c.image}</td>
                  <td className="img-td"><StateBadge state={c.state} /></td>
                  <td className="img-td img-age">{c.status}</td>
                  <td className="img-td ctr-ports">{c.ports || <span className="img-colon">—</span>}</td>
                  <td className="img-td img-age">{c.created_since}</td>
                  <td className="img-td ctr-td-actions">
                    {isRunning ? (
                      <button
                        className="ctr-action-btn ctr-action-stop"
                        onClick={() => doAction(c.id, 'stop')}
                        disabled={isBusy}
                        title="Stop container"
                      >
                        <Square size={12} />
                      </button>
                    ) : (
                      <button
                        className="ctr-action-btn ctr-action-start"
                        onClick={() => doAction(c.id, 'start')}
                        disabled={isBusy}
                        title="Start container"
                      >
                        <Play size={12} />
                      </button>
                    )}
                    {isConfirming ? (
                      <button
                        className="ctr-action-btn ctr-action-confirm"
                        onClick={() => doAction(c.id, 'remove')}
                        disabled={isBusy}
                        title="Confirm removal"
                      >
                        <Trash2 size={12} />
                        <span>?</span>
                      </button>
                    ) : (
                      <button
                        className="ctr-action-btn ctr-action-remove"
                        onClick={() => { setConfirmId(c.id); setActionError(null) }}
                        disabled={isBusy || isRunning}
                        title={isRunning ? 'Stop first to remove' : 'Remove container'}
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
