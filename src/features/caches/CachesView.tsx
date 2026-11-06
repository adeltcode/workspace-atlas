import { Fragment, useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Eraser, Filter, FolderOpen, Info, Plus, RefreshCw, Square, Trash2, X } from 'lucide-react'
import { toggled } from '../../utils/toggled'
import { useAppStore } from '../../store/appStore'
import { bytesToHuman, timeAgo } from '../../utils/format'
import { Button, ConfirmDestructive, EmptyState, ErrorBanner, SearchField, Segmented, SegmentedItem, SheetHead, Toast, Toolbar, NoMatches } from '../../components/ui'
import { CheckMenu, ColumnsMenu, TableHead, useTableColumns, type TableColumn, useTableSort } from '../../components/TableColumns'
import { FileDropPrompt, FileDropZone } from '../../components/FileDropZone'
import { revealPath } from '../docker/api'
import { pickDirectory } from '../wsl/api'
import * as api from './api'
import type { CacheItem, ClearFailure } from './api'
import { runCacheScan } from './scan'
import {
  afterClear, cacheCount, clearCommand, clearNotes, clearSummary, filterItems, IDLE_DAYS, isIdle, itemKey, KIND_LABEL,
  restoreIsCommand, sortItems, totalBytes, type CacheFilter, type CacheSortKey,
} from './rules'

/** The defaults that start visible add up to about 1000, which fits the table at a 1280px window. */
const COLUMNS: TableColumn<CacheSortKey>[] = [
  { key: 'select',   label: 'Select',          width: 36 },
  { key: 'name',     label: 'Name',            width: 170, sort: 'name' },
  { key: 'type',     label: 'Type',            width: 140, sort: 'type',     hideable: true },
  { key: 'size',     label: 'Size',            width: 90,  sort: 'size',     hideable: true },
  { key: 'files',    label: 'Files',           width: 90,  sort: 'files',    hideable: true },
  { key: 'used',     label: 'Last modified',   width: 120, sort: 'used',     hideable: true },
  { key: 'restore',  label: 'Regenerate with', width: 160, sort: 'restore',  hideable: true },
  { key: 'location', label: 'Location',        width: 190, sort: 'location', hideable: true },
  { key: 'actions',  label: 'Actions',         width: 84 },
]

const MAX_FAILURES_SHOWN = 3

export default function CachesView() {
  const scan = useAppStore(s => s.cacheScan)
  const progress = useAppStore(s => s.cacheScanProgress)
  const scanError = useAppStore(s => s.cacheScanError)
  const roots = useAppStore(s => s.cacheRoots)
  const setRoots = useAppStore(s => s.setCacheRoots)
  const table = useTableColumns<CacheSortKey>({
    columns: COLUMNS,
    fill: 'location',
    select: s => s.cacheColumns,
    save: prefs => useAppStore.getState().setCacheColumns(prefs),
  })

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CacheFilter>('all')
  const [kinds, setKinds] = useState<string[]>([])
  const { sortKey, sortDir, handleSort } = useTableSort<CacheSortKey>('size', 'desc', ['size', 'files', 'used'])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState<CacheItem[] | null>(null)
  const [clearing, setClearing] = useState<{ done: number; total: number } | null>(null)
  const [failures, setFailures] = useState<ClearFailure[]>([])
  const [actionError, setActionError] = useState<unknown>(null)
  const [message, setMessage] = useState<string | null>(null)

  const scanning = progress !== null
  const busy = scanning || clearing !== null

  useEffect(() => {
    if (!useAppStore.getState().cacheScan) runCacheScan()
  }, [])

  const items = useMemo(() => scan?.items ?? [], [scan])
  const now = Math.floor(Date.now() / 1000)
  const rows = useMemo(() => sortItems(filterItems(items, query, filter, kinds, now), sortKey, sortDir), [items, query, filter, kinds, now, sortKey, sortDir])
  const presentKinds = useMemo(() => [...new Set(items.map(item => item.kind))], [items])
  const chosen = useMemo(() => items.filter(item => selected.has(itemKey(item))), [items, selected])
  const notes = confirming ? clearNotes(confirming) : []

  const allShownSelected = rows.length > 0 && rows.every(item => selected.has(itemKey(item)))
  const someShownSelected = !allShownSelected && rows.some(item => selected.has(itemKey(item)))

  const toggle = (item: CacheItem) => setSelected(previous => toggled(previous, itemKey(item)))

  const toggleShown = () => setSelected(allShownSelected ? new Set() : new Set(rows.map(itemKey)))

  const addRoots = (paths: string[]) => {
    const known = new Set(useAppStore.getState().cacheRoots.map(root => root.toLowerCase()))
    setRoots([...useAppStore.getState().cacheRoots, ...paths.filter(path => !known.has(path.toLowerCase()))])
    runCacheScan()
  }

  const chooseRoot = async () => {
    const picked = await pickDirectory().catch(e => { setActionError(e); return null })
    if (picked) addRoots([picked])
  }

  const removeRoot = (root: string) => {
    setRoots(useAppStore.getState().cacheRoots.filter(r => r !== root))
    runCacheScan()
  }

  const clear = async () => {
    if (!confirming) return
    const targets = confirming
    const { addActivity, setCacheScan } = useAppStore.getState()
    setActionError(null)
    setFailures([])
    setMessage(null)
    setClearing({ done: 0, total: targets.flatMap(item => item.paths).length })
    const unlisten = await listen<{ done: number; total: number }>('cache-clear-progress', e => setClearing(e.payload))
    try {
      const result = await api.cachesClear(targets.flatMap(item => item.paths))
      const current = useAppStore.getState().cacheScan
      if (current) setCacheScan(afterClear(current, result.removed))
      setFailures(result.failed)
      setSelected(new Set())
      const summary = clearSummary(targets, result)
      if (result.removed.length > 0) setMessage(summary)
      addActivity({
        module: 'system',
        action: 'Clear dev caches',
        outcome: result.failed.length === 0 ? 'success' : 'failure',
        detail: [summary, ...result.failed.map(failure => `Could not clear ${failure.path}`)].join('\n'),
      })
    } catch (e) {
      setActionError(e)
      addActivity({ module: 'system', action: 'Clear dev caches', outcome: 'failure', detail: String(e) })
    } finally {
      unlisten()
      setClearing(null)
      setConfirming(null)
    }
  }

  const cell = (column: string, item: CacheItem) => {
    const location = item.paths[0]
    switch (column) {
      case 'select':
        return (
          <td className="img-td img-td-check">
            <input
              type="checkbox"
              className="row-checkbox"
              aria-label={`Select ${item.name}, ${KIND_LABEL[item.kind]}`}
              checked={selected.has(itemKey(item))}
              onChange={() => toggle(item)}
            />
          </td>
        )
      case 'name':
        return (
          <td className="img-td" title={item.name}>
            <span className="img-repo">{item.name}</span>
            {item.note && <span className="cache-note" title={item.note}><Info size={13} role="img" aria-label={item.note} /></span>}
          </td>
        )
      case 'type':     return <td className="img-td img-age">{KIND_LABEL[item.kind]}</td>
      case 'size':     return <td className="img-td img-age num">{bytesToHuman(item.size_bytes)}</td>
      case 'files':    return <td className="img-td img-age num">{item.file_count.toLocaleString()}</td>
      case 'used':
        return (
          <td className="img-td img-age num" title={item.last_used ? new Date(item.last_used * 1000).toLocaleString() : undefined}>
            {item.last_used ? timeAgo(item.last_used * 1000) : <span className="pkg-dash">-</span>}
          </td>
        )
      case 'restore':
        return item.restore
          ? <td className={`img-td img-age ${restoreIsCommand(item) ? 'holder-code' : ''}`} title={item.restore}>{item.restore}</td>
          : <td className="img-td img-age">Manual</td>
      case 'location':
        return <td className="img-td img-age holder-code" title={item.paths.join('\n')}>{location}{item.paths.length > 1 && ` and ${item.paths.length - 1} more`}</td>
      default:
        return (
          <td className="img-td holder-actions">
            <Button
              size="sm"
              icon
              variant="ghost"
              aria-label={`Show ${location} in Explorer`}
              title="Show in Explorer"
              onClick={() => { revealPath(location).catch(setActionError) }}
            >
              <FolderOpen size={13} />
            </Button>
            <Button
              size="sm"
              icon
              variant="ghost"
              disabled={busy}
              aria-label={`Clear ${item.name}, ${KIND_LABEL[item.kind]}`}
              title="Clear"
              onClick={() => setConfirming([item])}
            >
              <Trash2 size={13} />
            </Button>
          </td>
        )
    }
  }

  return (
    <div className="view-container">
      <SheetHead
        title="Dev caches"
        status={(scan || scanning) && (
          <span className="pill">
            {scanning ? 'Scanning…' : `${bytesToHuman(totalBytes(items))} total`}
          </span>
        )}
        subtitle="Reclaim disk space from dependency directories, build artifacts, and package manager caches."
        actions={
          <>
            <ColumnsMenu table={table} />
            {scanning
              ? <Button onClick={() => { api.cachesScanStop().catch(setActionError) }}><Square size={12} /> Stop</Button>
              : <Button disabled={busy} onClick={runCacheScan}><RefreshCw size={12} /> Rescan</Button>}
            <Button variant="danger-outline" disabled={busy || chosen.length === 0} onClick={() => setConfirming(chosen)}>
              <Trash2 size={12} /> {chosen.length === 0 ? 'Clear selected' : `Clear ${cacheCount(chosen.length)} (${bytesToHuman(totalBytes(chosen))})`}…
            </Button>
          </>
        }
      />

      <div className="page-fill">
        <FileDropZone className="img-tab" label="Drop to add this folder" disabled={busy || confirming !== null} onDrop={addRoots}>
          <Toolbar className="cache-toolbar">
            <SearchField value={query} onChange={setQuery} placeholder="Search caches" label="Search by name, type, or location" />
            <Button className="cache-folders-button" popoverTarget="cache-folders">
              <FolderOpen size={13} /> {roots.length === 0 ? 'Folders' : roots.length === 1 ? '1 folder' : `${roots.length} folders`}
            </Button>
            <div id="cache-folders" className="menu-panel cache-folders" popover="auto" role="group" aria-label="Folders to scan">
              {roots.map(root => (
                <div key={root} className="cache-folder">
                  <span className="cache-folder-path holder-code" title={root}>{root}</span>
                  <Button size="sm" icon variant="ghost" disabled={busy} aria-label={`Remove ${root} from the scan`} title="Remove" onClick={() => removeRoot(root)}>
                    <X size={13} />
                  </Button>
                </div>
              ))}
              {roots.length > 0 && <div className="menu-sep" role="separator" />}
              <button className="menu-item" disabled={busy} onClick={chooseRoot}><Plus size={14} /> Add folder…</button>
            </div>
            <CheckMenu
              label={<><Filter size={13} /> {kinds.length === 0 ? 'All types' : kinds.length === 1 ? KIND_LABEL[kinds[0] as CacheItem['kind']] : `${kinds.length} types`}</>}
              active={kinds.length > 0}
              menuLabel="Filter by type"
              items={presentKinds.map(kind => ({
                key: kind,
                label: KIND_LABEL[kind],
                checked: kinds.includes(kind),
                count: items.filter(item => item.kind === kind).length,
              }))}
              onToggle={kind => setKinds(previous => (previous.includes(kind) ? previous.filter(k => k !== kind) : [...previous, kind]))}
              resetLabel="Show all types"
              onReset={() => setKinds([])}
              alignLeft
            />
            <Segmented label="Show caches">
              <SegmentedItem active={filter === 'all'} count={items.length} onClick={() => setFilter('all')}>All</SegmentedItem>
              <SegmentedItem
                active={filter === 'idle'}
                count={items.filter(item => isIdle(item, now)).length}
                title={`Not modified in the last ${IDLE_DAYS} days`}
                onClick={() => setFilter('idle')}
              >
                Stale
              </SegmentedItem>
            </Segmented>
            <span className="img-count">{rows.length} shown · {bytesToHuman(totalBytes(rows))}</span>
          </Toolbar>

          {scanning && (
            <p className="cache-progress holder-summary" role="status" title={progress.folder}>
              {progress.found} found. {progress.folder && `Scanning ${progress.folder}`}
            </p>
          )}
          {scan?.stopped && !scanning && <p className="holder-summary">Scan stopped. Results are incomplete.</p>}

          {scanError != null && <ErrorBanner className="error-banner--flush" title="Could not scan for caches" error={scanError} />}
          {actionError != null && <ErrorBanner className="error-banner--flush" title="That did not work" error={actionError} />}
          {scan && scan.skipped_roots.length > 0 && !scanning && (
            <ErrorBanner className="error-banner--flush" title="Some folders were skipped">
              {scan.skipped_roots.join(', ')}: not found, or excluded from scanning (AppData, Program Files, and dot-prefixed folders).
            </ErrorBanner>
          )}
          {failures.slice(0, MAX_FAILURES_SHOWN).map(failure => (
            <ErrorBanner key={failure.path} className="error-banner--flush" title={`Could not clear ${failure.path}`} error={failure.error} lockedPath={failure.path} />
          ))}
          {failures.length > 0 && (
            <p className="holder-summary">
              {failures.length > MAX_FAILURES_SHOWN && `${failures.length - MAX_FAILURES_SHOWN} more not shown. `}
              A partially cleared folder may be incomplete. Run its regenerate command before using it, then rescan to update its size.
            </p>
          )}

          {roots.length === 0 && !scanning && (
            <FileDropPrompt
              row
              title="Add a project folder"
              description="Only global caches are listed. Add a project folder to scan for node_modules, build artifacts, and virtual environments."
              actions={<Button disabled={busy} onClick={chooseRoot}><Plus size={12} /> Add folder…</Button>}
            />
          )}

          {!scan && scanning && <div className="img-loading">Scanning…</div>}

          {scan && !scanning && items.length === 0 && roots.length > 0 && (
            <EmptyState
              icon={Eraser}
              title="No caches found"
              description="No dependency directories or build artifacts were detected in the selected folders."
            />
          )}

          {items.length > 0 && rows.length === 0 && (
            <NoMatches noun="caches" onClear={() => { setQuery(''); setFilter('all'); setKinds([]) }} />
          )}

          {rows.length > 0 && (
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
                      aria-label="Select all shown caches"
                      checked={allShownSelected}
                      ref={el => { if (el) el.indeterminate = someShownSelected }}
                      onChange={toggleShown}
                    />
                  )}
                />
                <tbody>
                  {rows.map(item => (
                    <tr key={itemKey(item)} className={`img-row ${selected.has(itemKey(item)) ? 'row-selected' : ''}`}>
                      {table.visible.map(column => <Fragment key={column.key}>{cell(column.key, item)}</Fragment>)}
                      {table.fillFixed && <td className="img-td" aria-hidden="true" />}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Toast message={message} onDone={() => setMessage(null)} />
        </FileDropZone>
      </div>

      {confirming && (
        <ConfirmDestructive
          title={`Clear ${cacheCount(confirming.length)}?`}
          consequence={(
            <>
              These folders are permanently deleted and do not go to the Recycle Bin. Source files are not affected. Use the listed command to regenerate each one. Large projects can take several minutes to rebuild.
              {notes.map(note => <span key={note} className="cache-dialog-note">{note}</span>)}
            </>
          )}
          command={clearCommand(confirming)}
          summary={`${cacheCount(confirming.length)} · ${bytesToHuman(totalBytes(confirming))}`}
          items={confirming.map(item => ({ name: `${item.name}: ${KIND_LABEL[item.kind]}`, meta: bytesToHuman(item.size_bytes) }))}
          confirmLabel={`Clear ${cacheCount(confirming.length)}`}
          busyLabel={clearing ? `Clearing ${clearing.done} of ${clearing.total}…` : 'Clearing…'}
          busy={clearing !== null}
          onConfirm={clear}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}
