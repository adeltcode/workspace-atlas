import { Fragment, useState, useMemo, useRef, useEffect } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Play, Square, Trash2, ChevronDown, FileText, RefreshCw, X, Box } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import type { DockerContainer } from '../types'
import { useAppStore } from '../../../store/appStore'
import { ConfirmRemoveButton, StatusCell, useDockerJump, useDockerTable } from './TableBits'
import { Button, CellLink, SearchField, Segmented, SegmentedItem, EmptyState, ErrorBanner, ConfirmDestructive, Toolbar } from '../../../components/ui'
import { TableHead } from '../../../components/TableColumns'
import {
  containerDot, filterContainers, firstPort, matchesContainerFilter, parsePorts, portLabel, sortContainers,
  type ContainerFilter, type ContainerSortKey, type SortDir,
} from '../rules'

const FILTERS: { key: ContainerFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'stopped', label: 'Stopped' },
]

const Dash = () => <span className="pkg-dash">-</span>

function PortLinks({ container }: { container: DockerContainer }) {
  const ports = parsePorts(container.ports)
  if (!ports.length) return <Dash />
  return (
    <>
      {ports.map((port, i) => (
        <Fragment key={`${port.host}-${port.proto}`}>
          {i > 0 && ', '}
          {container.state === 'running' && port.proto === 'tcp'
            ? (
              <CellLink title={`Open http://localhost:${firstPort(port)}`} onClick={() => { openUrl(`http://localhost:${firstPort(port)}`).catch(() => {}) }}>
                {portLabel(port)}
              </CellLink>
            )
            : portLabel(port)}
        </Fragment>
      ))}
    </>
  )
}

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
          <button className="ctr-action-btn" onClick={() => load()} disabled={loading} title="Refresh logs" aria-label="Refresh logs">
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
          </button>
          <button className="ctr-action-btn" onClick={onClose} title="Close logs" aria-label="Close logs">
            <X size={11} />
          </button>
        </div>
      </div>
      <div className="log-viewer-body" ref={bodyRef}>
        {loading && <div className="log-viewer-empty">Loading logs…</div>}
        {error   && <div className="log-viewer-empty log-viewer-error">{error}</div>}
        {!loading && !error && lines.length === 0 && (
          <div className="log-viewer-empty">No log output in the last {tail} lines.</div>
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

export default function ContainersTab({
  containers,
  loading,
  onRefresh,
}: {
  containers: DockerContainer[]
  loading:    boolean
  onRefresh:  () => void
}) {
  const [sortKey, setSortKey]         = useState<ContainerSortKey>('name')
  const [sortDir, setSortDir]         = useState<SortDir>('asc')
  const [search, setSearch]           = useState('')
  const [stateFilter, setStateFilter] = useState<ContainerFilter>('all')
  const [busy, setBusy]               = useState<string | null>(null)
  // Holds the caught value, so the banner can offer its recovery action.
  const [actionError, setActionError] = useState<unknown>(null)
  // By name, because a page that sends the user here knows the name and not the ID.
  const [logsName, setLogsName]       = useState<string | null>(null)
  const table = useDockerTable<ContainerSortKey>('containers')

  useDockerJump('containers', ({ query, logs }) => {
    setSearch(query)
    setStateFilter('all')
    if (logs) setLogsName(query)
    onRefresh()
  })

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy]       = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const handleSort = (key: ContainerSortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'created' ? 'desc' : 'asc') }
  }

  const filtered = useMemo(
    () => sortContainers(filterContainers(containers, search, stateFilter), sortKey, sortDir),
    [containers, sortKey, sortDir, search, stateFilter],
  )

  const toggleSelect    = (id: string) => setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  const allSelected     = selectedIds.size > 0 && selectedIds.size === filtered.length
  const someSelected    = selectedIds.size > 0 && selectedIds.size < filtered.length
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(filtered.map(c => c.id)))

  const selectedRunning = filtered.filter(c => selectedIds.has(c.id) && c.state === 'running')
  const selectedStopped = filtered.filter(c => selectedIds.has(c.id) && c.state !== 'running')

  const bulkStart = async () => {
    if (!selectedStopped.length || bulkBusy) return
    setBulkBusy(true)
    const { addTerminalLine } = useAppStore.getState()
    for (const c of selectedStopped) {
      addTerminalLine(`$ docker start ${c.id.slice(0, 12)}`, 'cmd')
      try {
        await api.dockerContainerAction(c.id, 'start')
        addTerminalLine(`  ✓ ${c.name || c.id.slice(0, 12)} started`, 'success')
      } catch (e) {
        addTerminalLine(`  ✗ ${String(e)}`, 'error')
      }
    }
    setSelectedIds(new Set()); onRefresh(); setBulkBusy(false)
  }

  const bulkStop = async () => {
    if (!selectedRunning.length || bulkBusy) return
    setBulkBusy(true)
    const { addTerminalLine } = useAppStore.getState()
    for (const c of selectedRunning) {
      addTerminalLine(`$ docker stop ${c.id.slice(0, 12)}`, 'cmd')
      try {
        await api.dockerContainerAction(c.id, 'stop')
        addTerminalLine(`  ✓ ${c.name || c.id.slice(0, 12)} stopped`, 'success')
      } catch (e) {
        addTerminalLine(`  ✗ ${String(e)}`, 'error')
      }
    }
    setSelectedIds(new Set()); onRefresh(); setBulkBusy(false)
  }

  const bulkRemove = async () => {
    if (!selectedStopped.length || bulkBusy) return
    setBulkBusy(true)
    const { addTerminalLine } = useAppStore.getState()
    setConfirmRemove(false)
    for (const c of selectedStopped) {
      addTerminalLine(`$ docker rm ${c.id.slice(0, 12)}`, 'cmd')
      try {
        await api.dockerContainerAction(c.id, 'remove')
        addTerminalLine(`  ✓ ${c.name || c.id.slice(0, 12)} removed`, 'success')
      } catch (e) {
        addTerminalLine(`  ✗ ${String(e)}`, 'error')
      }
    }
    setSelectedIds(new Set()); onRefresh(); setBulkBusy(false)
  }

  const doAction = async (id: string, action: 'start' | 'stop' | 'remove') => {
    setBusy(id); setActionError(null)
    const { addTerminalLine } = useAppStore.getState()
    const sub  = action === 'remove' ? 'rm' : action
    const name = containers.find(c => c.id === id)?.name || id.slice(0, 12)
    addTerminalLine(`$ docker ${sub} ${id.slice(0, 12)}`, 'cmd')
    try {
      await api.dockerContainerAction(id, action)
      const past = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'removed'
      addTerminalLine(`  ✓ ${name} ${past}`, 'success')
      onRefresh()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setActionError(e)
    }
    finally { setBusy(null) }
  }

  if (loading) return <div className="img-loading">Loading containers…</div>
  if (!containers.length) return (
    <EmptyState
      icon={Box}
      title="No containers on this engine"
      description="Start a Compose project or run a container, and it appears here, running or not."
    />
  )

  const cell = (column: string, c: DockerContainer) => {
    const isRunning = c.state === 'running'
    const isBusy    = busy === c.id
    const showLogs  = logsName === c.name
    switch (column) {
      case 'select':
        return (
          <td className="img-td img-td-check" onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              className="row-checkbox"
              aria-label={`Select container ${c.name}`}
              checked={selectedIds.has(c.id)}
              onChange={() => toggleSelect(c.id)}
            />
          </td>
        )
      case 'name':
        return (
          <td className="img-td" title={c.name}>
            <button
              className="ctr-name-cell"
              onClick={e => { e.stopPropagation(); setLogsName(showLogs ? null : c.name) }}
              aria-label={`Logs for ${c.name}`}
              aria-expanded={showLogs}
              aria-controls={`container-logs-${c.id}`}
            >
              <ChevronDown size={11} className={clsx('ctr-logs-chevron', showLogs && 'open')} />
              <span className="img-repo">{c.name || <em className="img-colon">unnamed</em>}</span>
            </button>
          </td>
        )
      case 'image':
        return (
          <td className="img-td img-age">
            <CellLink title={`Show ${c.image} in Images`} onClick={() => useAppStore.getState().jumpToDocker('images', c.image)}>{c.image}</CellLink>
          </td>
        )
      case 'status':
        return <td className="img-td img-age" title={c.state}><StatusCell dot={containerDot(c.state)}>{c.status || c.state}</StatusCell></td>
      case 'ports':
        return <td className="img-td img-age num" title={c.ports}><PortLinks container={c} /></td>
      case 'project':
        return (
          <td className="img-td img-age">
            {c.compose_project
              ? (
                <CellLink
                  title={`Open ${c.compose_project} in Compose`}
                  onClick={() => { const s = useAppStore.getState(); s.setComposePreselect(c.compose_project); s.setDockerTab('compose') }}
                >
                  {c.compose_project}
                </CellLink>
              )
              : <Dash />}
          </td>
        )
      case 'service':
        return <td className="img-td img-age">{c.compose_service ?? <Dash />}</td>
      case 'created':
        return <td className="img-td img-age">{c.created_since}</td>
      case 'id':
        return <td className="img-td img-id" title={c.id}>{c.id.slice(0, 12)}</td>
      default:
        return (
          <td className="img-td holder-actions" onClick={e => e.stopPropagation()}>
            {isRunning
              ? (
                <Button size="sm" icon variant="ghost" onClick={() => doAction(c.id, 'stop')} disabled={isBusy} title={`Stop ${c.name}`} aria-label={`Stop ${c.name}`}>
                  <Square size={13} />
                </Button>
              )
              : (
                <Button size="sm" icon variant="ghost" onClick={() => doAction(c.id, 'start')} disabled={isBusy} title={`Start ${c.name}`} aria-label={`Start ${c.name}`}>
                  <Play size={13} />
                </Button>
              )}
            <ConfirmRemoveButton
              onConfirm={() => doAction(c.id, 'remove')}
              onArm={() => setActionError(null)}
              disabled={isBusy || isRunning}
              title={isRunning ? `Stop ${c.name} first to remove it` : `Remove ${c.name}`}
            />
          </td>
        )
    }
  }

  return (
    <div className="img-tab">
      <Toolbar>
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search containers"
          label="Search containers by name, image, ID, project, or port"
        />
        <Segmented label="Filter by state">
          {FILTERS.map(({ key, label }) => (
            <SegmentedItem
              key={key}
              active={stateFilter === key}
              count={containers.filter(c => matchesContainerFilter(c, key)).length}
              onClick={() => setStateFilter(key)}
            >
              {label}
            </SegmentedItem>
          ))}
        </Segmented>

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
              <button className="toolbar-bulk-btn toolbar-bulk-btn--danger" onClick={() => setConfirmRemove(true)} disabled={bulkBusy}>
                <Trash2 size={11} />
                Remove {selectedStopped.length}
              </button>
            )}
            <button className="toolbar-bulk-btn toolbar-bulk-btn--ghost" onClick={() => setSelectedIds(new Set())} title="Clear selection">
              <X size={11} />
            </button>
          </>
        )}

        <span className="img-count">{filtered.length} shown</span>
      </Toolbar>

      {actionError != null && <ErrorBanner className="error-banner--flush" error={actionError} />}

      {filtered.length === 0 && (
        <EmptyState
          title="No containers match"
          description="Try a shorter search or another filter."
          actions={<Button onClick={() => { setSearch(''); setStateFilter('all') }}>Show all containers</Button>}
        />
      )}

      {filtered.length > 0 && (
        <div className="img-table-wrap">
          <table className="img-table pkg-table" style={{ width: table.tableWidth }}>
            <TableHead
              table={table}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              actionsClass="holder-actions"
              select={(
                <input
                  type="checkbox"
                  className="row-checkbox"
                  aria-label="Select all containers"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected }}
                  onChange={toggleSelectAll}
                />
              )}
            />
            <tbody>
              {filtered.map(c => {
                const showLogs = logsName === c.name
                return (
                  <Fragment key={c.id}>
                    <tr
                      className={clsx('img-row img-row--clickable', showLogs && 'row-logs-open', selectedIds.has(c.id) && 'row-selected')}
                      onClick={() => setLogsName(showLogs ? null : c.name)}
                      title="Click to view logs"
                    >
                      {table.visible.map(column => <Fragment key={column.key}>{cell(column.key, c)}</Fragment>)}
                      {table.fillFixed && <td className="img-td" aria-hidden="true" />}
                    </tr>

                    {showLogs && (
                      <tr className="log-viewer-row" id={`container-logs-${c.id}`}>
                        <td colSpan={table.visible.length + (table.fillFixed ? 1 : 0)} className="log-viewer-cell">
                          <LogViewer id={c.id} name={c.name || c.id.slice(0, 12)} onClose={() => setLogsName(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmRemove && (
        <ConfirmDestructive
          title={`Remove ${selectedStopped.length} container${selectedStopped.length === 1 ? '' : 's'}?`}
          consequence={
            <>
              This deletes the containers and anything written inside them that is not on a
              volume, including their logs. Images and volumes are untouched, so a Compose
              project can recreate these, but a container built by hand cannot.
            </>
          }
          command={`docker rm ${selectedStopped.map(c => c.id.slice(0, 12)).join(' ')}`}
          summary={`${selectedStopped.length} stopped container${selectedStopped.length === 1 ? '' : 's'}`}
          items={selectedStopped.map(c => ({
            name: c.name || c.id.slice(0, 12),
            meta: c.image,
          }))}
          confirmLabel={`Remove ${selectedStopped.length}`}
          onConfirm={bulkRemove}
          onCancel={() => setConfirmRemove(false)}
          busy={bulkBusy}
        />
      )}
    </div>
  )
}
