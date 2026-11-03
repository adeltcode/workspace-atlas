import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Download, CircleArrowUp } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import { SortHeader } from '../docker/components/TableBits'
import { Modal } from '../wsl/components/Dialog'
import {
  SheetHead, Prerequisite, Button, SearchField, ErrorBanner, Toolbar,
  Segmented, SegmentedItem, EmptyState, Tag,
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
  const [confirm, setConfirm]     = useState<Package | null>(null)
  const [upgrading, setUpgrading] = useState<Package | null>(null)
  const [upgraded, setUpgraded]   = useState<{ name: string; from: string; to: string } | null>(null)
  const [upgradeError, setUpgradeError] = useState<{ name: string; error: unknown } | null>(null)

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

  const runUpgrade = async (p: Package) => {
    setConfirm(null)
    setUpgrading(p)
    setUpgraded(null)
    setUpgradeError(null)
    try {
      await api.pkgUpgrade(p.id)
    } catch (e) {
      setUpgradeError({ name: p.name, error: e })
      addActivity({ module: 'packages', action: 'Upgrade package', outcome: 'failure', detail: `${p.name}: ${String(e)}` })
      setUpgrading(null)
      return
    }
    // Rescan winget alone so the row shows what is installed now, not what
    // winget claimed it would install. One id can have several installs (an
    // old x86 copy beside the x64 one), so the new version is the one that was
    // not there before.
    const before = all.filter(x => x.source === 'winget' && x.id === p.id).map(x => x.version)
    let after: string[] = []
    let rescanned = false
    try {
      const [winget] = await api.pkgScan(['winget'])
      setResults(rs => rs && rs.map(r => (r.id === 'winget' ? winget : r)))
      after = winget.packages.filter(x => x.id === p.id).map(x => x.version)
      rescanned = true
    } catch (e) {
      setError(String(e))
    }
    const now = after.find(v => !before.includes(v))
    if (now) {
      setUpgraded({ name: p.name, from: p.version, to: now })
      addActivity({ module: 'packages', action: 'Upgraded package', outcome: 'success', detail: `${p.name} ${p.version} → ${now}` })
    } else {
      addActivity({
        module: 'packages',
        action: 'Upgraded package',
        outcome: 'info',
        detail: !rescanned ? `winget finished upgrading ${p.name}. Rescan to see the installed version.`
          : after.length === 0 ? `winget finished, but ${p.name} no longer appears in winget list.`
          : `winget finished, but ${p.name} still reports ${p.version}. Some installers finish after a restart.`,
      })
    }
    setUpgrading(null)
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
        subtitle="Everything your package managers have installed on this machine."
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

      {upgradeError && (
        <ErrorBanner title={`Could not upgrade ${upgradeError.name}`} error={upgradeError.error} detailLabel="What winget reported" />
      )}

      {loading && !results && <div className="img-loading">Scanning package managers…</div>}

      {results && found.length === 0 && !loading && (
        <Prerequisite
          title="No package managers found"
          description="None of the supported package managers are on PATH. winget ships with Windows 11; if it is missing, install App Installer from the Microsoft Store. Verify with the command below, then rescan."
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

            <span role="status">
              {upgrading && <Tag tone="accent">Upgrading {upgrading.name}, output in the terminal</Tag>}
              {upgraded && <Tag tone="ok">{upgraded.name} {upgraded.from} → {upgraded.to}</Tag>}
            </span>

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
                        {p.upgrade_command && (
                          <Button
                            size="sm"
                            className="pkg-upgrade"
                            onClick={() => setConfirm(p)}
                            disabled={upgrading !== null}
                            aria-label={`Upgrade ${p.name} to ${p.available}`}
                          >
                            {upgrading?.id === p.id ? 'Upgrading…' : 'Upgrade'}
                          </Button>
                        )}
                      </td>
                      <td className="img-td img-age">{p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="pkg-note">
            {missing.length > 0 && <>Not found here: {missing.map(r => r.label).join(', ')}. </>}
            Only winget reports available upgrades in a plain list, so the Updates count and the Upgrade button cover winget alone.
          </p>
        </div>
      )}
      </div>

      {confirm?.upgrade_command && (
        <Modal icon={<CircleArrowUp size={16} />} title={`Upgrade ${confirm.name}?`} onClose={() => setConfirm(null)}>
          <p className="modal-body">
            winget downloads version <strong>{confirm.available}</strong> and installs it over <strong>{confirm.version}</strong>.
            This needs an internet connection. Close {confirm.name} first if it is open. Some installers ask for
            administrator approval, and an upgrade cannot be stopped once it starts.
          </p>
          <div className="cmd-block">
            <span className="cmd-block-label">Exact command</span>
            <code className="cmd-block-code">{confirm.upgrade_command}</code>
          </div>
          <div className="modal-actions">
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => runUpgrade(confirm)}>
              <CircleArrowUp size={13} /> Upgrade
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
