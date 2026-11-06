import { Fragment, useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import type { DockerNetwork } from '../types'
import { useAppStore } from '../../../store/appStore'
import { ConfirmRemoveButton, useDockerJump, useDockerTable } from './TableBits'
import { SearchField, ErrorBanner, Toolbar, FilterSegments, NoMatches } from '../../../components/ui'
import { TableHead, useTableSort } from '../../../components/TableColumns'
import {
  filterNetworks, isBuiltInNetwork, matchesNetworkFilter, networkOptions, sortNetworks,
  type NetworkFilter, type NetworkSortKey,
} from '../rules'

/** Format an ISO date string as relative ("3 months ago") for recent dates,
 *  or a short absolute date for older ones. */
function fmtDate(raw: string): string {
  if (!raw) return '-'
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
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

const FILTERS: { key: NetworkFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'custom', label: 'Custom' },
  { key: 'built-in', label: 'Built-in' },
]

export default function NetworksTab({ refreshTick }: { refreshTick: number }) {
  const [networks, setNetworks]       = useState<DockerNetwork[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<unknown>(null)
  const [search, setSearch]           = useState('')
  const [filter, setFilter]           = useState<NetworkFilter>('all')
  const { sortKey, sortDir, handleSort } = useTableSort<NetworkSortKey>('name', 'asc', ['created'])
  const [busy, setBusy]               = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const table = useDockerTable<NetworkSortKey>('networks')

  useDockerJump('networks', ({ query }) => {
    setSearch(query)
    setFilter('all')
  })

  useEffect(() => {
    let current = true
    setLoading(networks.length === 0)
    setError(null)
    api.dockerNetworks()
      .then(next => { if (current) setNetworks(next) })
      .catch(e => { if (current) setError(e) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [refreshTick])

  const doRemove = async (id: string) => {
    setBusy(id); setActionError(null)
    const { addTerminalLine } = useAppStore.getState()
    const name = networks.find(n => n.id === id)?.name || id.slice(0, 12)
    addTerminalLine(`$ docker network rm ${id.slice(0, 12)}`, 'cmd')
    try {
      await api.dockerNetworkRemove(id)
      addTerminalLine(`  ✓ ${name} removed`, 'success')
      setNetworks(prev => prev.filter(n => n.id !== id))
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setActionError(e)
    } finally { setBusy(null) }
  }

  const rows = useMemo(
    () => sortNetworks(filterNetworks(networks, search, filter), sortKey, sortDir),
    [networks, search, filter, sortKey, sortDir],
  )

  if (loading) return <div className="img-loading">Loading networks…</div>

  const cell = (column: string, n: DockerNetwork) => {
    switch (column) {
      case 'name':    return <td className="img-td img-repo" title={n.name}>{n.name}</td>
      case 'id':      return <td className="img-td img-id" title={n.id}>{n.id.slice(0, 12)}</td>
      case 'driver':  return <td className="img-td img-age">{n.driver}</td>
      case 'scope':   return <td className="img-td img-age">{n.scope}</td>
      case 'options': return <td className="img-td img-age">{networkOptions(n) || <span className="pkg-dash">-</span>}</td>
      case 'created': return <td className="img-td img-age" title={n.created}>{fmtDate(n.created)}</td>
      default:
        return (
          <td className="img-td holder-actions">
            {isBuiltInNetwork(n)
              ? <span className="holder-note" title="Built-in networks cannot be removed">Built-in</span>
              : (
                <ConfirmRemoveButton
                  onConfirm={() => doRemove(n.id)}
                  onArm={() => setActionError(null)}
                  disabled={busy === n.id}
                  title={`Remove network ${n.name}`}
                />
              )}
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
          placeholder="Search networks"
          label="Search networks by name, driver, or ID"
        />
        <FilterSegments label="Filter networks" options={FILTERS} value={filter} onChange={setFilter} count={key => networks.filter(n => matchesNetworkFilter(n, key)).length} />
        <span className="img-count">{rows.length} shown</span>
      </Toolbar>

      {error != null && <ErrorBanner className="error-banner--flush" title="Could not list networks" error={error} />}
      {actionError != null && <ErrorBanner className="error-banner--flush" title="Could not remove the network" error={actionError} />}

      {rows.length === 0 && error == null && (
        <NoMatches noun="networks" onClear={() => { setSearch(''); setFilter('all') }} />
      )}

      {rows.length > 0 && (
        <div className="img-table-wrap">
          <table className="img-table pkg-table" style={{ width: table.tableWidth }}>
            <TableHead table={table} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} actionsClass="holder-actions" />
            <tbody>
              {rows.map(n => (
                <tr key={n.id} className="img-row">
                  {table.visible.map(column => <Fragment key={column.key}>{cell(column.key, n)}</Fragment>)}
                  {table.fillFixed && <td className="img-td" aria-hidden="true" />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
