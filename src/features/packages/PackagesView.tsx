import { useCallback, useEffect, useMemo, useState } from 'react'
import { Package as PackageIcon, RefreshCw, Download } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import { SortHeader } from '../docker/components/TableBits'
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
      <div className="view-header">
        <div className="view-header-icon"><PackageIcon size={18} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="view-header-title-row">
            <h1 className="view-title">Packages</h1>
            {results && (
              <>
                <span className={clsx('status-dot', found.length ? 'online' : 'offline')} />
                <span className="status-text">
                  {found.length
                    ? `${all.length} installed across ${found.length} source${found.length !== 1 ? 's' : ''}`
                    : 'no package managers found'}
                </span>
              </>
            )}
          </div>
          <p className="view-subtitle">Everything winget, npm, and pip have installed on this machine.</p>
        </div>
        <button className="btn-refresh" onClick={scan} disabled={loading} title="Rescan (Ctrl+R)">
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          Rescan
        </button>
        <button
          className="btn-secondary"
          onClick={exportCsv}
          disabled={exporting || loading || rows.length === 0}
          title="Save the rows currently shown as CSV"
        >
          <Download size={13} /> {exporting ? 'Saving…' : 'Export CSV'}
        </button>
      </div>

      {error && (
        <div className="error-banner" style={{ marginTop: 20 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {failed.map(r => (
        <div key={r.id} className="error-banner" style={{ marginTop: 20 }}>
          <span className="error-title">{r.label}</span>
          <span className="error-msg">{r.error}</span>
        </div>
      ))}

      {loading && !results && <div className="img-loading">Scanning package managers…</div>}

      {results && found.length === 0 && !loading && (
        <div className="offline-card" style={{ marginTop: 20 }}>
          <p className="offline-title">No package managers found</p>
          <p className="offline-desc">
            None of the supported managers are on PATH. Install one, then rescan.
          </p>
          <code className="offline-code">winget list</code>
        </div>
      )}

      {found.length > 0 && (
        <div className="pkg-tab">
          <div className="img-toolbar">
            <input
              className="img-search"
              type="search"
              placeholder="Search by name or id…"
              aria-label="Search packages"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
            />

            <div className="ctr-state-filter" role="group" aria-label="Filter by source">
              <button
                className={clsx('ctr-filter-btn pkg-src-btn', source === 'all' && 'active')}
                onClick={() => setSource('all')}
                aria-pressed={source === 'all'}
              >
                All {all.length}
              </button>
              {found.map(r => (
                <button
                  key={r.id}
                  className={clsx('ctr-filter-btn pkg-src-btn', source === r.id && 'active')}
                  onClick={() => setSource(r.id)}
                  aria-pressed={source === r.id}
                  title={r.command}
                >
                  {r.label} {r.packages.length}
                </button>
              ))}
            </div>

            <button
              className={clsx('pkg-toggle', outdatedOnly && 'active')}
              onClick={() => setOutdatedOnly(v => !v)}
              aria-pressed={outdatedOnly}
              title="Show only packages with a newer version available"
            >
              Updates {outdatedCount}
            </button>

            <span className="img-count">{rows.length} shown</span>
          </div>

          {rows.length === 0 ? (
            <p className="empty-state">No packages match this search.</p>
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
  )
}
