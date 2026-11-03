import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Download, CircleArrowUp, Trash2 } from 'lucide-react'
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

type SortKey = 'name' | 'version' | 'source'

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
  const [source, setSource]   = useState('all')
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

  const startJob = (kind: 'upgrade' | 'uninstall', pkg: Package) => {
    setJob({ kind, pkg })
    setDone(null)
    setJobError(null)
    setBroken(null)
  }

  // Rescan one source so its rows show what is installed now, not what the
  // tool claimed it did. Null when the rescan itself failed.
  const rescanSource = async (id: string): Promise<Package[] | null> => {
    try {
      const [fresh] = await api.pkgScan([id])
      setResults(rs => rs && rs.map(r => (r.id === id ? fresh : r)))
      return fresh.packages
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
                    <th className="img-th ctr-th-actions">Actions</th>
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
                            disabled={job !== null}
                            aria-label={`Upgrade ${p.name} to ${p.available}`}
                          >
                            {isJob('upgrade', p) ? 'Upgrading…' : 'Upgrade'}
                          </Button>
                        )}
                      </td>
                      <td className="img-td img-age">{p.source}</td>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="pkg-note">
            {missing.length > 0 && <>Not found here: {missing.map(r => r.label).join(', ')}. </>}
            Only winget reports available upgrades in a plain list, so the Updates count and the Upgrade button cover winget alone.
            Uninstall covers winget, pip, npm, and VS Code.
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
