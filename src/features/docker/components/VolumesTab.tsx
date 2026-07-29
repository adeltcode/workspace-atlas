import { useState, useMemo, useEffect, Fragment } from 'react'
import { listen } from '@tauri-apps/api/event'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { Trash2, HardDriveDownload, ChevronRight, ChevronDown, RotateCcw, FolderOpen, X, Database } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { DockerVolume, VolumeBackupEntry, BackupProgress } from '../types'
import { fmtBytes, formatDate } from '../../../utils/format'
import { ConfirmRemoveButton } from './TableBits'
import { SearchField, Segmented, SegmentedItem, EmptyState, ErrorBanner, ConfirmDestructive, Button } from '../../../components/ui'

type UsageFilter = 'all' | 'in-use' | 'unused'
type VolStatus   = 'running' | 'done' | 'error'

interface VolumeProgress {
  status:    VolStatus
  progress:  number
  message:   string
  filename?: string
  error?:    string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVolName(name: string): { display: string; full?: string } {
  if (/^[a-f0-9]{48,}$/i.test(name))
    return { display: name.slice(0, 12) + '…', full: name }
  return { display: name }
}

function truncFilename(name: string, max = 30): string {
  return name.length <= max ? name : name.slice(0, max - 1) + '…'
}

// ── Inline progress bar ───────────────────────────────────────────────────────

function ProgressBar({ p }: { p: VolumeProgress }) {
  return (
    <div className="vol-progress-wrap vol-progress-wrap--inline">
      <div className="vol-progress-track">
        <div
          className={clsx('vol-progress-fill',
            p.status === 'running' && 'running',
            p.status === 'done'    && 'done',
            p.status === 'error'   && 'error',
          )}
          style={{ transform: `scaleX(${p.progress / 100})` }}
        />
      </div>
      <div className={clsx('vol-progress-label', p.status === 'done' && 'ok', p.status === 'error' && 'err')}>
        {p.status === 'running' && p.message}
        {p.status === 'done'    && `✓ ${p.filename ?? 'Done'}`}
        {p.status === 'error'   && `✗ ${p.error ?? p.message}`}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

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
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all')

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

  // Expand / collapse inline backup panel
  const [expandedVol, setExpandedVol]       = useState<string | null>(null)
  const [volBackups, setVolBackups]         = useState<Record<string, VolumeBackupEntry[]>>({})
  const [loadingBackup, setLoadingBackup]   = useState<string | null>(null)

  // Bulk selection
  const [selectedVols, setSelectedVols]     = useState<Set<string>>(new Set())

  // Per-volume backup progress
  const [volProgress, setVolProgress]       = useState<Record<string, VolumeProgress>>({})
  const [backingUpSet, setBackingUpSet]     = useState<Set<string>>(new Set())

  // Restore / delete confirm
  const [confirmRestore, setConfirmRestore] = useState<VolumeBackupEntry | null>(null)
  const [confirmDelete, setConfirmDelete]   = useState<VolumeBackupEntry | null>(null)
  const [isRestoring, setIsRestoring]       = useState(false)
  const [isDeletingEntry, setIsDeletingEntry] = useState<string | null>(null)

  const { backupDir, setActiveView } = useAppStore()

  // ── Backup list loader ────────────────────────────────────────────────────

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

  // ── Toggle expand (name click) ────────────────────────────────────────────

  const toggleVolBackups = async (name: string) => {
    if (expandedVol === name) { setExpandedVol(null); return }
    setExpandedVol(name)
    if (volBackups[name] !== undefined) return
    await loadBackupsForVol(name)
  }

  // ── Backup action ─────────────────────────────────────────────────────────

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

  // ── Restore action ────────────────────────────────────────────────────────

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

  // ── Delete backup entry ───────────────────────────────────────────────────

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

  // ── Volume remove ─────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return volumes
      .filter(v => {
        if (usageFilter === 'in-use') return v.in_use
        if (usageFilter === 'unused') return !v.in_use
        return true
      })
      .filter(v => !q || v.name.toLowerCase().includes(q) || v.driver.toLowerCase().includes(q))
  }, [volumes, search, usageFilter])

  // `docker volume prune` takes every unused volume on the engine, not the
  // filtered view, so the dialog must name that set and not what is on screen.
  const unusedVols  = useMemo(() => volumes.filter(v => !v.in_use), [volumes])
  const unusedCount = unusedVols.length
  const unusedBytes = useMemo(() => unusedVols.reduce((n, v) => n + v.size_bytes, 0), [unusedVols])

  // Bulk selection helpers (after filtered is defined)
  const toggleVolSelect    = (name: string) => setSelectedVols(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s })
  const allVolSelected     = selectedVols.size > 0 && selectedVols.size === filtered.length
  const someVolSelected    = selectedVols.size > 0 && selectedVols.size < filtered.length
  const toggleSelectAllVol = () => setSelectedVols(allVolSelected ? new Set() : new Set(filtered.map(v => v.name)))
  const bulkBackup         = async () => {
    if (!backupDir) { setActiveView('settings'); return }
    for (const name of selectedVols) await doBackup(name)
    setSelectedVols(new Set())
  }

  /** The safe path out of the prune dialog. Backups stream their own progress
   *  into the rows, so the dialog closes rather than sitting over the evidence. */
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
      description="Volumes hold the data your containers keep between restarts. One appears here as soon as a container or compose project creates it."
    />
  )

  return (
    <div className="img-tab">
      {/* ── Toolbar (bulk controls live here - no layout shift) ────── */}
      <div className="img-toolbar">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search volumes"
          label="Search volumes by name or driver"
        />
        <Segmented label="Filter by usage">
          {(['all', 'in-use', 'unused'] as UsageFilter[]).map(f => (
            <SegmentedItem key={f} active={usageFilter === f} onClick={() => setUsageFilter(f)}>
              {f === 'in-use' ? 'In use' : f[0].toUpperCase() + f.slice(1)}
            </SegmentedItem>
          ))}
        </Segmented>
        {unusedCount > 0 && (
          <button
            className="btn-prune-unused"
            onClick={() => setConfirmPrune(true)}
            disabled={pruningAll}
            aria-label={`Remove all ${unusedCount} unused volumes, freeing ${fmtBytes(unusedBytes)}`}
          >
            <Trash2 size={11} />
            {pruningAll ? 'Removing…' : `Remove unused (${unusedCount})`}
          </button>
        )}

        {selectedVols.size > 0 && (
          <>
            <div className="toolbar-divider" />
            <span className="toolbar-sel-count">{selectedVols.size} selected</span>
            <button
              className="toolbar-bulk-btn toolbar-bulk-btn--success"
              onClick={bulkBackup}
              disabled={backingUpSet.size > 0}
              title="Backup selected volumes"
            >
              <HardDriveDownload size={11} />
              Backup {selectedVols.size}
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

        <span className="img-count">
          {filtered.length} volume{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {actionError != null && (
        <ErrorBanner className="error-banner--flush" error={actionError} />
      )}

      <div className="img-table-wrap">
        <table className="img-table">
          <thead>
            <tr>
              <th className="img-th img-th-check">
                <input type="checkbox" className="row-checkbox" aria-label="Select all volumes"
                  checked={allVolSelected}
                  ref={el => { if (el) el.indeterminate = someVolSelected }}
                  onChange={toggleSelectAllVol}
                />
              </th>
              <th className="img-th img-th-vol-name">Name</th>
              <th className="img-th">Driver</th>
              <th className="img-th">Size</th>
              <th className="img-th">Status</th>
              <th className="img-th ctr-th-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(v => {
              const isBusy       = busy === v.name
              const isExpanded   = expandedVol === v.name
              const isBackingUp  = backingUpSet.has(v.name)
              const vp           = volProgress[v.name]
              const entries      = volBackups[v.name] ?? []
              const isSelected   = selectedVols.has(v.name)
              const volName      = fmtVolName(v.name)

              return (
                <Fragment key={v.name}>
                  {/* ── Volume row - entire row is clickable ──────────────── */}
                  <tr
                    className={clsx('img-row img-row--clickable', isExpanded && 'img-row--expanded', isSelected && 'row-selected')}
                    onClick={() => toggleVolBackups(v.name)}
                    title="Click to view backups"
                  >
                    <td className="img-td img-td-check" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" className="row-checkbox" aria-label={`Select volume ${v.name}`}
                        checked={isSelected}
                        onChange={() => toggleVolSelect(v.name)}
                      />
                    </td>
                    <td className="img-td">
                      <div className="vol-name-cell">
                        {isExpanded
                          ? <ChevronDown size={11} className="vol-name-chevron" />
                          : <ChevronRight size={11} className="vol-name-chevron" />
                        }
                        <span className="vol-name-text" title={volName.full}>{volName.display}</span>
                      </div>
                    </td>
                    <td className="img-td img-age">{v.driver}</td>
                    <td className="img-td img-age">{fmtBytes(v.size_bytes)}</td>
                    <td className="img-td">
                      {v.in_use
                        ? <span className="badge badge-active">In use</span>
                        : <span className="badge badge-idle">Unused</span>}
                    </td>
                    <td className="img-td ctr-td-actions" onClick={e => e.stopPropagation()}>
                      <button
                        className={clsx('ctr-action-btn ctr-action-btn--labeled ctr-action-start', isBackingUp && 'loading')}
                        onClick={() => doBackup(v.name)}
                        disabled={isBackingUp}
                        title={!backupDir ? 'Configure backup directory in Settings' : `Back up '${v.name}'`}
                      >
                        <HardDriveDownload size={12} />
                        {isBackingUp ? 'Backing up…' : 'Backup'}
                      </button>
                      <ConfirmRemoveButton
                        onConfirm={() => doRemove(v.name)}
                        onArm={() => setActionError(null)}
                        disabled={isBusy || v.in_use}
                        title={v.in_use ? 'Cannot remove: volume is in use' : 'Remove volume'}
                      />
                    </td>
                  </tr>

                  {/* ── Inline backup panel ────────────────────────────────── */}
                  {isExpanded && (
                    <tr className="vol-backup-expand-row">
                      <td colSpan={6} className="vol-backup-expand-td">
                        <div className="vol-backup-panel">

                          {/* Progress during backup */}
                          {vp && <ProgressBar p={vp} />}

                          {/* Loading spinner */}
                          {loadingBackup === v.name && !vp && (
                            <span className="vol-backup-state">Loading backups…</span>
                          )}

                          {/* No backup dir - link to settings */}
                          {!backupDir && (
                            <div className="vol-backup-state vol-backup-no-dir">
                              No backup directory configured.{' '}
                              <button className="vol-backup-settings-link" onClick={() => setActiveView('settings')}>
                                Open Settings
                              </button>{' '}
                              to set one.
                            </div>
                          )}

                          {/* Empty */}
                          {backupDir && !vp && loadingBackup !== v.name && entries.length === 0 && (
                            <span className="vol-backup-state">No backups yet - click Backup to create the first one.</span>
                          )}

                          {/* Backup list */}
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
                                        <span className="backup-confirm-text backup-confirm-text--danger">Delete this archive permanently?</span>
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
                                            title="Open file location"
                                          >
                                            <FolderOpen size={12} />
                                          </button>
                                          <button
                                            className="ctr-action-btn ctr-action-start"
                                            onClick={() => { setConfirmRestore(entry); setConfirmDelete(null) }}
                                            disabled={isRestoring}
                                            title="Restore from this backup"
                                          >
                                            <RotateCcw size={12} />
                                          </button>
                                          <button
                                            className="ctr-action-btn ctr-action-remove"
                                            onClick={() => { setConfirmDelete(entry); setConfirmRestore(null) }}
                                            disabled={isDeletingEntry === entry.filename}
                                            title="Delete this backup"
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

      {confirmPrune && (
        <ConfirmDestructive
          title={`Remove ${unusedCount} unused volume${unusedCount === 1 ? '' : 's'}?`}
          consequence={
            <>
              A volume is where a container keeps the data it is supposed to survive a
              restart: a database, an upload directory, a cache it paid to build. Removing
              it deletes that data from this machine, and nothing here can bring it back.
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
