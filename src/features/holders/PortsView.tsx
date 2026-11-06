import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useVisiblePoll } from '../../hooks/useVisiblePoll'
import { bytesToHuman, timeAgo } from '../../utils/format'
import { Button, CellLink, EmptyState, ErrorBanner, SearchField, Segmented, SegmentedItem, SheetHead, Tag, Toolbar } from '../../components/ui'
import { ColumnsMenu, TableHead, useTableColumns, type TableColumn } from '../../components/TableColumns'
import * as api from './api'
import type { PortEntry, PortList } from './api'
import { addressList, filterPorts, fixDone, reachableLabel, runsIn, sinceTitle, sortPorts, type PortFilter, type PortSortKey } from './rules'
import { CloseProgramDialog, HolderAction } from './HolderBits'

const POLL_MS = 10_000
// A program's sockets close just after it exits, so a list read straight away can still show them.
const AFTER_CLOSE_MS = 400

/** The defaults that start visible add up to about 930, which fits the table at a 1280px window. */
const COLUMNS: TableColumn<PortSortKey>[] = [
  { key: 'port',      label: 'Port',            width: 76,  sort: 'port' },
  { key: 'program',   label: 'Process',         width: 180, sort: 'program' },
  { key: 'pid',       label: 'PID',             width: 76,  sort: 'pid',       hideable: true },
  { key: 'runs-in',   label: 'Runs in',         width: 150, sort: 'runs-in',   hideable: true },
  { key: 'reachable', label: 'Reachable from',  width: 144, sort: 'reachable', hideable: true },
  { key: 'since',     label: 'Listening since', width: 140, sort: 'since',     hideable: true },
  { key: 'command',   label: 'Command line',    width: 320, sort: 'command',   hideable: true },
  { key: 'folder',    label: 'Working directory', width: 240, sort: 'folder',    hideable: true },
  { key: 'memory',    label: 'Memory',          width: 90,  sort: 'memory',    hideable: true },
  { key: 'parent',    label: 'Parent process',  width: 130, sort: 'parent',    hideable: true },
  { key: 'address',   label: 'Bind addresses',  width: 170, sort: 'address',   hideable: true },
  { key: 'path',      label: 'Executable path', width: 280, sort: 'path',      hideable: true },
  { key: 'actions',   label: 'Actions',         width: 160 },
]

const Dash = () => <span className="pkg-dash">-</span>

function RunsIn({ entry }: { entry: PortEntry }) {
  const { process, source } = entry
  if (source === 'docker') {
    return <CellLink title={`Show ${process.name} in Docker`} onClick={() => useAppStore.getState().jumpToDocker('containers', process.name)}>{runsIn(entry)}</CellLink>
  }
  if (source === 'wsl' && process.distro) {
    const distro = process.distro
    const open = () => {
      const store = useAppStore.getState()
      store.setActiveView('wsl')
      store.setWslSelectedDistro(distro)
      store.setWslView('distro')
    }
    return <CellLink title={`Open ${distro}`} onClick={open}>{runsIn(entry)}</CellLink>
  }
  return <>{runsIn(entry)}</>
}

function PortCell({ column, entry, onClose }: { column: string; entry: PortEntry; onClose: () => void }) {
  const text = (value: string | null, className = 'img-td img-age') => (
    <td className={className} title={value ?? undefined}>{value ?? <Dash />}</td>
  )
  switch (column) {
    case 'port':      return <td className="img-td holder-port">{entry.port}</td>
    case 'program':   return <td className="img-td img-repo" title={entry.process.path ?? entry.process.name}>{entry.process.name}</td>
    case 'pid':       return <td className="img-td img-age num">{entry.process.pid || <Dash />}</td>
    case 'runs-in':   return <td className="img-td img-age"><RunsIn entry={entry} /></td>
    case 'reachable': return <td className="img-td img-age" title={addressList(entry)}>{reachableLabel(entry)}</td>
    case 'since':
      return (
        <td className="img-td img-age num" title={sinceTitle(entry)}>
          {entry.listening_since === null ? <Dash /> : timeAgo(entry.listening_since * 1000)}
        </td>
      )
    case 'command':   return text(entry.details.command, 'img-td img-age holder-code')
    case 'folder':    return text(entry.details.folder)
    case 'memory':
      return <td className="img-td img-age num">{entry.details.memory_bytes === null ? <Dash /> : bytesToHuman(entry.details.memory_bytes)}</td>
    case 'parent':    return text(entry.details.parent)
    case 'address':   return text(addressList(entry))
    case 'path':      return text(entry.process.path)
    default:
      return (
        <td className="img-td holder-actions">
          <HolderAction process={entry.process} holds={`using port ${entry.port}`} onClose={onClose} />
        </td>
      )
  }
}

export default function PortsView() {
  const [list, setList] = useState<PortList | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [closeError, setCloseError] = useState<unknown>(null)
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<PortFilter>('programs')
  const [sortKey, setSortKey] = useState<PortSortKey>('port')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [closing, setClosing] = useState<PortEntry | null>(null)
  const [result, setResult] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  const portColumns = useAppStore(s => s.portColumns)
  const setPortColumns = useAppStore(s => s.setPortColumns)
  const table = useTableColumns<PortSortKey>({
    columns: COLUMNS,
    fill: 'program',
    prefs: portColumns,
    read: () => useAppStore.getState().portColumns,
    save: setPortColumns,
  })

  const load = useCallback(async () => {
    try {
      const next = await api.portsList()
      setList(next)
      setError(null)
      return next
    } catch (e) {
      setError(e)
      return null
    }
  }, [])

  const portsJump = useAppStore(s => s.portsJump)
  useEffect(() => {
    if (portsJump === null) return
    useAppStore.getState().clearPortsJump()
    setQuery(portsJump)
    setShow('all')
  }, [portsJump])

  useEffect(() => { load() }, [load])
  useVisiblePoll(load, POLL_MS, !closing)

  const handleSort = (key: PortSortKey) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const all = useMemo(() => list?.entries ?? [], [list])
  const rows = useMemo(() => sortPorts(filterPorts(all, query, show), sortKey, sortDir), [all, query, show, sortKey, sortDir])

  const holdsText = ({ process }: PortEntry) => {
    // Every container has PID 0, so the name is what tells them apart.
    const ports = all.filter(e => e.process.pid === process.pid && e.process.name === process.name && e.process.distro === process.distro).map(e => e.port)
    return `Using ${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')}`
  }

  const afterClose = async (closed: PortEntry) => {
    setClosing(null)
    await new Promise(resolve => setTimeout(resolve, AFTER_CLOSE_MS))
    const next = await load()
    if (!next) {
      setResult({ tone: 'ok', text: fixDone(closed.process) })
      return
    }
    const holder = next.entries.find(e => e.port === closed.port)
    setResult(holder
      ? { tone: 'warn', text: `${fixDone(closed.process)}, but ${holder.process.name} is now using port ${closed.port}` }
      : { tone: 'ok', text: `${fixDone(closed.process)}. Port ${closed.port} is free.` })
  }

  return (
    <div className="view-container">
      <div className="page-head">
        <SheetHead
          crumbs={[
            { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
            { label: 'Ports' },
          ]}
          title="Ports"
          subtitle="Listening TCP ports on Windows, in Docker containers, and in running WSL distros."
          actions={
            <>
              <ColumnsMenu
                columns={COLUMNS}
                hidden={portColumns.hidden}
                onToggle={table.toggle}
                onReset={() => setPortColumns(useAppStore.getInitialState().portColumns)}
              />
              <Button onClick={() => { setResult(null); load() }}><RefreshCw size={12} /> Refresh</Button>
            </>
          }
        />
      </div>

      <div className="page-fill">
        <div className="img-tab">
          <Toolbar>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search ports"
              label="Search by port, process, PID, command line, or working directory"
            />
            <Segmented label="Show ports">
              <SegmentedItem active={show === 'programs'} count={filterPorts(all, '', 'programs').length} onClick={() => setShow('programs')}>
                Programs
              </SegmentedItem>
              <SegmentedItem active={show === 'all'} count={all.length} onClick={() => setShow('all')}>
                All
              </SegmentedItem>
            </Segmented>
            <span role="status">
              {result && <Tag tone={result.tone}>{result.text}</Tag>}
              {list && list.unchecked.length > 0 && <Tag tone="warn">Could not check {list.unchecked.join(', ')}</Tag>}
            </span>
          </Toolbar>

          {error != null && <ErrorBanner className="error-banner--flush" title="Could not list ports" error={error} />}
          {closeError != null && <ErrorBanner className="error-banner--flush" error={closeError} />}

          {list === null && error == null && <div className="img-loading">Loading ports…</div>}

          {list !== null && rows.length === 0 && (
            <EmptyState
              title={query ? 'No ports match this search' : 'No listening ports'}
              description={query
                ? 'Search by port, process name, PID, command line, or working directory.'
                : 'Ports appear here when a process starts listening.'}
              actions={query ? <Button onClick={() => setQuery('')}>Clear search</Button> : undefined}
            />
          )}

          {rows.length > 0 && (
            <div className="img-table-wrap">
              <table className="img-table pkg-table" style={{ width: table.tableWidth }}>
                <TableHead table={table} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} actionsClass="holder-actions" />
                <tbody>
                  {rows.map(e => (
                    <tr key={`${e.port}-${e.process.pid}-${e.process.name}`} className="img-row">
                      {table.visible.map(c => (
                        <PortCell
                          key={c.key}
                          column={c.key}
                          entry={e}
                          onClose={() => { setCloseError(null); setResult(null); setClosing(e) }}
                        />
                      ))}
                      {table.fillFixed && <td className="img-td" aria-hidden="true" />}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {closing && (
        <CloseProgramDialog
          process={closing.process}
          holds={holdsText(closing)}
          onClosed={() => afterClose(closing)}
          onFailed={e => { setClosing(null); setCloseError(e); load() }}
          onCancel={() => setClosing(null)}
        />
      )}
    </div>
  )
}
