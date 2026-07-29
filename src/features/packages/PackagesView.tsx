import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Download } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import { SortHeader } from '../docker/components/TableBits'
import {
  SheetHead, Prerequisite, Button, SearchField, ErrorBanner, Toolbar,
  Segmented, SegmentedItem, EmptyState,
} from '../../components/ui'
import * as api from './api'
import type { Package, SourceResult } from './types'

type SortKey = 'name' | 'version' | 'source'

/** Quote a CSV field, and defuse the leading characters a spreadsheet treats as
 *  a formula. Package names are untrusted text once they land in Excel. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export default function PackagesView() {
  const addActivity = useAppStore(s => s.addActivity)

  const [results, setResults] = useState<SourceResult[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [query, setQuery]     = useState('')
  const [source, setSource]   = useState('all')
  const [outdatedOnly, setOutdatedOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [exporting, setExporting] = useState(false)

  const scan = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setResults(await api.pkgScan())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { scan() }, [scan])

  // Ctrl+R / Cmd+R → rescan, matching the other module views.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'r' && !e.shiftKey) {
        e.preventDefault(); scan()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scan])

  const found   = useMemo(() => (results ?? []).filter(r => r.installed), [results])
  const missing = useMemo(() => (results ?? []).filter(r => !r.installed), [results])
  const failed  = useMemo(() => found.filter(r => r.error), [found])
  const all     = useMemo(() => found.flatMap(r => r.packages), [found])
  const outdatedCount = useMemo(() => all.filter(p => p.available).length, [all])

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byName = (a: Package, b: Package) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    return all
      .filter(p => source === 'all' || p.source === source)
      .filter(p => !outdatedOnly || p.available)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const cmp = a[sortKey].localeCompare(b[sortKey], undefined, { sensitivity: 'base' })
        // Ties fall back to name so sorting by source or version groups rows
        // instead of leaving them in scan order.
        return (sortDir === 'asc' ? cmp : -cmp) || byName(a, b)
      })
  }, [all, query, source, outdatedOnly, sortKey, sortDir])

  // Exports exactly what the table currently shows, so a filtered view exports
  // filtered rows rather than silently widening back to everything.
  const exportCsv = async () => {
    setExporting(true)
    try {
      const csv = [
        'name,id,version,available,source',
        ...rows.map(p => [p.name, p.id, p.version, p.available, p.source].map(csvCell).join(',')),
      ].join('\r\n')
      const path = await api.pkgExportCsv(csv)
      if (path) {
        addActivity({
          module: 'packages',
          action: 'Exported package list',
          outcome: 'success',
          detail: `${rows.length} package${rows.length !== 1 ? 's' : ''} → ${path}`,
        })
      }
    } catch (e) {
      setError(String(e))
      addActivity({ module: 'packages', action: 'Export package list', outcome: 'failure', detail: String(e) })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="view-container">
      <div className="page-head">
      <SheetHead
        crumbs={[
          { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
          { label: 'Packages' },
        ]}
        title="Packages"
        subtitle="Everything winget, npm, and pip have installed on this machine."
        status={results && (
          <span className="status-text" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span className={clsx('status-dot', found.length ? 'online' : 'offline')} />
            {found.length
              ? `${all.length} installed across ${found.length} source${found.length !== 1 ? 's' : ''}`
              : 'no package managers found'}
          </span>
        )}
        actions={
          <>
            <Button
              onClick={exportCsv}
              disabled={exporting || loading || rows.length === 0}
            >
              <Download size={13} /> {exporting ? 'Saving…' : 'Export CSV'}
            </Button>
            <Button onClick={scan} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
              Rescan
            </Button>
          </>
        }
      />
      </div>

      <div className={found.length > 0 ? 'page-fill' : 'page-scroll'}>
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {failed.map(r => (
        <ErrorBanner key={r.id} title={r.label}>{r.error}</ErrorBanner>
      ))}

      {loading && !results && <div className="img-loading">Scanning package managers…</div>}

      {results && found.length === 0 && !loading && (
        <Prerequisite
          title="No package managers found"
          description="None of winget, npm, or pip are on PATH. winget ships with Windows 11; if it is missing, install App Installer from the Microsoft Store. Verify with the command below, then rescan."
          command="winget list"
          actions={<Button onClick={scan} disabled={loading}><RefreshCw size={13} /> Rescan</Button>}
        />
      )}

      {found.length > 0 && (
        <div className="pkg-tab">
          <Toolbar>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search packages"
            />

            <Segmented label="Filter by source">
              <SegmentedItem active={source === 'all'} count={all.length} onClick={() => setSource('all')}>
                All
              </SegmentedItem>
              {found.map(r => (
                <SegmentedItem
                  key={r.id}
                  active={source === r.id}
                  count={r.packages.length}
                  onClick={() => setSource(r.id)}
                  title={r.command}
                >
                  {r.label}
                </SegmentedItem>
              ))}
            </Segmented>

            <button
              className={clsx('pkg-toggle', outdatedOnly && 'active')}
              onClick={() => setOutdatedOnly(v => !v)}
              aria-pressed={outdatedOnly}
              title="Show only packages with a newer version available"
            >
              Updates <span className="num">{outdatedCount}</span>
            </button>

            <span className="img-count">{rows.length} shown</span>
          </Toolbar>

          {rows.length === 0 ? (
            <EmptyState
              title="No packages match this search"
              description="Try a shorter search, a different source, or clear the Updates filter."
              actions={<Button onClick={() => { setQuery(''); setSource('all'); setOutdatedOnly(false) }}>Clear filters</Button>}
            />
          ) : (
            <div className="img-table-wrap">
              <table className="img-table">
                <thead>
                  <tr>
                    <SortHeader label="Name"    col="name"    sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <th className="img-th">Id</th>
                    <SortHeader label="Version" col="version" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <th className="img-th">Available</th>
                    <SortHeader label="Source"  col="source"  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p, i) => (
                    // winget lists the same id more than once (two 7-Zip builds
                    // share 7zip.7zip), so the index keeps keys unique.
                    <tr key={`${p.source}-${p.id}-${p.version}-${i}`} className="img-row">
                      <td className="img-td img-repo">{p.name}</td>
                      <td className="img-td pkg-id" title={p.id}>{p.id}</td>
                      <td className="img-td img-size">{p.version}</td>
                      <td className="img-td">
                        {p.available
                          ? <span className="pkg-avail">{p.available}</span>
                          : <span className="pkg-dash">-</span>}
                      </td>
                      <td className="img-td img-age">{p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="pkg-note">
            {missing.length > 0 && <>Not installed here: {missing.map(r => r.id).join(', ')}. </>}
            Only winget reports available upgrades in a plain list, so the Updates count covers winget alone.
          </p>
        </div>
      )}
      </div>
    </div>
  )
}
