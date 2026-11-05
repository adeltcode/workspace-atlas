import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useVisiblePoll } from '../../hooks/useVisiblePoll'
import { Button, EmptyState, ErrorBanner, SearchField, Segmented, SegmentedItem, SheetHead, Tag, Toolbar } from '../../components/ui'
import * as api from './api'
import type { PortEntry, PortList } from './api'
import { filterPorts, type PortFilter } from './rules'
import { CloseProgramDialog, HolderAction, ProgramCell } from './HolderBits'

const POLL_MS = 10_000
// A program's sockets close just after it exits, so a list read straight away can still show them.
const AFTER_CLOSE_MS = 400

export default function PortsView() {
  const [list, setList] = useState<PortList | null>(null)
  const loading = useRef(false)
  const [error, setError] = useState<unknown>(null)
  const [closeError, setCloseError] = useState<unknown>(null)
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<PortFilter>('programs')
  const [closing, setClosing] = useState<PortEntry | null>(null)
  const [result, setResult] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  const load = useCallback(async () => {
    loading.current = true
    try {
      const next = await api.portsList()
      setList(next)
      setError(null)
      return next
    } catch (e) {
      setError(e)
      return null
    } finally {
      loading.current = false
    }
  }, [])

  useEffect(() => { load() }, [load])
  useVisiblePoll(() => { if (!loading.current) load() }, POLL_MS, !closing)

  const all = list?.entries ?? []
  const holdsText = ({ process }: PortEntry) => {
    const ports = all.filter(e => e.process.pid === process.pid && e.process.distro === process.distro).map(e => e.port)
    return `Holds ${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')}`
  }

  const afterClose = async (closed: PortEntry) => {
    setClosing(null)
    await new Promise(resolve => setTimeout(resolve, AFTER_CLOSE_MS))
    const next = await load()
    if (!next) {
      setResult({ tone: 'ok', text: `Closed ${closed.process.name}` })
      return
    }
    const holder = next.entries.find(e => e.port === closed.port)
    setResult(holder
      ? { tone: 'warn', text: `Closed ${closed.process.name}, but ${holder.process.name} now holds port ${closed.port}` }
      : { tone: 'ok', text: `Closed ${closed.process.name}. Port ${closed.port} is free.` })
  }

  const rows = filterPorts(all, query, show)

  return (
    <div className="view-container">
      <div className="page-head">
        <SheetHead
          crumbs={[
            { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
            { label: 'Ports' },
          ]}
          title="Ports"
          subtitle="Programs listening for connections on this PC, in Docker, and in running WSL distros."
          actions={<Button onClick={() => { setResult(null); load() }}><RefreshCw size={12} /> Refresh</Button>}
        />
      </div>

      <div className="page-fill">
        <div className="img-tab">
          <Toolbar>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search ports"
              label="Search by port, program, or PID"
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
              title={query ? 'No ports match this search' : 'No programs are listening'}
              description={query
                ? 'Search by port number, program name, or PID, or clear the search to see every port.'
                : 'When a server or dev tool starts listening, it appears here.'}
              actions={query ? <Button onClick={() => setQuery('')}>Clear search</Button> : undefined}
            />
          )}

          {rows.length > 0 && (
            <div className="img-table-wrap">
              <table className="img-table">
                <thead>
                  <tr>
                    <th className="img-th holder-port">Port</th>
                    <th className="img-th">Program</th>
                    <th className="img-th">PID</th>
                    <th className="img-th">Reachable from</th>
                    <th className="img-th holder-actions">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(e => (
                    <tr key={`${e.port}-${e.process.pid}-${e.process.name}`} className="img-row">
                      <td className="img-td holder-port">{e.port}</td>
                      <td className="img-td"><ProgramCell process={e.process} /></td>
                      <td className="img-td img-age num">{e.process.pid || '-'}</td>
                      <td className="img-td img-age" title={e.addresses.join(', ')}>
                        {e.reachable === 'this-pc' ? 'This PC only' : 'Your network'}
                      </td>
                      <td className="img-td holder-actions">
                        <HolderAction
                          process={e.process}
                          holds={`holding port ${e.port}`}
                          onClose={() => { setCloseError(null); setResult(null); setClosing(e) }}
                        />
                      </td>
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
