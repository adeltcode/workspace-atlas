import React, { useState, useMemo, useRef, useEffect } from 'react'
import { Play, Square, Trash2, ChevronUp, ChevronDown, FileText, RefreshCw, X } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import type { DockerContainer } from '../types'

type SortKey    = 'name' | 'image' | 'state' | 'created_since'
type SortDir    = 'asc' | 'desc'
type StateFilter = 'all' | 'running' | 'stopped'

// ── Port chip parser ──────────────────────────────────────────────────────────

interface PortMapping { host: string; container: string; proto: string }

function parsePorts(raw: string): PortMapping[] {
  if (!raw) return []
  const seen = new Set<string>()
  return raw.split(',')
    .map(s => s.trim()).filter(Boolean)
    .flatMap(part => {
      const m = part.match(/(?:[\d.:]+:)?(\d+)->(\d+)\/(tcp|udp|sctp)/i)
      if (!m) return []
      return [{ host: m[1], container: m[2], proto: m[3].toLowerCase() }]
    })
    .filter(p => {
      const key = `${p.host}:${p.container}/${p.proto}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function PortChips({ raw }: { raw: string }) {
  const ports = parsePorts(raw)
  if (!ports.length) return <span className="img-colon">—</span>
  return (
    <div className="ctr-port-chips">
      {ports.map((p, i) => (
        <span key={i} className={clsx('ctr-port-chip', p.proto === 'udp' && 'ctr-port-chip--udp')}>
          {p.host === p.container ? p.host : `${p.host}→${p.container}`}
        </span>
      ))}
    </div>
  )
}

// ── Log viewer ────────────────────────────────────────────────────────────────

function LogViewer({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [lines, setLines]     = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [tail, setTail]       = useState(150)
  const bodyRef = useRef<HTMLDivElement>(null)

  const load = async (t = tail) => {
    setLoading(true); setError(null)
    try {
      const result = await api.dockerContainerLogs(id, t)
      setLines(result)
      requestAnimationFrame(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
      })
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, []) // eslint-disable-line

  const parseLine = (line: string): { ts: string; msg: string } => {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/)
    if (m) return { ts: m[1].slice(11, 23), msg: m[2] }
    return { ts: '', msg: line }
  }

  const isStderr = (msg: string) => {
    const l = msg.toLowerCase()
    return l.includes('[error') || l.includes(' error') || l.includes('[err]') ||
           l.includes('exception') || l.includes('fatal') || l.includes('panic')
  }

  return (
    <div className="log-viewer">
      <div className="log-viewer-header">
        <div className="log-viewer-title">
          <FileText size={12} />
          <span>{name}</span>
          <span className="log-viewer-count">{lines.length} lines</span>
        </div>
        <div className="log-viewer-controls">
          <div className="log-tail-select">
            {([50, 150, 500] as const).map(t => (
              <button key={t} className={clsx('log-tail-btn', tail === t && 'active')}
                onClick={() => { setTail(t); load(t) }} disabled={loading}>
                {t}
              </button>
            ))}
          </div>
          <button className="ctr-action-btn" onClick={() => load()} disabled={loading} title="Refresh logs">
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
          </button>
          <button className="ctr-action-btn" onClick={onClose} title="Close logs">
            <X size={11} />
          </button>
        </div>
      </div>
      <div className="log-viewer-body" ref={bodyRef}>
        {loading && <div className="log-viewer-empty">Loading logs…</div>}
        {error   && <div className="log-viewer-empty log-viewer-error">{error}</div>}
        {!loading && !error && lines.length === 0 && (
          <div className="log-viewer-empty">No log output in last {tail} lines.</div>
        )}
        {!loading && lines.map((line, i) => {
          const { ts, msg } = parseLine(line)
          const isErr = isStderr(msg)
          return (
            <div key={i} className={clsx('log-line', isErr && 'log-line--error')}>
              {ts && <span className="log-ts">{ts}</span>}
              <span className="log-msg">{msg}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Sort header (fixed alignment) ─────────────────────────────────────────────

function SortHeader({ label, col, sortKey, sortDir, onSort }: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = col === sortKey
  return (
    <th className={clsx('img-th img-th-sort', active && 'active')} onClick={() => onSort(col)}>
      <div className="th-sort-inner">
        {label}
        {active
          ? sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />
          : <ChevronDown size={11} className="sort-idle" />}
      </div>
    </th>
  )
}

function StateBadge({ state, sub }: { state: string; sub?: string }) {
  const s     = state.toLowerCase()
  const badge =
    s === 'running'                  ? <span className="badge badge-running">▶ running</span> :
    s === 'paused'                   ? <span className="badge badge-paused">⏸ paused</span> :
    s === 'restarting'               ? <span className="badge badge-paused">↺ restarting</span> :
    s === 'created'                  ? <span className="badge badge-created">created</span> :
    (s === 'exited' || s === 'dead') ? <span className="badge badge-idle">■ {state}</span> :
                                       <span className="badge badge-idle">{state || 'unknown'}</span>
  return (
    <div className="ctr-status-cell">
      {badge}
      {sub && <span className="ctr-status-sub">{sub}</span>}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ContainersTab({
  containers,
  loading,
  onRefresh,
}: {
  containers: DockerContainer[]
  loading:    boolean
  onRefresh:  () => void
}) {
  const [sortKey, setSortKey]         = useState<SortKey>('name')
  const [sortDir, setSortDir]         = useState<SortDir>('asc')
  const [search, setSearch]           = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [confirmId, setConfirmId]     = useState<string | null>(null)
  const [busy, setBusy]               = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [logsId, setLogsId]           = useState<string | null>(null)

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy]       = useState(false)

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
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || c.id.includes(q))
      .sort((a, b) => {
        const cmp = a[sortKey].localeCompare(b[sortKey])
        return sortDir === 'asc' ? cmp : -cmp
      })
  }, [containers, sortKey, sortDir, search, stateFilter])

  // ── Bulk helpers ──────────────────────────────────────────────────────────

  const toggleSelect    = (id: string) => setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  const allSelected     = selectedIds.size > 0 && selectedIds.size === filtered.length
  const someSelected    = selectedIds.size > 0 && selectedIds.size < filtered.length
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(filtered.map(c => c.id)))

  const selectedRunning = filtered.filter(c => selectedIds.has(c.id) && c.state === 'running')
  const selectedStopped = filtered.filter(c => selectedIds.has(c.id) && c.state !== 'running')

  const bulkStart = async () => {
    if (!selectedStopped.length || bulkBusy) return
    setBulkBusy(true)
    for (const c of selectedStopped) {
      try { await api.dockerContainerAction(c.id, 'start') } catch { /* continue */ }
    }
    setSelectedIds(new Set()); onRefresh(); setBulkBusy(false)
  }

  const bulkStop = async () => {
    if (!selectedRunning.length || bulkBusy) return
    setBulkBusy(true)
    for (const c of selectedRunning) {
      try { await api.dockerContainerAction(c.id, 'stop') } catch { /* continue */ }
    }
    setSelectedIds(new Set()); onRefresh(); setBulkBusy(false)
  }

  const bulkRemove = async () => {
    if (!selectedStopped.length || bulkBusy) return
    setBulkBusy(true)
    for (const c of selectedStopped) {
      try { await api.dockerContainerAction(c.id, 'remove') } catch { /* continue */ }
    }
    setSelectedIds(new Set()); onRefresh(); setBulkBusy(false)
  }

  // ── Per-row action ────────────────────────────────────────────────────────

  const doAction = async (id: string, action: 'start' | 'stop' | 'remove') => {
    setBusy(id); setConfirmId(null); setActionError(null)
    try { await api.dockerContainerAction(id, action); onRefresh() }
    catch (e) { setActionError(String(e)) }
    finally { setBusy(null) }
  }

  if (loading) return <div className="img-loading">Loading containers…</div>
  if (!containers.length) return <p className="empty-state">No containers found.</p>

  return (
    <div className="img-tab">
      {/* ── Toolbar (bulk controls live here — no layout shift) ────── */}
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
            <button key={f} className={clsx('ctr-filter-btn', stateFilter === f && 'active')}
              onClick={() => setStateFilter(f)}>{f}</button>
          ))}
        </div>

        {selectedIds.size > 0 && (
          <>
            <div className="toolbar-divider" />
            <span className="toolbar-sel-count">{selectedIds.size} selected</span>
            {selectedStopped.length > 0 && (
              <button className="toolbar-bulk-btn toolbar-bulk-btn--success" onClick={bulkStart} disabled={bulkBusy}>
                <Play size={11} />
                Start {selectedStopped.length}
              </button>
            )}
            {selectedRunning.length > 0 && (
              <button className="toolbar-bulk-btn toolbar-bulk-btn--warn" onClick={bulkStop} disabled={bulkBusy}>
                <Square size={11} />
                Stop {selectedRunning.length}
              </button>
            )}
            {selectedStopped.length > 0 && (
              <button className="toolbar-bulk-btn toolbar-bulk-btn--danger" onClick={bulkRemove} disabled={bulkBusy}>
                <Trash2 size={11} />
                Remove {selectedStopped.length}
              </button>
            )}
            <button className="toolbar-bulk-btn toolbar-bulk-btn--ghost" onClick={() => setSelectedIds(new Set())} title="Clear selection">
              <X size={11} />
            </button>
          </>
        )}

        <span className="img-count">{filtered.length} container{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {actionError && (
        <div className="error-banner" style={{ marginBottom: 0 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{actionError}</span>
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────────── */}
      <div className="img-table-wrap">
        <table className="img-table">
          <thead>
            <tr>
              <th className="img-th img-th-check">
                <input
                  type="checkbox"
                  className="row-checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected }}
                  onChange={toggleSelectAll}
                />
              </th>
              <SortHeader label="Name"    col="name"          sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Image"   col="image"         sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Status"  col="state"         sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
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
              const showLogs     = logsId === c.id
              const isSelected   = selectedIds.has(c.id)

              return (
                <React.Fragment key={c.id}>
                  {/* ── Container row — full row clickable for logs ── */}
                  <tr
                    className={clsx('img-row img-row--clickable', showLogs && 'row-logs-open', isSelected && 'row-selected')}
                    onClick={() => setLogsId(showLogs ? null : c.id)}
                    title="Click to view logs"
                  >
                    <td className="img-td img-td-check" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="row-checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(c.id)}
                      />
                    </td>
                    <td className="img-td">
                      <div className="ctr-name-cell">
                        <ChevronDown size={11} className={clsx('ctr-logs-chevron', showLogs && 'open')} />
                        <span className="img-repo">{c.name || <em className="img-colon">unnamed</em>}</span>
                      </div>
                    </td>
                    <td className="img-td img-age">{c.image}</td>
                    <td className="img-td"><StateBadge state={c.state} sub={c.status} /></td>
                    <td className="img-td"><PortChips raw={c.ports} /></td>
                    <td className="img-td img-age">{c.created_since}</td>
                    <td className="img-td ctr-td-actions" onClick={e => e.stopPropagation()}>
                      {isRunning ? (
                        <button className="ctr-action-btn ctr-action-stop" onClick={() => doAction(c.id, 'stop')}
                          disabled={isBusy} title="Stop container">
                          <Square size={12} />
                        </button>
                      ) : (
                        <button className="ctr-action-btn ctr-action-start" onClick={() => doAction(c.id, 'start')}
                          disabled={isBusy} title="Start container">
                          <Play size={12} />
                        </button>
                      )}
                      {isConfirming ? (
                        <button className="ctr-action-btn ctr-action-confirm" onClick={() => doAction(c.id, 'remove')}
                          disabled={isBusy} title="Confirm removal">
                          <Trash2 size={12} /><span>?</span>
                        </button>
                      ) : (
                        <button className="ctr-action-btn ctr-action-remove"
                          onClick={() => { setConfirmId(c.id); setActionError(null) }}
                          disabled={isBusy || isRunning}
                          title={isRunning ? 'Stop first to remove' : 'Remove container'}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>

                  {/* ── Inline log viewer ─────────────────────────── */}
                  {showLogs && (
                    <tr className="log-viewer-row">
                      <td colSpan={7} className="log-viewer-cell">
                        <LogViewer id={c.id} name={c.name || c.id.slice(0, 12)} onClose={() => setLogsId(null)} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
