import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Download, CircleArrowUp, Trash2, Columns3, Check, RotateCcw } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import { SortHeader } from '../docker/components/TableBits'
import { Modal } from '../wsl/components/Dialog'
import {
  SheetHead, Prerequisite, Button, SearchField, ErrorBanner, Toolbar,
  Segmented, SegmentedItem, EmptyState, Tag,
} from '../../components/ui'
import * as api from './api'
import type { Package, SourceResult, UninstallCheck } from './types'

type SortKey = 'name' | 'version' | 'updated' | 'publisher' | 'source'

/** Table columns in display order, with default widths in px. Name and Actions
 *  cannot be hidden. */
const COLUMNS: { key: string; label: string; width: number; sort?: SortKey; hideable?: boolean }[] = [
  { key: 'name',      label: 'Name',      width: 220, sort: 'name' },
  { key: 'id',        label: 'Id',        width: 170, hideable: true },
  { key: 'version',   label: 'Version',   width: 110, sort: 'version', hideable: true },
  { key: 'available', label: 'Available', width: 190, hideable: true },
  { key: 'updated',   label: 'Updated',   width: 100, sort: 'updated', hideable: true },
  { key: 'publisher', label: 'Publisher', width: 170, sort: 'publisher', hideable: true },
  { key: 'location',  label: 'Location',  width: 260, hideable: true },
  { key: 'source',    label: 'Source',    width: 110, sort: 'source', hideable: true },
  { key: 'actions',   label: 'Actions',   width: 96 },
]
const MIN_WIDTH = 60
const MAX_WIDTH = 900

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
  const [broken, setBroken]     = useState<{ name: string; lines: string[] } | null>(null)

  const pkgColumns    = useAppStore(s => s.pkgColumns)
  const setPkgColumns = useAppStore(s => s.setPkgColumns)
  // Widths while a drag is in progress, so the saved settings are written once
  // when it ends rather than on every pointer move.
  const [dragWidths, setDragWidths] = useState<Record<string, number> | null>(null)
  const widths  = dragWidths ?? pkgColumns.widths
  const visible = COLUMNS.filter(c => !pkgColumns.hidden.includes(c.key))
  const shows   = (key: string) => visible.some(c => c.key === key)
  const widthOf = (c: (typeof COLUMNS)[number]) => widths[c.key] ?? c.width
  // Name fills the spare width until it is resized, then a filler column does.
  const nameFixed  = widths.name !== undefined
  const tableWidth = visible.reduce((sum, c) => sum + widthOf(c), 0)

  // Both read the store at call time: two clicks can land before a re-render.
  const resizeColumn = (key: string, width: number | null, done: boolean) => {
    const saved = useAppStore.getState().pkgColumns
    const next = { ...saved.widths }
    if (width === null) delete next[key]
    else next[key] = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
    if (done) {
      setPkgColumns({ ...saved, widths: next })
      setDragWidths(null)
    } else {
      setDragWidths(next)
    }
  }
  const toggleColumn = (key: string) => {
    const saved = useAppStore.getState().pkgColumns
    setPkgColumns({
      ...saved,
      hidden: saved.hidden.includes(key) ? saved.hidden.filter(k => k !== key) : [...saved.hidden, key],
    })
  }

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

  // Rescan one source so its rows show what is installed now, not what the
  // tool claimed it did. Null when the rescan itself failed. winget installs
  // are also uninstall keys, so Installed apps is rescanned with winget.
  const rescanSource = async (id: string): Promise<Package[] | null> => {
    try {
      const fresh = await api.pkgScan(id === 'winget' ? [id, 'registry'] : [id])
      setResults(rs => rs && rs.map(r => fresh.find(f => f.id === r.id) ?? r))
      return fresh[0].packages
    } catch (e) {
      setError(String(e))
      return null
    }
  }

  const runUpgrade = async (p: Package) => {
    setConfirm(null)
    startJob('upgrade', p)
    try {
      await api.pkgUpgrade(p.id)
    } catch (e) {
      setJobError({ title: `Could not upgrade ${p.name}`, error: e })
      addActivity({ module: 'packages', action: 'Upgrade package', outcome: 'failure', detail: `${p.name}: ${String(e)}` })
      setJob(null)
      return
    }
    // One id can have several installs (an old x86 copy beside the x64 one),
    // so the new version is the one that was not there before.
    const before = all.filter(x => x.source === 'winget' && x.id === p.id).map(x => x.version)
    const fresh = await rescanSource('winget')
    const after = (fresh ?? []).filter(x => x.id === p.id).map(x => x.version)
    const now = after.find(v => !before.includes(v))
    if (now) {
      setDone(`${p.name} ${p.version} → ${now}`)
      addActivity({ module: 'packages', action: 'Upgraded package', outcome: 'success', detail: `${p.name} ${p.version} → ${now}` })
    } else {
      addActivity({
        module: 'packages',
        action: 'Upgraded package',
        outcome: 'info',
        detail: fresh === null ? `winget finished upgrading ${p.name}. Rescan to see the installed version.`
          : after.length === 0 ? `winget finished, but ${p.name} no longer appears in winget list.`
          : `winget finished, but ${p.name} still reports ${p.version}. Some installers finish after a restart.`,
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
      setJob(null)
      return
    }
    const fresh = await rescanSource(p.source)
    const gone = fresh !== null && !fresh.some(x => x.id === p.id && x.version === p.version)
    if (gone) setDone(`Removed ${nameWithVersion(p)}`)
    if (missingReqs.length) setBroken({ name: p.name, lines: missingReqs })
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
        subtitle="Everything your package managers have installed on this machine."
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
                hidden={pkgColumns.hidden}
                onToggle={toggleColumn}
                onReset={() => setPkgColumns(useAppStore.getInitialState().pkgColumns)}
              />
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
        <ErrorBanner title={jobError.title} error={jobError.error} detailLabel="What the tool reported" />
      )}

      {broken && (
        <ErrorBanner title={`Removing ${broken.name} left packages missing a requirement`}>
          {broken.lines.join(' ')}
        </ErrorBanner>
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

            <Segmented label="Filter by source. Pick one or more.">
              <SegmentedItem active={active.length === 0} count={all.length} onClick={() => setPicked([])}>
                All
              </SegmentedItem>
              {listed.map(r => (
                <SegmentedItem
                  key={r.id}
                  active={active.includes(r.id)}
                  count={r.packages.length}
                  onClick={() => togglePick(r.id)}
                  title={`${r.command}\nClick to add or remove this source.`}
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
              Updates <span className="segmented-count num">{outdatedCount}</span>
            </button>

            <span role="status">
              {job && (
                <Tag tone="accent">
                  {job.kind === 'upgrade' ? 'Upgrading' : 'Uninstalling'} {job.pkg.name}, output in the terminal
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
              <table className="img-table pkg-table" style={{ width: tableWidth }}>
                <colgroup>
                  {visible.map(c => (
                    <col key={c.key} style={c.key === 'name' && !nameFixed ? undefined : { width: widthOf(c) }} />
                  ))}
                  {nameFixed && <col />}
                </colgroup>
                <thead>
                  <tr>
                    {visible.map(c => {
                      const handle = (
                        <ResizeHandle
                          label={c.label}
                          width={widthOf(c)}
                          onResize={(w, done) => resizeColumn(c.key, w, done)}
                        />
                      )
                      return c.sort ? (
                        <SortHeader key={c.key} label={c.label} col={c.sort} sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                          {handle}
                        </SortHeader>
                      ) : (
                        <th key={c.key} className={clsx('img-th', c.key === 'actions' && 'ctr-th-actions')}>
                          {c.label}{handle}
                        </th>
                      )
                    })}
                    {nameFixed && <th className="img-th" aria-hidden="true" />}
                  </tr>
                </thead>
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
                            {isJob('uninstall', p) ? 'Removing…' : 'Uninstall'}
                          </Button>
                        )}
                      </td>
                      {nameFixed && <td className="img-td" />}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="pkg-note">
            {missing.length > 0 && <>Not found here: {missing.map(r => r.label).join(', ')}. </>}
            {empty.length > 0 && <>No packages: {empty.map(r => r.label).join(', ')}. </>}
            Only winget reports available upgrades in a plain list, so the Updates count and the Upgrade button cover winget alone.
            Uninstall covers winget, pip, npm, and VS Code. Updated dates come from each tool's own record or the install
            folder, so treat them as approximate.
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

/** The right edge of a header cell. Drag it, or focus it and press the arrow
 *  keys, to resize the column. Double-click restores the default width. */
function ResizeHandle({ label, width, onResize }: {
  label: string
  width: number
  /** `null` resets to the default. `done` is false while a drag is moving. */
  onResize: (width: number | null, done: boolean) => void
}) {
  const cellWidth = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? width

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const x0 = e.clientX
    const w0 = cellWidth(el)
    let last = w0
    const move = (ev: PointerEvent) => { last = w0 + ev.clientX - x0; onResize(last, false) }
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('lostpointercapture', end)
      onResize(last, true)
    }
    el.setPointerCapture(e.pointerId)
    el.addEventListener('pointermove', move)
    el.addEventListener('lostpointercapture', end)
  }

  return (
    <div
      className="col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      // The header cell sorts on click, and a resize is not a sort.
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => { e.stopPropagation(); onResize(null, true) }}
      onKeyDown={e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        onResize(cellWidth(e.currentTarget) + (e.key === 'ArrowRight' ? 16 : -16), true)
      }}
    />
  )
}

/** Toggles which optional columns the table shows. */
function ColumnsMenu({ hidden, onToggle, onReset }: {
  hidden: string[]
  onToggle: (key: string) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <Button onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        <Columns3 size={13} /> Columns
      </Button>
      {open && (
        <div className="menu-panel" role="menu" aria-label="Columns">
          {COLUMNS.filter(c => c.hideable).map(c => {
            const on = !hidden.includes(c.key)
            return (
              <button key={c.key} className="menu-item" role="menuitemcheckbox" aria-checked={on} onClick={() => onToggle(c.key)}>
                {on ? <Check size={14} /> : <span className="menu-check" />}
                {c.label}
              </button>
            )
          })}
          <div className="menu-sep" role="separator" />
          <button className="menu-item" role="menuitem" onClick={() => { onReset(); setOpen(false) }}>
            <RotateCcw size={14} /> Reset columns
          </button>
        </div>
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
      <div className="cmd-block">
        <span className="cmd-block-label">Exact command</span>
        <code className="cmd-block-code">{check.command}</code>
      </div>
      <p className="wsl-estimate-note">To put it back later: <code>{check.reinstall_command}</code></p>
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
