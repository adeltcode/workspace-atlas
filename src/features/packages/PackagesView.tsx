import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Download, CircleArrowUp, Filter, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import { Modal } from '../wsl/components/Dialog'
import {
  SheetHead, Prerequisite, Button, SearchField, ErrorBanner, Toolbar, EmptyState, Tag,
} from '../../components/ui'
import { CheckMenu, ColumnsMenu, TableHead, useTableColumns, type TableColumn } from '../../components/TableColumns'
import * as api from './api'
import type { Package, PackageUpdate, SourceResult, SourceUpdates, UninstallCheck } from './types'

type SortKey = 'name' | 'version' | 'updated' | 'publisher' | 'source'

/** Table columns in display order, with default widths in px. Name and Actions
 *  cannot be hidden. */
const COLUMNS: TableColumn<SortKey>[] = [
  // The defaults that start visible add up to 930, which fits the table at a
  // 1280px window. Name takes whatever is left over.
  { key: 'name',      label: 'Name',      width: 180, sort: 'name' },
  { key: 'id',        label: 'ID',        width: 150, hideable: true },
  { key: 'version',   label: 'Version',   width: 100, sort: 'version', hideable: true },
  { key: 'available', label: 'Available', width: 180, hideable: true },
  { key: 'updated',   label: 'Updated',   width: 96, sort: 'updated', hideable: true },
  { key: 'publisher', label: 'Publisher', width: 170, sort: 'publisher', hideable: true },
  { key: 'location',  label: 'Location',  width: 260, hideable: true },
  { key: 'source',    label: 'Source',    width: 128, sort: 'source', hideable: true },
  { key: 'actions',   label: 'Actions',   width: 96 },
]

/** Local calendar date as YYYY-MM-DD. */
function formatDate(secs: number): string {
  const d = new Date(secs * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Quote a CSV field, and defuse the leading characters a spreadsheet treats as
 *  a formula. Package names are untrusted text once they land in Excel. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** The backend wraps a command this way when it needs administrator rights. */
const runsAsAdmin = (command: string) => command.includes('-Verb RunAs')
const ADMIN_NOTE = 'Windows asks for administrator approval, and this runs in its own window, so its output stays there.'

/** Name and version, without repeating a version winget already put in the name. */
const nameWithVersion = (p: Package) => (p.name.includes(p.version) ? p.name : `${p.name} ${p.version}`)

export default function PackagesView() {
  const addActivity = useAppStore(s => s.addActivity)

  const [results, setResults] = useState<SourceResult[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [query, setQuery]     = useState('')
  // Picked source ids. Empty means all.
  const [picked, setPicked]   = useState<string[]>([])
  const [outdatedOnly, setOutdatedOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [exporting, setExporting] = useState(false)
  const [confirm, setConfirm]     = useState<Package | null>(null)
  const [removing, setRemoving]   = useState<{
    pkg: Package
    /** Set when several installs share the id, so winget removes this one. */
    pinned: string | null
    check: UninstallCheck | null
    checkError: unknown
  } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  // One upgrade or uninstall at a time; the backend enforces the same.
  const [job, setJob]           = useState<{ kind: 'upgrade' | 'uninstall'; pkg: Package } | null>(null)
  const [done, setDone]         = useState<string | null>(null)
  const [jobError, setJobError] = useState<{ title: string; error: unknown } | null>(null)
  const [broken, setBroken]     = useState<{ title: string; lines: string[] } | null>(null)
  const [checking, setChecking]       = useState(false)
  const [checkFailed, setCheckFailed] = useState<SourceUpdates[]>([])
  // Last successful check per source. Kept apart from the scan results so a
  // rescan does not wipe it.
  const [updates, setUpdates] = useState<Record<string, PackageUpdate[]>>({})

  const pkgColumns    = useAppStore(s => s.pkgColumns)
  const setPkgColumns = useAppStore(s => s.setPkgColumns)
  const table = useTableColumns<SortKey>({
    columns: COLUMNS,
    fill: 'name',
    prefs: pkgColumns,
    read: () => useAppStore.getState().pkgColumns,
    save: setPkgColumns,
  })
  const { shows } = table

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
  // A checked version equal to the installed one means it has since been upgraded.
  const all     = useMemo(() => found.flatMap(r => r.packages).map(p => {
    const update = updates[p.source]?.find(u => u.id === p.id)
    return update && update.available !== p.version
      ? { ...p, available: update.available, upgrade_command: update.upgrade_command }
      : p
  }), [found, updates])
  const outdatedCount = useMemo(() => all.filter(p => p.available).length, [all])
  const labels  = useMemo(() => Object.fromEntries(found.map(r => [r.id, r.label])), [found])
  // Sources with nothing listed stay out of the filter. A failed one already
  // has its banner, so only the quietly empty ones go in the footer.
  const listed  = useMemo(() => found.filter(r => r.packages.length > 0), [found])
  const empty   = found.filter(r => r.packages.length === 0 && !r.error)
  // A pick whose source has since emptied no longer filters anything.
  const active  = useMemo(() => picked.filter(id => listed.some(r => r.id === id)), [picked, listed])
  const togglePick = (id: string) =>
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byName = (a: Package, b: Package) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    const value = (p: Package) =>
      sortKey === 'updated' ? p.updated : sortKey === 'source' ? labels[p.source] ?? p.source : p[sortKey]
    return all
      .filter(p => active.length === 0 || active.includes(p.source))
      .filter(p => !outdatedOnly || p.available)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .sort((a, b) => {
        const va = value(a), vb = value(b)
        // Unknown dates and publishers sort last in both directions.
        if (!va !== !vb) return va ? -1 : 1
        const cmp = typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va ?? '').localeCompare(String(vb ?? ''), undefined, { sensitivity: 'base' })
        // Ties fall back to name so sorting by source or version groups rows
        // instead of leaving them in scan order.
        return (sortDir === 'asc' ? cmp : -cmp) || byName(a, b)
      })
  }, [all, labels, query, active, outdatedOnly, sortKey, sortDir])

  // Exports exactly what the table currently shows, so a filtered view exports
  // filtered rows rather than silently widening back to everything.
  const exportCsv = async () => {
    setExporting(true)
    try {
      const csv = [
        'name,id,version,available,updated,publisher,location,source',
        ...rows.map(p => [
          p.name, p.id, p.version, p.available, p.updated ? formatDate(p.updated) : '', p.publisher, p.location, p.source,
        ].map(csvCell).join(',')),
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

  const startJob = (kind: 'upgrade' | 'uninstall', pkg: Package) => {
    setJob({ kind, pkg })
    setDone(null)
    setJobError(null)
    setBroken(null)
  }

  const checkUpdates = async () => {
    setChecking(true)
    setDone(null)
    setCheckFailed([])
    try {
      const checked = await api.pkgCheckUpdates()
      const ok = checked.filter(c => !c.error)
      setUpdates(u => ({ ...u, ...Object.fromEntries(ok.map(c => [c.source, c.updates])) }))
      setCheckFailed(checked.filter(c => c.error))
      const count = ok.reduce((sum, c) => sum + c.updates.length, 0)
      const summary = checked.length === 0
        ? 'npm, pip and Chocolatey are not installed'
        : `${count} update${count !== 1 ? 's' : ''} from ${ok.map(c => c.label).join(', ')}`
      if (ok.length > 0 || checked.length === 0) setDone(summary)
      addActivity({
        module: 'packages',
        action: 'Checked for updates',
        outcome: checked.some(c => c.error) ? 'info' : 'success',
        detail: [
          ok.length > 0 || checked.length === 0 ? summary : '',
          ...checked.filter(c => c.error).map(c => `${c.label}: ${c.error}`),
        ].filter(Boolean).join('. '),
      })
    } catch (e) {
      setError(String(e))
      addActivity({ module: 'packages', action: 'Check for updates', outcome: 'failure', detail: String(e) })
    } finally {
      setChecking(false)
    }
  }

  // Null when the rescan itself failed. Installers that winget or Chocolatey run also write
  // uninstall keys, which winget and Installed apps both list.
  const rescanSource = async (id: string): Promise<Package[] | null> => {
    try {
      const fresh = await api.pkgScan(id === 'winget' || id === 'choco' ? [id, 'winget', 'registry'] : [id])
      setResults(rs => rs && rs.map(r => fresh.find(f => f.id === r.id) ?? r))
      return fresh.find(f => f.id === id)?.packages ?? null
    } catch (e) {
      setError(String(e))
      return null
    }
  }

  const runUpgrade = async (p: Package) => {
    setConfirm(null)
    startJob('upgrade', p)
    let conflicts: string[]
    try {
      conflicts = await api.pkgUpgrade(p.source, p.id)
    } catch (e) {
      setJobError({ title: `Could not upgrade ${p.name}`, error: e })
      addActivity({ module: 'packages', action: 'Upgrade package', outcome: 'failure', detail: `${p.name}: ${String(e)}` })
      // A tool that stops halfway can still have changed what is installed.
      await rescanSource(p.source)
      setJob(null)
      return
    }
    // One id can have several installs (an old x86 copy beside the x64 one),
    // so the new version is the one that was not there before.
    const before = all.filter(x => x.source === p.source && x.id === p.id).map(x => x.version)
    const fresh = await rescanSource(p.source)
    const after = (fresh ?? []).filter(x => x.id === p.id).map(x => x.version)
    const now = after.find(v => !before.includes(v))
    const tool = labels[p.source] ?? p.source
    const conflictNote = conflicts.length ? `pip check reports: ${conflicts.join('; ')}` : ''
    if (conflicts.length) setBroken({ title: `After upgrading ${p.name}, pip check reports a conflict`, lines: conflicts })
    if (now) {
      setDone(`${p.name} ${p.version} → ${now}`)
      addActivity({
        module: 'packages',
        action: 'Upgraded package',
        outcome: conflicts.length ? 'info' : 'success',
        detail: [`${p.name} ${p.version} → ${now}`, conflictNote].filter(Boolean).join('. '),
      })
    } else {
      addActivity({
        module: 'packages',
        action: 'Upgraded package',
        outcome: 'info',
        detail: [
          fresh === null ? `${tool} finished upgrading ${p.name}. Rescan to see the installed version`
            : after.length === 0 ? `${tool} finished, but ${p.name} no longer appears in its list`
            : `${tool} finished, but ${p.name} still reports ${p.version}. Some installers finish after a restart`,
          conflictNote,
        ].filter(Boolean).join('. '),
      })
    }
    setJob(null)
  }

  const sameId = (p: Package) => all.filter(x => x.source === p.source && x.id === p.id).length
  const isJob = (kind: 'upgrade' | 'uninstall', p: Package) =>
    job?.kind === kind && job.pkg.source === p.source && job.pkg.id === p.id && job.pkg.version === p.version

  const openUninstall = async (p: Package) => {
    const pinned = p.source === 'winget' && sameId(p) > 1 ? p.version : null
    setConfirmText('')
    setRemoving({ pkg: p, pinned, check: null, checkError: null })
    try {
      const check = await api.pkgUninstallCheck(p.source, p.id, p.name, p.version, pinned)
      setRemoving(r => (r?.pkg === p ? { ...r, check } : r))
    } catch (e) {
      setRemoving(r => (r?.pkg === p ? { ...r, checkError: e } : r))
    }
  }

  const closeUninstall = () => {
    setRemoving(null)
    setConfirmText('')
  }

  const runUninstall = async () => {
    if (!removing?.check) return
    const { pkg: p, pinned, check } = removing
    closeUninstall()
    startJob('uninstall', p)
    let missingReqs: string[]
    try {
      missingReqs = await api.pkgUninstall(p.source, p.id, pinned, check.core ? confirmText : null)
    } catch (e) {
      setJobError({ title: `Could not uninstall ${p.name}`, error: e })
      addActivity({ module: 'packages', action: 'Uninstall package', outcome: 'failure', detail: `${p.name}: ${String(e)}` })
      await rescanSource(p.source)
      setJob(null)
      return
    }
    const fresh = await rescanSource(p.source)
    const gone = fresh !== null && !fresh.some(x => x.id === p.id && x.version === p.version)
    if (gone) setDone(`Uninstalled ${nameWithVersion(p)}`)
    if (missingReqs.length) setBroken({ title: `Removing ${p.name} left packages missing a requirement`, lines: missingReqs })
    addActivity({
      module: 'packages',
      action: 'Uninstalled package',
      outcome: gone && !missingReqs.length ? 'success' : 'info',
      detail: [
        fresh === null ? `${p.source} finished removing ${p.name}. Rescan to confirm it is gone`
          : gone ? `${nameWithVersion(p)} (${p.source})`
          : `${p.source} finished, but ${nameWithVersion(p)} still appears. The uninstaller may need a restart or more steps`,
        missingReqs.length ? `Now missing a requirement: ${missingReqs.join('; ')}` : '',
        `Reinstall: ${check.reinstall_command}`,
      ].filter(Boolean).join('. '),
    })
    setJob(null)
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
        subtitle="Packages installed through package managers on this machine."
        status={results && (
          <span className="pill">
            <span className={clsx('rail-dot', found.length ? 'running' : 'stopped')} />
            {found.length
              ? `${all.length} installed across ${found.length} source${found.length !== 1 ? 's' : ''}`
              : 'no package managers found'}
          </span>
        )}
        actions={
          <>
            {found.length > 0 && (
              <ColumnsMenu
                columns={COLUMNS}
                hidden={pkgColumns.hidden}
                onToggle={table.toggle}
                onReset={() => setPkgColumns(useAppStore.getInitialState().pkgColumns)}
              />
            )}
            {found.length > 0 && (
              <Button
                onClick={checkUpdates}
                disabled={checking || loading}
                title="Ask npm, pip and Chocolatey for newer versions. Needs the internet."
              >
                <CircleArrowUp size={13} /> {checking ? 'Checking…' : 'Check for updates'}
              </Button>
            )}
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

      {jobError && (
        <ErrorBanner title={jobError.title} error={jobError.error} />
      )}

      {broken && <ErrorBanner title={broken.title}>{broken.lines.join(' ')}</ErrorBanner>}

      {checkFailed.map(c => (
        <ErrorBanner key={c.source} title={`Could not check ${c.label} for updates`}>{c.error}</ErrorBanner>
      ))}

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

            <CheckMenu
              label={<><Filter size={13} /> {active.length === 0 ? 'All sources' : active.length === 1 ? labels[active[0]] : `${active.length} sources`}</>}
              active={active.length > 0}
              menuLabel="Filter by source"
              items={listed.map(r => ({ key: r.id, label: r.label, checked: active.includes(r.id), count: r.packages.length, title: r.command }))}
              onToggle={togglePick}
              resetLabel="Show all sources"
              onReset={() => setPicked([])}
              alignLeft
            />

            <button
              className={clsx('pkg-toggle', outdatedOnly && 'active')}
              onClick={() => setOutdatedOnly(v => !v)}
              aria-pressed={outdatedOnly}
              title="Show only packages with a newer version available"
            >
              Updates <span className="segmented-count num">{outdatedCount}</span>
            </button>

            <span role="status">
              {checking && <Tag tone="accent">Checking for updates (see terminal)</Tag>}
              {job && (
                <Tag tone="accent">
                  {job.kind === 'upgrade' ? 'Upgrading' : 'Uninstalling'} {job.pkg.name} (see terminal)
                </Tag>
              )}
              {done && <Tag tone="ok">{done}</Tag>}
            </span>

            <span className="img-count">{rows.length} shown</span>
          </Toolbar>

          {rows.length === 0 ? (
            <EmptyState
              title="No packages match this search"
              description="Try a shorter search, a different source, or clear the Updates filter."
              actions={<Button onClick={() => { setQuery(''); setPicked([]); setOutdatedOnly(false) }}>Clear filters</Button>}
            />
          ) : (
            <div className="img-table-wrap">
              <table className="img-table pkg-table" style={{ width: table.tableWidth }}>
                <TableHead table={table} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} actionsClass="ctr-th-actions" />
                <tbody>
                  {rows.map((p, i) => (
                    // winget lists the same id more than once (two 7-Zip builds
                    // share 7zip.7zip), so the index keeps keys unique.
                    <tr key={`${p.source}-${p.id}-${p.version}-${i}`} className="img-row">
                      <td className="img-td img-repo" title={p.name}>{p.name}</td>
                      {shows('id') && <td className="img-td pkg-id" title={p.id}>{p.id}</td>}
                      {shows('version') && <td className="img-td img-size" title={p.version}>{p.version}</td>}
                      {shows('available') && (
                        <td className="img-td">
                          {p.available
                            ? <Tag tone="warn" className="num">{p.available}</Tag>
                            : <span className="pkg-dash">-</span>}
                          {p.upgrade_command && (
                            <Button
                              size="sm"
                              className="pkg-upgrade"
                              onClick={() => setConfirm(p)}
                              disabled={job !== null}
                              aria-label={`Upgrade ${p.name} to ${p.available}`}
                            >
                              {isJob('upgrade', p) ? 'Upgrading…' : 'Upgrade'}
                            </Button>
                          )}
                        </td>
                      )}
                      {shows('updated') && (
                        <td className="img-td img-age num">
                          {p.updated ? formatDate(p.updated) : <span className="pkg-dash">-</span>}
                        </td>
                      )}
                      {shows('publisher') && (
                        <td className="img-td img-age" title={p.publisher}>
                          {p.publisher || <span className="pkg-dash">-</span>}
                        </td>
                      )}
                      {shows('location') && (
                        <td className="img-td pkg-id" title={p.location}>
                          {p.location || <span className="pkg-dash">-</span>}
                        </td>
                      )}
                      {shows('source') && <td className="img-td img-age">{labels[p.source] ?? p.source}</td>}
                      <td className="img-td ctr-td-actions">
                        {p.uninstallable && (
                          <Button
                            size="sm"
                            variant="danger-outline"
                            onClick={() => openUninstall(p)}
                            disabled={job !== null}
                            aria-label={`Uninstall ${nameWithVersion(p)}`}
                          >
                            {isJob('uninstall', p) ? 'Uninstalling…' : 'Uninstall'}
                          </Button>
                        )}
                      </td>
                      {table.fillFixed && <td className="img-td" />}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="pkg-note">
            {missing.length > 0 && <>Not found here: {missing.map(r => r.label).join(', ')}. </>}
            {empty.length > 0 && <>No packages: {empty.map(r => r.label).join(', ')}. </>}
            winget updates show after every scan. Check for updates adds npm, pip and Chocolatey, and needs the internet.
            Uninstall covers winget, pip, npm, and VS Code. Updated dates come from each tool's own record or the install
            folder, so treat them as approximate.
          </p>
        </div>
      )}
      </div>

      {confirm?.upgrade_command && (
        <Modal icon={<CircleArrowUp size={16} />} title={`Upgrade ${confirm.name}?`} onClose={() => setConfirm(null)}>
          <p className="modal-body">
            {labels[confirm.source] ?? confirm.source} downloads version <strong>{confirm.available}</strong> and
            installs it over <strong>{confirm.version}</strong>. This needs an internet connection.
            {(confirm.source === 'winget' || confirm.source === 'choco') && <> Close {confirm.name} first if it is open.</>}
            {confirm.source === 'winget' && <> Some installers ask for administrator approval.</>}
            {runsAsAdmin(confirm.upgrade_command) && <> {ADMIN_NOTE}</>}
            {confirm.source === 'pip' && <> pip check runs afterwards to look for conflicts with other packages.</>}
            {' '}An upgrade cannot be stopped once it starts.
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

      {removing && (
        <Modal icon={<Trash2 size={16} />} iconDanger title={`Uninstall ${removing.pkg.name}?`} onClose={closeUninstall}>
          {removing.checkError ? (
            <ErrorBanner title="Could not check this package" error={removing.checkError} />
          ) : !removing.check ? (
            <p className="modal-body" role="status">Checking what depends on {removing.pkg.name}…</p>
          ) : (
            <UninstallReview
              pkg={removing.pkg}
              sourceLabel={found.find(r => r.id === removing.pkg.source)?.label ?? removing.pkg.source}
              check={removing.check}
              pinned={removing.pinned}
              installs={sameId(removing.pkg)}
              confirmText={confirmText}
              onConfirmText={setConfirmText}
            />
          )}
          <div className="modal-actions">
            <Button onClick={closeUninstall}>Cancel</Button>
            {removing.check && (
              <Button
                variant="danger"
                onClick={runUninstall}
                disabled={removing.check.core && confirmText.trim() !== removing.pkg.id}
              >
                <Trash2 size={13} /> Uninstall
              </Button>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

/** The pre-check findings, the exact command, and for core tools the typed
 *  confirmation. Warnings take the warning tone; facts stay neutral. */
function UninstallReview({ pkg, sourceLabel, check, pinned, installs, confirmText, onConfirmText }: {
  pkg: Package
  sourceLabel: string
  check: UninstallCheck
  pinned: string | null
  installs: number
  confirmText: string
  onConfirmText: (value: string) => void
}) {
  return (
    <>
      <p className="modal-body">
        This removes <strong>{nameWithVersion(pkg)}</strong> using {sourceLabel}.
        {check.core && <> It is a <strong>core tool</strong> that other tools rely on.</>}
      </p>
      <div className="wsl-estimate">
        {check.needed_by && (
          <div className={clsx('wsl-estimate-row', check.needed_by.length > 0 && 'pkg-check-warn')}>
            <span>Needed by</span>
            <strong>{check.needed_by.length ? check.needed_by.join(', ') : 'nothing installed'}</strong>
          </div>
        )}
        {check.commands.length > 0 && (
          <div className="wsl-estimate-row pkg-check-warn">
            <span>Commands removed</span><strong>{check.commands.join(', ')}</strong>
          </div>
        )}
        {check.running && (
          <div className={clsx('wsl-estimate-row', check.running.length > 0 && 'pkg-check-warn')}>
            <span>Running now</span>
            <strong>{check.running.length ? check.running.join(', ') : 'no'}</strong>
          </div>
        )}
        {check.files !== null && (
          <div className="wsl-estimate-row"><span>Files deleted</span><strong>{check.files}</strong></div>
        )}
        {pinned && (
          <div className="wsl-estimate-row">
            <span>Installs with this ID</span><strong>{installs}, removes {pinned} only</strong>
          </div>
        )}
      </div>
      {check.running && check.running.length > 0 && (
        <p className="wsl-estimate-note">Close it before uninstalling, or the uninstaller may fail or ask to restart.</p>
      )}
      {check.limits.map(limit => <p key={limit} className="wsl-estimate-note">{limit}</p>)}
      {runsAsAdmin(check.command) && <p className="wsl-estimate-note">{ADMIN_NOTE}</p>}
      <div className="cmd-block">
        <span className="cmd-block-label">Exact command</span>
        <code className="cmd-block-code">{check.command}</code>
      </div>
      <p className="wsl-estimate-note">To reinstall later: <code>{check.reinstall_command}</code></p>
      {check.core && (
        <>
          <label className="wsl-import-label" htmlFor="pkg-uninstall-confirm" style={{ marginTop: 12 }}>
            Type <strong>{pkg.id}</strong> to confirm
          </label>
          <input
            id="pkg-uninstall-confirm"
            className="modal-input"
            type="text"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={pkg.id}
            value={confirmText}
            onChange={e => onConfirmText(e.target.value)}
          />
        </>
      )}
    </>
  )
}
