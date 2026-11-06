import { useState, useMemo, useEffect, Fragment } from 'react'
import { listen } from '@tauri-apps/api/event'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { Trash2, HardDriveDownload, ChevronRight, ChevronDown, RotateCcw, FolderOpen, X, Database } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { DockerVolume, VolumeBackupEntry, BackupProgress } from '../types'
import { fmtBytes, formatDate } from '../../../utils/format'
import { ConfirmRemoveButton, StatusCell, useDockerJump, useDockerTable } from './TableBits'
import { CellLink, SearchField, Segmented, SegmentedItem, EmptyState, ErrorBanner, ConfirmDestructive, Button, Toolbar } from '../../../components/ui'
import { TableHead } from '../../../components/TableColumns'
import { filterVolumes, matchesVolumeFilter, sortVolumes, type SortDir, type VolumeFilter, type VolumeSortKey } from '../rules'

type VolStatus   = 'running' | 'done' | 'error'

const FILTERS: { key: VolumeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'in-use', label: 'In use' },
  { key: 'unused', label: 'Unused' },
]

const Dash = () => <span className="pkg-dash">-</span>

interface VolumeProgress {
  status:    VolStatus
  progress:  number
  message:   string
  filename?: string
  error?:    string
}

function fmtVolName(name: string): { display: string; full?: string } {
  if (/^[a-f0-9]{48,}$/i.test(name))
    return { display: name.slice(0, 12) + '…', full: name }
  return { display: name }
}

function truncFilename(name: string, max = 30): string {
  return name.length <= max ? name : name.slice(0, max - 1) + '…'
}

function ProgressBar({ p }: { p: VolumeProgress }) {
  return (
    <div className="vol-progress-wrap vol-progress-wrap--inline">
      <div
        className="vol-progress-track"
        role="progressbar"
        aria-label="Backup progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p.progress}
        aria-valuetext={`${p.progress}% - ${p.message}`}
      >
        <div
          className={clsx('vol-progress-fill',
            p.status === 'running' && 'running',
            p.status === 'done'    && 'done',
            p.status === 'error'   && 'error',
          )}
          style={{ transform: `scaleX(${p.progress / 100})` }}
        />
      </div>
      <div
        className={clsx('vol-progress-label', p.status === 'done' && 'ok', p.status === 'error' && 'err')}
        role="status"
      >
        {p.status === 'running' && p.message}
        {p.status === 'done'    && `✓ ${p.filename ?? 'Done'}`}
        {p.status === 'error'   && `✗ ${p.error ?? p.message}`}
      </div>
    </div>
  )
}

export default function VolumesTab({
  volumes,
  loading,
  onRefresh,
}: {
  volumes: DockerVolume[]
  loading: boolean
  onRefresh: () => void
}) {
  const [search, setSearch]           = useState('')
  const [usageFilter, setUsageFilter] = useState<VolumeFilter>('all')
  const [sortKey, setSortKey]         = useState<VolumeSortKey>('name')
  const [sortDir, setSortDir]         = useState<SortDir>('asc')
  const table = useDockerTable<VolumeSortKey>('volumes')

  useDockerJump('volumes', ({ query }) => {
    setSearch(query)
    setUsageFilter('all')
  })

  const handleSort = (key: VolumeSortKey) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'size' ? 'desc' : 'asc') }
  }

  // VolumesTab stays permanently mounted (tab-hidden pattern in DockerView).
  // React to volumesFilter store updates even while the tab is not visible.
  const volumesFilterSignal = useAppStore(s => s.volumesFilter)
  useEffect(() => {
    if (volumesFilterSignal === 'unused') {
      useAppStore.getState().setVolumesFilter(null)
      setUsageFilter('unused')
    }
  }, [volumesFilterSignal])
  const [busy, setBusy]               = useState<string | null>(null)
  const [pruningAll, setPruningAll]   = useState(false)
  const [confirmPrune, setConfirmPrune] = useState(false)
  // Holds the caught value rather than `String(e)`, so the banner can draw the
  // recovery hint and the raw Docker text the backend classified.
  const [actionError, setActionError] = useState<unknown>(null)

  const [expandedVol, setExpandedVol]       = useState<string | null>(null)
  const [volBackups, setVolBackups]         = useState<Record<string, VolumeBackupEntry[]>>({})
  const [loadingBackup, setLoadingBackup]   = useState<string | null>(null)

  const [selectedVols, setSelectedVols]     = useState<Set<string>>(new Set())

  const [volProgress, setVolProgress]       = useState<Record<string, VolumeProgress>>({})
  const [backingUpSet, setBackingUpSet]     = useState<Set<string>>(new Set())

  const [confirmRestore, setConfirmRestore] = useState<VolumeBackupEntry | null>(null)
  const [confirmDelete, setConfirmDelete]   = useState<VolumeBackupEntry | null>(null)
  const [isRestoring, setIsRestoring]       = useState(false)
  const [isDeletingEntry, setIsDeletingEntry] = useState<string | null>(null)

  const { backupDir, setActiveView } = useAppStore()

  const loadBackupsForVol = async (name: string) => {
    if (!backupDir) { setVolBackups(prev => ({ ...prev, [name]: [] })); return }
    setLoadingBackup(name)
    try {
      const all = await api.dockerListBackups(backupDir)
      const entries = all.filter(b => b.volume === name).sort((a, b) => b.created_at - a.created_at)
      setVolBackups(prev => ({ ...prev, [name]: entries }))
    } catch {
      setVolBackups(prev => ({ ...prev, [name]: [] }))
    } finally { setLoadingBackup(null) }
  }

  const toggleVolBackups = async (name: string) => {
    if (expandedVol === name) { setExpandedVol(null); return }
    setExpandedVol(name)
    if (volBackups[name] !== undefined) return
    await loadBackupsForVol(name)
  }

  const doBackup = async (name: string) => {
    if (backingUpSet.has(name)) return
    if (!backupDir) { setActiveView('settings'); return }

    setExpandedVol(name)
    setBackingUpSet(prev => new Set([...prev, name]))
    setVolProgress(prev => ({ ...prev, [name]: { status: 'running', progress: 0, message: 'Starting…' } }))

    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`─── backing up: ${name}`, 'info')

    const unlisten = await listen<BackupProgress>('backup-progress', e => {
      const { volume, step, progress, done, error, filename, cmd } = e.payload
      const key = volume ?? name
      if (cmd) addTerminalLine(`$ ${cmd}`, 'cmd')
      else if (done && !error) addTerminalLine(`  ✓ ${step}`, 'success')
      else if (error) addTerminalLine(`  ✗ ${error}`, 'error')
      else addTerminalLine(`  ${step}`, 'info')
      if (key === name) {
        setVolProgress(prev => ({
          ...prev,
          [key]: {
            status:   done ? (error ? 'error' : 'done') : 'running',
            progress: done ? (error ? (prev[key]?.progress ?? 0) : 100) : progress,
            message:  step,
            filename: filename ?? undefined,
            error:    error ?? undefined,
          },
        }))
      }
    })

    try {
      await api.dockerVolumeBackup(name, backupDir)
      await loadBackupsForVol(name)
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlisten()
      setBackingUpSet(prev => { const s = new Set(prev); s.delete(name); return s })
      setTimeout(() => setVolProgress(prev => { const n = { ...prev }; delete n[name]; return n }), 3000)
    }
  }

  const doRestore = async (entry: VolumeBackupEntry) => {
    setConfirmRestore(null)
    setIsRestoring(true)
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`─── restoring: ${entry.volume}`, 'info')
    const unlisten = await listen<BackupProgress>('backup-progress', e => {
      const { step, done, error, cmd } = e.payload
      if (cmd) addTerminalLine(`$ ${cmd}`, 'cmd')
      else if (done && !error) addTerminalLine(`  ✓ ${step}`, 'success')
      else if (error) addTerminalLine(`  ✗ ${error}`, 'error')
      else addTerminalLine(`  ${step}`, 'info')
    })
    try { await api.dockerVolumeRestore(entry.volume, entry.path) }
    catch (e) { addTerminalLine(`  ✗ ${String(e)}`, 'error') }
    finally { unlisten(); setIsRestoring(false) }
  }

  const doDeleteEntry = async (entry: VolumeBackupEntry) => {
    if (!backupDir) return
    setConfirmDelete(null)
    setIsDeletingEntry(entry.filename)
    try {
      await api.dockerDeleteBackup(backupDir, entry.filename)
      setVolBackups(prev => ({
        ...prev,
        [entry.volume]: (prev[entry.volume] ?? []).filter(b => b.filename !== entry.filename),
      }))
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally { setIsDeletingEntry(null) }
  }

  const filtered = useMemo(
    () => sortVolumes(filterVolumes(volumes, search, usageFilter), sortKey, sortDir),
    [volumes, search, usageFilter, sortKey, sortDir],
  )

  // `docker volume prune` takes every unused volume on the engine, not the
  // filtered view, so the dialog must name that set and not what is on screen.
  const unusedVols  = useMemo(() => volumes.filter(v => !v.in_use), [volumes])
  const unusedCount = unusedVols.length
  const unusedBytes = useMemo(() => unusedVols.reduce((n, v) => n + v.size_bytes, 0), [unusedVols])

  const toggleVolSelect    = (name: string) => setSelectedVols(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s })
  const allVolSelected     = selectedVols.size > 0 && selectedVols.size === filtered.length
  const someVolSelected    = selectedVols.size > 0 && selectedVols.size < filtered.length
  const toggleSelectAllVol = () => setSelectedVols(allVolSelected ? new Set() : new Set(filtered.map(v => v.name)))
  const bulkBackup         = async () => {
    if (!backupDir) { setActiveView('settings'); return }
    for (const name of selectedVols) await doBackup(name)
    setSelectedVols(new Set())
  }

  /** Backups stream progress into the rows, so the dialog closes rather than cover them. */
  const backupUnusedFirst = async () => {
    if (!backupDir) { setConfirmPrune(false); setActiveView('settings'); return }
    setConfirmPrune(false)
    setUsageFilter('unused')
    for (const v of unusedVols) await doBackup(v.name)
  }

  const doRemove = async (name: string) => {
    setBusy(name); setActionError(null)
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`$ docker volume rm ${name}`, 'cmd')
    try {
      await api.dockerVolumeRemove(name)
      addTerminalLine(`  ✓ ${name} removed`, 'success')
      onRefresh()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setActionError(String(e))
    }
    finally { setBusy(null) }
  }

  const doPruneAll = async () => {
    setPruningAll(true); setActionError(null)
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine('$ docker volume prune -f', 'cmd')
    try {
      await api.dockerVolumesPrune()
      addTerminalLine(`  ✓ ${unusedVols.length} volume(s) removed, ${fmtBytes(unusedBytes)} reclaimed`, 'success')
      setConfirmPrune(false)
      onRefresh()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setActionError(e)
      setConfirmPrune(false)
    }
    finally { setPruningAll(false) }
  }

  if (loading) return <div className="img-loading">Loading volumes…</div>
  if (!volumes.length) return (
    <EmptyState
      icon={Database}
      title="No volumes on this engine"
      description="Volumes persist container data across restarts. They appear here when a container or Compose project creates them."
    />
  )

  const cell = (column: string, v: DockerVolume) => {
    const isBusy      = busy === v.name
    const isExpanded  = expandedVol === v.name
    const isBackingUp = backingUpSet.has(v.name)
    const volName     = fmtVolName(v.name)
    switch (column) {
      case 'select':
        return (
          <td className="img-td img-td-check" onClick={e => e.stopPropagation()}>
            <input type="checkbox" className="row-checkbox" aria-label={`Select volume ${v.name}`}
              checked={selectedVols.has(v.name)}
              onChange={() => toggleVolSelect(v.name)}
            />
          </td>
        )
      case 'name':
        return (
          <td className="img-td" title={v.name}>
            {/* A row takes no focus or Enter key, so the disclosure it drives is also a real control here. */}
            <button
              className="vol-name-cell"
              onClick={e => { e.stopPropagation(); toggleVolBackups(v.name) }}
              aria-expanded={isExpanded}
              aria-controls={`vol-backups-${v.name}`}
              aria-label={`${isExpanded ? 'Hide' : 'Show'} backups for ${v.name}`}
            >
              {isExpanded
                ? <ChevronDown size={11} className="vol-name-chevron" />
                : <ChevronRight size={11} className="vol-name-chevron" />
              }
              <span className="vol-name-text">{volName.display}</span>
            </button>
          </td>
        )
      case 'driver':
        return <td className="img-td img-age">{v.driver}</td>
      case 'project':
        return (
          <td className="img-td img-age">
            {v.compose_project
              ? (
                <CellLink
                  title={`Open ${v.compose_project} in Compose`}
                  onClick={() => { const s = useAppStore.getState(); s.setComposePreselect(v.compose_project); s.setDockerTab('compose') }}
                >
                  {v.compose_project}
                </CellLink>
              )
              : <Dash />}
          </td>
        )
      case 'used-by':
        return (
          <td className="img-td img-age" title={v.containers.join(', ')}>
            {v.containers.length === 0 && <Dash />}
            {v.containers.map((name, i) => (
              <Fragment key={name}>
                {i > 0 && ', '}
                <CellLink title={`Show ${name} in Containers`} onClick={() => useAppStore.getState().jumpToDocker('containers', name)}>{name}</CellLink>
              </Fragment>
            ))}
          </td>
        )
      case 'size':
        return <td className="img-td img-age num">{fmtBytes(v.size_bytes)}</td>
      case 'status':
        return <td className="img-td img-age"><StatusCell dot={v.in_use ? 'running' : 'stopped'}>{v.in_use ? 'In use' : 'Unused'}</StatusCell></td>
      default:
        return (
          <td className="img-td holder-actions" onClick={e => e.stopPropagation()}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => doBackup(v.name)}
              disabled={isBackingUp}
              title={!backupDir ? 'Set a backup folder in Settings' : `Back up '${v.name}'`}
            >
              <HardDriveDownload size={12} />
              {isBackingUp ? 'Backing up…' : 'Back up'}
            </Button>
            <ConfirmRemoveButton
              onConfirm={() => doRemove(v.name)}
              onArm={() => setActionError(null)}
              disabled={isBusy || v.in_use}
              title={v.in_use ? `Cannot remove ${v.name}: it is in use` : `Remove volume ${v.name}`}
            />
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
          placeholder="Search volumes"
          label="Search volumes by name, driver, project, or container"
        />
        <Segmented label="Filter by usage">
          {FILTERS.map(({ key, label }) => (
            <SegmentedItem
              key={key}
              active={usageFilter === key}
              count={volumes.filter(v => matchesVolumeFilter(v, key)).length}
              onClick={() => setUsageFilter(key)}
            >
              {label}
            </SegmentedItem>
          ))}
        </Segmented>

        {selectedVols.size > 0 && (
          <>
            <div className="toolbar-divider" />
            <span className="toolbar-sel-count">{selectedVols.size} selected</span>
            <button
              className="toolbar-bulk-btn toolbar-bulk-btn--success"
              onClick={bulkBackup}
              disabled={backingUpSet.size > 0}
              title="Back up selected volumes"
            >
              <HardDriveDownload size={11} />
              Back up {selectedVols.size}
            </button>
            <button
              className="toolbar-bulk-btn toolbar-bulk-btn--ghost"
              onClick={() => setSelectedVols(new Set())}
              title="Clear selection"
            >
              <X size={11} />
            </button>
          </>
        )}

        <span className="img-count">{filtered.length} shown</span>
        {unusedCount > 0 && (
          <Button
            variant="danger-outline"
            onClick={() => setConfirmPrune(true)}
            disabled={pruningAll}
            aria-label={`Remove all ${unusedCount} unused volumes, freeing ${fmtBytes(unusedBytes)}`}
          >
            <Trash2 size={12} />
            {pruningAll ? 'Removing…' : `Remove unused (${unusedCount})`}
          </Button>
        )}
      </Toolbar>

      {actionError != null && (
        <ErrorBanner className="error-banner--flush" error={actionError} />
      )}

      {filtered.length === 0 && (
        <EmptyState
          title="No volumes match"
          description="Adjust the search or filters."
          actions={<Button onClick={() => { setSearch(''); setUsageFilter('all') }}>Clear filters</Button>}
        />
      )}

      {filtered.length > 0 && (
        <div className="img-table-wrap">
          <table className="img-table pkg-table" style={{ width: table.tableWidth }}>
            <TableHead
              table={table}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              actionsClass="holder-actions"
              select={(
                <input type="checkbox" className="row-checkbox" aria-label="Select all volumes"
                  checked={allVolSelected}
                  ref={el => { if (el) el.indeterminate = someVolSelected }}
                  onChange={toggleSelectAllVol}
                />
              )}
            />
            <tbody>
              {filtered.map(v => {
                const isExpanded = expandedVol === v.name
                const vp         = volProgress[v.name]
                const entries    = volBackups[v.name] ?? []

                return (
                  <Fragment key={v.name}>
                    <tr
                      className={clsx('img-row img-row--clickable', isExpanded && 'img-row--expanded', selectedVols.has(v.name) && 'row-selected')}
                      onClick={() => toggleVolBackups(v.name)}
                    >
                      {table.visible.map(column => <Fragment key={column.key}>{cell(column.key, v)}</Fragment>)}
                      {table.fillFixed && <td className="img-td" aria-hidden="true" />}
                    </tr>

                    {isExpanded && (
                      <tr className="vol-backup-expand-row">
                        <td colSpan={table.visible.length + (table.fillFixed ? 1 : 0)} className="vol-backup-expand-td" id={`vol-backups-${v.name}`}>
                          <div className="vol-backup-panel">

                            {vp && <ProgressBar p={vp} />}

                            {loadingBackup === v.name && !vp && (
                              <span className="vol-backup-state">Loading backups…</span>
                            )}

                            {!backupDir && (
                              <div className="vol-backup-state vol-backup-no-dir">
                                No backup folder set.{' '}
                                <button className="vol-backup-settings-link" onClick={() => setActiveView('settings')}>
                                  Open Settings
                                </button>{' '}
                                to set one.
                              </div>
                            )}

                            {backupDir && !vp && loadingBackup !== v.name && entries.length === 0 && (
                              <span className="vol-backup-state">No backups yet. Click Back up to create the first one.</span>
                            )}

                            {entries.length > 0 && (
                              <ul className="vol-backup-list">
                                {entries.map(entry => {
                                  const isConfR = confirmRestore?.filename === entry.filename
                                  const isConfD = confirmDelete?.filename  === entry.filename
                                  return (
                                    <li key={entry.filename} className={clsx('vol-backup-entry', (isConfR || isConfD) && 'confirming')}>
                                      {isConfR ? (
                                        <div className="backup-inline-confirm">
                                          <span className="backup-confirm-text">Restore will overwrite existing volume data.</span>
                                          <div className="backup-confirm-actions">
                                            <button className="btn-filled btn-filled--success btn-sm" onClick={() => doRestore(entry)} disabled={isRestoring}>
                                              <RotateCcw size={11} /> Restore
                                            </button>
                                            <button className="btn-ghost btn-sm" onClick={() => setConfirmRestore(null)}>Cancel</button>
                                          </div>
                                        </div>
                                      ) : isConfD ? (
                                        <div className="backup-inline-confirm">
                                          <span className="backup-confirm-text backup-confirm-text--danger">Delete this backup permanently?</span>
                                          <div className="backup-confirm-actions">
                                            <button className="btn-filled btn-filled--danger btn-sm" onClick={() => doDeleteEntry(entry)} disabled={isDeletingEntry === entry.filename}>
                                              <Trash2 size={11} /> Delete
                                            </button>
                                            <button className="btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                                          </div>
                                        </div>
                                      ) : (
                                        <>
                                          <div className="vol-backup-entry-info">
                                            <span className="vol-backup-date">{formatDate(entry.created_at)}</span>
                                            <span className="vol-backup-size">{fmtBytes(entry.size_bytes)}</span>
                                            <span className="vol-backup-file" title={entry.filename}>
                                              {truncFilename(entry.filename)}
                                            </span>
                                          </div>
                                          <div className="vol-backup-entry-actions">
                                            <button
                                              className="ctr-action-btn"
                                              onClick={() => revealItemInDir(entry.path).catch(() => {})}
                                              title="Show in Explorer"
                                              aria-label={`Open the folder holding ${entry.filename}`}
                                            >
                                              <FolderOpen size={12} />
                                            </button>
                                            <button
                                              className="ctr-action-btn ctr-action-start"
                                              onClick={() => { setConfirmRestore(entry); setConfirmDelete(null) }}
                                              disabled={isRestoring}
                                              title="Restore from this backup"
                                              aria-label={`Restore ${v.name} from ${entry.filename}`}
                                            >
                                              <RotateCcw size={12} />
                                            </button>
                                            <button
                                              className="ctr-action-btn ctr-action-remove"
                                              onClick={() => { setConfirmDelete(entry); setConfirmRestore(null) }}
                                              disabled={isDeletingEntry === entry.filename}
                                              title="Delete this backup"
                                              aria-label={`Delete backup ${entry.filename}`}
                                            >
                                              <Trash2 size={12} />
                                            </button>
                                          </div>
                                        </>
                                      )}
                                    </li>
                                  )
                                })}
                              </ul>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmPrune && (
        <ConfirmDestructive
          title={`Remove ${unusedCount} unused volume${unusedCount === 1 ? '' : 's'}?`}
          consequence={
            <>
              Volumes persist container data such as databases, uploads, and caches. Removing
              them permanently deletes that data.
            </>
          }
          command="docker volume prune -f"
          summary={`${unusedCount} volume${unusedCount === 1 ? '' : 's'} · ${fmtBytes(unusedBytes)}`}
          items={unusedVols.map(v => ({
            name: fmtVolName(v.name).full ?? v.name,
            meta: v.size_bytes > 0 ? fmtBytes(v.size_bytes) : undefined,
          }))}
          confirmLabel={`Remove ${unusedCount} volume${unusedCount === 1 ? '' : 's'}`}
          onConfirm={doPruneAll}
          onCancel={() => setConfirmPrune(false)}
          busy={pruningAll}
          escape={
            <Button onClick={backupUnusedFirst} disabled={pruningAll}>
              <HardDriveDownload size={12} />
              {backupDir ? 'Back these up first' : 'Set a backup folder'}
            </Button>
          }
        />
      )}
    </div>
  )
}
