import { useState, useMemo, useEffect, Fragment } from 'react'
import { listen } from '@tauri-apps/api/event'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { Trash2, HardDriveDownload, ChevronRight, ChevronDown, RotateCcw, FolderOpen, X } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { DockerVolume, VolumeBackupEntry, BackupProgress } from '../types'
import { fmtBytes, formatDate } from '../../../utils/format'
import { ConfirmRemoveButton } from './TableBits'

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
          style={{ width: `${p.progress}%` }}
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
  const [actionError, setActionError] = useState<string | null>(null)

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

  const unusedCount = volumes.filter(v => !v.in_use).length

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
      addTerminalLine('  ✓ unused volumes pruned', 'success')
      onRefresh()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setActionError(String(e))
    }
    finally { setPruningAll(false) }
  }

  if (loading) return <div className="img-loading">Loading volumes…</div>
  if (!volumes.length) return <p className="empty-state">No volumes found.</p>

  return (
    <div className="img-tab">
      {/* ── Toolbar (bulk controls live here — no layout shift) ────── */}
      <div className="img-toolbar">
        <input
          className="img-search"
          type="search"
          placeholder="Filter by name or driver…"
          aria-label="Filter volumes"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="ctr-state-filter">
          {(['all', 'in-use', 'unused'] as UsageFilter[]).map(f => (
            <button
              key={f}
              className={clsx('ctr-filter-btn', usageFilter === f && 'active')}
              onClick={() => setUsageFilter(f)}
            >{f}</button>
          ))}
        </div>
        {unusedCount > 0 && (
          <button
            className="btn-prune-unused"
            onClick={doPruneAll}
            disabled={pruningAll}
            title={`Remove all ${unusedCount} unused volumes`}
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

      {actionError && (
        <div className="error-banner" style={{ marginBottom: 0 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{actionError}</span>
        </div>
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
                  {/* ── Volume row — entire row is clickable ──────────────── */}
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

                          {/* No backup dir — link to settings */}
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
                            <span className="vol-backup-state">No backups yet — click Backup to create the first one.</span>
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
    </div>
  )
}
