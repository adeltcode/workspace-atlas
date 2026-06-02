import { useEffect, useRef, useState } from 'react'
import {
  Folder, HardDriveDownload, RotateCcw, RefreshCw,
  AlertTriangle, MoveRight, Trash2, X, CheckCircle2, AlertCircle, Info,
} from 'lucide-react'
import clsx from 'clsx'
import { listen } from '@tauri-apps/api/event'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { DockerVolume, VolumeBackupEntry, BackupProgress } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────────

type VolStatus = 'idle' | 'queued' | 'running' | 'done' | 'error'

interface VolumeProgress {
  status: VolStatus
  progress: number
  message: string
  filename?: string
  error?: string
}

interface Notice {
  id: string
  type: 'success' | 'error' | 'info'
  message: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bytesToHuman(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`
  return `${b} B`
}

function formatDate(ts: number): string {
  const d   = new Date(ts * 1000)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function VolumeProgressBar({ p }: { p: VolumeProgress }) {
  return (
    <div className="vol-progress-wrap">
      <div className="vol-progress-track">
        <div
          className={clsx(
            'vol-progress-fill',
            p.status === 'running' && 'running',
            p.status === 'done'    && 'done',
            p.status === 'error'   && 'error',
            p.status === 'queued'  && 'queued',
          )}
          style={{ width: `${p.status === 'queued' ? 0 : p.progress}%` }}
        />
      </div>
      <div className={clsx('vol-progress-label', p.status === 'done' && 'ok', p.status === 'error' && 'err')}>
        {p.status === 'queued'  && 'Queued…'}
        {p.status === 'running' && p.message}
        {p.status === 'done'    && `✓ ${p.filename ?? 'Done'}`}
        {p.status === 'error'   && `✗ ${p.error ?? p.message}`}
      </div>
    </div>
  )
}

// ── Notice banner ─────────────────────────────────────────────────────────────

function NoticeBanner({ n, onDismiss }: { n: Notice; onDismiss: () => void }) {
  const Icon = n.type === 'success' ? CheckCircle2 : n.type === 'error' ? AlertCircle : Info
  return (
    <div className={`backup-notice backup-notice--${n.type}`}>
      <Icon size={14} className="backup-notice-icon" />
      <span className="backup-notice-msg">{n.message}</span>
      <button className="backup-notice-close" onClick={onDismiss} title="Dismiss">
        <X size={13} />
      </button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function BackupTab({ volumes }: { volumes: DockerVolume[] }) {
  const { backupDir, setBackupDir } = useAppStore()

  const [dirInput, setDirInput]             = useState(backupDir)
  const [backups, setBackups]               = useState<VolumeBackupEntry[]>([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [selected, setSelected]             = useState<Set<string>>(new Set())
  const [isBacking, setIsBacking]           = useState(false)
  const [volProgress, setVolProgress]       = useState<Record<string, VolumeProgress>>({})
  const [confirmRestore, setConfirmRestore] = useState<VolumeBackupEntry | null>(null)
  const [confirmDelete, setConfirmDelete]   = useState<VolumeBackupEntry | null>(null)
  const [isDeleting, setIsDeleting]         = useState(false)
  const [notices, setNotices]               = useState<Notice[]>([])

  const [pendingDir, setPendingDir]         = useState<string | null>(null)
  const [existingCount, setExistingCount]   = useState(0)
  const [transferring, setTransferring]     = useState(false)

  const prevVolumesRef = useRef<DockerVolume[]>(volumes)
  let noticeId = useRef(0)

  const addNotice = (type: Notice['type'], message: string) =>
    setNotices(prev => [...prev, { id: String(++noticeId.current), type, message }])

  const dismissNotice = (id: string) =>
    setNotices(prev => prev.filter(n => n.id !== id))

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!backupDir) {
      api.getDefaultBackupDir().then(dir => { setBackupDir(dir); setDirInput(dir) })
    }
  }, []) // eslint-disable-line

  useEffect(() => {
    if (backupDir) loadBackups(backupDir)
  }, [backupDir])

  useEffect(() => {
    if (prevVolumesRef.current !== volumes) {
      prevVolumesRef.current = volumes
      if (backupDir) loadBackups(backupDir)
    }
  }, [volumes]) // eslint-disable-line

  useEffect(() => { setDirInput(backupDir) }, [backupDir])

  const loadBackups = async (dir: string) => {
    setBackupsLoading(true)
    try { setBackups(await api.dockerListBackups(dir)) }
    catch { setBackups([]) }
    finally { setBackupsLoading(false) }
  }

  // ── Directory change ──────────────────────────────────────────────────────

  const appendAtlasBackup = (dir: string): string => {
    const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '')
    if (/\/atlas backup$/i.test(norm)) return norm
    return `${norm}/Atlas Backup`
  }

  const handlePickFolder = async () => {
    const dir = await api.pickBackupFolder()
    if (!dir) return
    const finalDir = appendAtlasBackup(dir)
    setDirInput(finalDir)
    setPendingDir(null)
    if (finalDir !== backupDir) applyDirChange(finalDir)
  }

  const applyDirChange = async (newDir: string) => {
    if (!newDir || newDir === backupDir) return
    if (backupDir) {
      try {
        const existing = await api.dockerListBackups(backupDir)
        if (existing.length > 0) {
          setExistingCount(existing.length)
          setPendingDir(newDir)
          return
        }
      } catch { /* no existing backups */ }
    }
    commitDirChange(newDir)
    addNotice('success', `Backup directory updated to ${newDir}`)
  }

  const handleApplyDir = async () => {
    const newDir = dirInput.trim()
    if (!newDir || newDir === backupDir) return
    await applyDirChange(newDir)
  }

  const commitDirChange = (newDir: string) => {
    setBackupDir(newDir)
    setDirInput(newDir)
    setPendingDir(null)
    loadBackups(newDir)
  }

  const handleTransfer = async (shouldTransfer: boolean) => {
    if (!pendingDir) return
    if (!shouldTransfer) {
      commitDirChange(pendingDir)
      addNotice('info', `Directory changed to ${pendingDir}. Existing backups were not moved.`)
      return
    }
    setTransferring(true)
    try {
      const result = await api.transferBackups(backupDir, pendingDir)
      commitDirChange(pendingDir)
      const parts = [`${result.moved} backup${result.moved !== 1 ? 's' : ''} moved to ${pendingDir}.`]
      if (result.old_dir_removed) parts.push('Previous folder was removed.')
      else parts.push('Previous folder was kept (not empty).')
      addNotice('success', parts.join(' '))
    } catch (e) {
      addNotice('error', `Transfer failed: ${String(e)}`)
      setPendingDir(null)
    } finally {
      setTransferring(false)
    }
  }

  // ── Volume selection ──────────────────────────────────────────────────────

  const toggleVolume = (name: string) =>
    setSelected(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s })

  // ── Backup ────────────────────────────────────────────────────────────────

  const runBackup = async () => {
    if (!backupDir || selected.size === 0 || isBacking) return
    const initial: Record<string, VolumeProgress> = {}
    for (const v of selected) initial[v] = { status: 'queued', progress: 0, message: 'Queued…' }
    setVolProgress(initial)
    setIsBacking(true)

    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`─── Docker volume backup (${selected.size} volume${selected.size !== 1 ? 's' : ''})`, 'cmd')

    const unlisten = await listen<BackupProgress>('backup-progress', e => {
      const { volume, step, progress, done, error, filename, cmd } = e.payload
      const key = volume ?? ''
      if (cmd) addTerminalLine(`$ ${cmd}`, 'cmd')
      else if (done && !error) addTerminalLine(`  ✓ ${step}`, 'success')
      else if (error) addTerminalLine(`  ✗ ${error}`, 'error')
      else addTerminalLine(`  ${step}`, 'info')
      if (key) setVolProgress(prev => ({
        ...prev,
        [key]: {
          status: done ? (error ? 'error' : 'done') : 'running',
          progress: done ? (error ? (prev[key]?.progress ?? 0) : 100) : progress,
          message: step, filename: filename ?? undefined, error: error ?? undefined,
        },
      }))
    })

    try {
      for (const vol of selected) {
        addTerminalLine(`─── ${vol}`, 'cmd')
        setVolProgress(prev => ({ ...prev, [vol]: { ...prev[vol], status: 'running' } }))
        await api.dockerVolumeBackup(vol, backupDir)
      }
      await loadBackups(backupDir)
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlisten()
      setIsBacking(false)
      setTimeout(() => setVolProgress({}), 3000)
    }
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  const runRestore = async (entry: VolumeBackupEntry) => {
    setConfirmRestore(null)
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`─── Docker volume restore: ${entry.volume}`, 'cmd')
    setVolProgress(prev => ({ ...prev, [entry.volume]: { status: 'running', progress: 10, message: 'Starting restore…' } }))

    const unlisten = await listen<BackupProgress>('backup-progress', e => {
      const { volume, step, progress, done, error, cmd } = e.payload
      const key = volume ?? entry.volume
      if (cmd) addTerminalLine(`$ ${cmd}`, 'cmd')
      else if (done && !error) addTerminalLine(`  ✓ ${step}`, 'success')
      else if (error) addTerminalLine(`  ✗ ${error}`, 'error')
      else addTerminalLine(`  ${step}`, 'info')
      setVolProgress(prev => ({
        ...prev,
        [key]: {
          status: done ? (error ? 'error' : 'done') : 'running',
          progress: done ? (error ? (prev[key]?.progress ?? 0) : 100) : progress,
          message: step, error: error ?? undefined,
        },
      }))
    })

    try {
      await api.dockerVolumeRestore(entry.volume, entry.path)
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlisten()
      setTimeout(() => setVolProgress(prev => { const n = { ...prev }; delete n[entry.volume]; return n }), 3000)
    }
  }

  // ── Delete backup ─────────────────────────────────────────────────────────

  const runDelete = async (entry: VolumeBackupEntry) => {
    setConfirmDelete(null)
    setIsDeleting(true)
    try {
      await api.dockerDeleteBackup(backupDir, entry.filename)
      setBackups(prev => prev.filter(b => b.filename !== entry.filename))
    } catch (e) {
      addNotice('error', `Delete failed: ${String(e)}`)
    } finally {
      setIsDeleting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const anyRunning = isBacking || Object.values(volProgress).some(p => p.status === 'running')
  const sortedBackups = backups.slice().sort((a, b) => b.created_at - a.created_at)

  return (
    <div className="backup-tab">

      {/* ── Config card ──────────────────────────────────────────── */}
      <div className="backup-config-card">
        <div className="backup-config-header">
          <span className="backup-config-title">Backup Directory</span>
          {backupDir && (
            <span className="backup-config-hint">
              Stored in <code>docker/volumes/</code> and <code>docker/compose/</code>
            </span>
          )}
        </div>
        <div className="backup-dir-row">
          <input
            className="backup-dir-input"
            value={dirInput}
            onChange={e => { setDirInput(e.target.value); setPendingDir(null) }}
            onBlur={handleApplyDir}
            onKeyDown={e => e.key === 'Enter' && handleApplyDir()}
            placeholder="Enter or select a backup root directory…"
            spellCheck={false}
          />
          <button
            className="backup-dir-pick-btn"
            onClick={handlePickFolder}
            title="Opens a folder picker — 'Atlas Backup' is appended automatically"
          >
            <Folder size={13} />
            Select Folder
          </button>
          <button
            className="ctr-action-btn"
            onClick={() => backupDir && loadBackups(backupDir)}
            disabled={!backupDir || backupsLoading}
            title="Refresh backup list"
          >
            <RefreshCw size={13} className={backupsLoading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Notices ──────────────────────────────────────────────── */}
      {notices.map(n => (
        <NoticeBanner key={n.id} n={n} onDismiss={() => dismissNotice(n.id)} />
      ))}

      {/* ── Transfer prompt ──────────────────────────────────────── */}
      {pendingDir && (
        <div className="backup-transfer-card">
          <div className="backup-transfer-header">
            <MoveRight size={15} className="backup-transfer-icon" />
            <div className="backup-transfer-body">
              <span className="backup-transfer-title">
                {existingCount} backup{existingCount !== 1 ? 's' : ''} found in current directory
              </span>
              <span className="backup-transfer-sub">
                Move them to <code>{pendingDir}</code> before switching?
              </span>
            </div>
          </div>
          <div className="backup-transfer-actions">
            <button
              className="btn-execute btn-execute--success"
              onClick={() => handleTransfer(true)}
              disabled={transferring}
            >
              <MoveRight size={12} />
              {transferring ? 'Moving…' : 'Transfer & Switch'}
            </button>
            <button className="btn-reset" onClick={() => handleTransfer(false)} disabled={transferring}>
              Switch without moving
            </button>
            <button className="btn-reset" onClick={() => { setPendingDir(null); setDirInput(backupDir) }} disabled={transferring}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Two-column layout ─────────────────────────────────────── */}
      <div className="backup-columns">

        {/* ── Left: volumes ─────────────────────────────────────── */}
        <div className="backup-panel">
          <div className="backup-panel-header">
            <span className="backup-panel-title">Volumes</span>
            <span className="backup-panel-meta">
              {selected.size > 0
                ? `${selected.size} of ${volumes.length} selected`
                : `${volumes.length} volume${volumes.length !== 1 ? 's' : ''}`}
            </span>
          </div>

          {volumes.length === 0
            ? <p className="backup-empty">No Docker volumes found.</p>
            : (
              <ul className="backup-volume-list">
                {volumes.map(v => {
                  const checked = selected.has(v.name)
                  const vp = volProgress[v.name]
                  const showBar = vp && vp.status !== 'idle'
                  return (
                    <li key={v.name} className={clsx('backup-volume-entry', showBar && 'has-progress')}>
                      <label className={clsx('backup-volume-item', checked && 'checked')}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleVolume(v.name)}
                          disabled={anyRunning}
                        />
                        <div className="backup-volume-info">
                          <div className="backup-volume-name-row">
                            <span className="backup-volume-name" title={v.name}>{v.name}</span>
                            <div className="backup-volume-badges">
                              <span className={clsx('badge', v.in_use ? 'badge-active' : 'badge-idle')}>
                                {v.in_use ? 'in use' : 'unused'}
                              </span>
                              {v.in_use && (
                                <span className="backup-inuse-warn" title="Containers will be paused during backup">
                                  <AlertTriangle size={11} />
                                </span>
                              )}
                            </div>
                          </div>
                          {(v.containers.length > 0 || v.compose_project) && (
                            <div className="backup-volume-tags">
                              {v.containers.length > 0 && (
                                <span className="backup-vol-tag backup-vol-tag--containers" title={v.containers.join(', ')}>
                                  {v.containers.join(', ')}
                                </span>
                              )}
                              {v.compose_project && (
                                <span className="backup-vol-tag backup-vol-tag--compose">
                                  {v.compose_project}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </label>
                      {showBar && <VolumeProgressBar p={vp} />}
                    </li>
                  )
                })}
              </ul>
            )
          }

          <div className="backup-panel-footer">
            <button
              className="btn-execute btn-execute--success"
              onClick={runBackup}
              disabled={anyRunning || selected.size === 0 || !backupDir}
              title={!backupDir ? 'Set a backup directory first' : ''}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <HardDriveDownload size={13} />
              {isBacking
                ? 'Backing up…'
                : selected.size > 0
                  ? `Backup ${selected.size} selected`
                  : 'Select volumes to back up'}
            </button>
          </div>
        </div>

        {/* ── Right: backup archives ─────────────────────────────── */}
        <div className="backup-panel">
          <div className="backup-panel-header">
            <span className="backup-panel-title">Archives</span>
            <span className="backup-panel-meta">
              {backupsLoading ? 'Loading…' : `${backups.length} archive${backups.length !== 1 ? 's' : ''}`}
            </span>
          </div>

          {!backupDir
            ? <p className="backup-empty">Set a backup directory to get started.</p>
            : backupsLoading
              ? <p className="backup-empty">Loading…</p>
              : sortedBackups.length === 0
                ? <p className="backup-empty">No backups yet. Select volumes and click Backup.</p>
                : (
                  <ul className="backup-list">
                    {sortedBackups.map(entry => {
                      const rp = volProgress[entry.volume]
                      const showBar = rp && (rp.status === 'running' || rp.status === 'queued')
                      const isConfirmRestore = confirmRestore?.filename === entry.filename
                      const isConfirmDelete  = confirmDelete?.filename  === entry.filename
                      return (
                        <li key={entry.filename} className={clsx('backup-list-item', (isConfirmRestore || isConfirmDelete) && 'confirming')}>
                          <div className="backup-list-item-info">
                            <div className="backup-list-top">
                              <span className="backup-list-volume" title={entry.volume}>{entry.volume}</span>
                              <span className="backup-list-size">{bytesToHuman(entry.size_bytes)}</span>
                            </div>
                            <span className="backup-list-date">{formatDate(entry.created_at)}</span>
                            <span className="backup-list-filename" title={entry.filename}>{entry.filename}</span>
                            {showBar && <VolumeProgressBar p={rp} />}
                          </div>

                          {isConfirmRestore ? (
                            <div className="backup-inline-confirm">
                              <span className="backup-confirm-text">Restore will overwrite existing data.</span>
                              <div className="backup-confirm-actions">
                                <button className="btn-execute btn-execute--success btn-sm" onClick={() => runRestore(entry)} disabled={anyRunning}>
                                  <RotateCcw size={11} /> Confirm
                                </button>
                                <button className="btn-reset btn-sm" onClick={() => setConfirmRestore(null)}>Cancel</button>
                              </div>
                            </div>
                          ) : isConfirmDelete ? (
                            <div className="backup-inline-confirm">
                              <span className="backup-confirm-text backup-confirm-text--danger">This will permanently delete the archive.</span>
                              <div className="backup-confirm-actions">
                                <button className="btn-execute btn-execute--danger btn-sm" onClick={() => runDelete(entry)} disabled={isDeleting}>
                                  <Trash2 size={11} /> Delete
                                </button>
                                <button className="btn-reset btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div className="backup-list-actions">
                              <button
                                className="ctr-action-btn ctr-action-start"
                                onClick={() => { setConfirmRestore(entry); setConfirmDelete(null) }}
                                disabled={anyRunning || isDeleting}
                                title="Restore volume from this backup"
                              >
                                <RotateCcw size={13} />
                              </button>
                              <button
                                className="ctr-action-btn ctr-action-stop"
                                onClick={() => { setConfirmDelete(entry); setConfirmRestore(null) }}
                                disabled={anyRunning || isDeleting}
                                title="Delete this backup"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )
          }
        </div>
      </div>
    </div>
  )
}
