import { useEffect, useRef, useState, useMemo } from 'react'
import {
  Folder, HardDriveDownload, RotateCcw, RefreshCw, Download,
  AlertTriangle, MoveRight, Trash2, X, CheckCircle2, AlertCircle, Info,
} from 'lucide-react'
import clsx from 'clsx'
import { listen } from '@tauri-apps/api/event'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { DockerVolume, VolumeBackupEntry, ComposeBackupEntry, ComposeProject, BackupProgress } from '../types'

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
  const d    = new Date(ts * 1000)
  const now  = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Truncate long volume/project names with an ellipsis. */
function truncName(name: string, max = 30): string {
  return name.length <= max ? name : name.slice(0, max - 1) + '…'
}

/** Return a dot class for compose status strings like "running(2), exited(1)". */
function composeDot(status: string): 'running' | 'partial' | 'stopped' {
  const parts = status.split(',').map(s => {
    const m = s.trim().match(/^(\w+)\((\d+)\)$/)
    return m ? { state: m[1], count: parseInt(m[2]) } : { state: s.trim(), count: 1 }
  })
  const total   = parts.reduce((s, p) => s + p.count, 0)
  const running = parts.find(p => p.state === 'running')?.count ?? 0
  return running === 0 ? 'stopped' : running === total ? 'running' : 'partial'
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ p }: { p: VolumeProgress }) {
  return (
    <div className="vol-progress-wrap">
      <div className="vol-progress-track">
        <div
          className={clsx('vol-progress-fill',
            p.status === 'running' && 'running', p.status === 'done' && 'done',
            p.status === 'error' && 'error',     p.status === 'queued' && 'queued',
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
      <button className="backup-notice-close" onClick={onDismiss} title="Dismiss"><X size={13} /></button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function BackupTab({
  volumes,
  section = 'volumes',
}: {
  volumes: DockerVolume[]
  section?: 'volumes' | 'compose'
}) {
  const { backupDir, setBackupDir, backupPreselect, setBackupPreselect } = useAppStore()

  // Volume backup state
  const [dirInput, setDirInput]             = useState(backupDir)
  const [backups, setBackups]               = useState<VolumeBackupEntry[]>([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [selected, setSelected]             = useState<Set<string>>(new Set())
  const [isBacking, setIsBacking]           = useState(false)
  const [volProgress, setVolProgress]       = useState<Record<string, VolumeProgress>>({})
  const [confirmRestore, setConfirmRestore] = useState<VolumeBackupEntry | null>(null)
  const [confirmDelete, setConfirmDelete]   = useState<VolumeBackupEntry | null>(null)
  const [isDeleting, setIsDeleting]         = useState(false)

  // Compose backup state
  const [composeProjects, setComposeProjects]   = useState<ComposeProject[]>([])
  const [composeBackups, setComposeBackups]     = useState<ComposeBackupEntry[]>([])
  const [backingUpCompose, setBackingUpCompose] = useState<Set<string>>(new Set())
  const [deletingCompose, setDeletingCompose]   = useState<string | null>(null)

  // Directory change state
  const [pendingDir, setPendingDir]   = useState<string | null>(null)
  const [existingCount, setExistingCount] = useState(0)
  const [transferring, setTransferring]   = useState(false)

  // Notices
  const [notices, setNotices] = useState<Notice[]>([])
  const noticeId = useRef(0)
  const addNotice = (type: Notice['type'], message: string) =>
    setNotices(prev => [...prev, { id: String(++noticeId.current), type, message }])
  const dismissNotice = (id: string) => setNotices(prev => prev.filter(n => n.id !== id))

  const prevVolumesRef = useRef<DockerVolume[]>(volumes)

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!backupDir) api.getDefaultBackupDir().then(dir => { setBackupDir(dir); setDirInput(dir) })
    api.dockerComposeLs().then(setComposeProjects).catch(() => setComposeProjects([]))
  }, []) // eslint-disable-line

  useEffect(() => {
    if (backupDir) { loadBackups(backupDir); loadComposeBackups(backupDir) }
  }, [backupDir]) // eslint-disable-line

  useEffect(() => {
    if (prevVolumesRef.current !== volumes) {
      prevVolumesRef.current = volumes
      if (backupDir) { loadBackups(backupDir); loadComposeBackups(backupDir) }
    }
  }, [volumes]) // eslint-disable-line

  useEffect(() => { setDirInput(backupDir) }, [backupDir])

  // Pre-select a volume arriving from another tab
  useEffect(() => {
    if (backupPreselect) {
      setSelected(prev => new Set([...prev, backupPreselect]))
      setBackupPreselect(null)
    }
  }, [backupPreselect]) // eslint-disable-line

  // ── Data loaders ───────────────────────────────────────────────────────────

  const loadBackups = async (dir: string) => {
    setBackupsLoading(true)
    try { setBackups(await api.dockerListBackups(dir)) }
    catch { setBackups([]) }
    finally { setBackupsLoading(false) }
  }

  const loadComposeBackups = async (dir: string) => {
    try { setComposeBackups(await api.dockerListAllComposeBackups(dir)) }
    catch { setComposeBackups([]) }
  }

  // ── Derived data ───────────────────────────────────────────────────────────

  const sortedBackups = useMemo(() =>
    backups.slice().sort((a, b) => b.created_at - a.created_at), [backups])

  const backupsByVolume = useMemo(() => {
    const map: Record<string, VolumeBackupEntry[]> = {}
    for (const e of sortedBackups) {
      if (!map[e.volume]) map[e.volume] = []
      map[e.volume].push(e)
    }
    return map
  }, [sortedBackups])

  const knownVolumeNames = useMemo(() => new Set(volumes.map(v => v.name)), [volumes])
  const orphanedBackups  = useMemo(() =>
    sortedBackups.filter(e => !knownVolumeNames.has(e.volume)), [sortedBackups, knownVolumeNames])

  /** Merged list: running projects + projects that only exist in backup history. */
  const allComposeItems = useMemo(() => {
    const map = new Map<string, { project: ComposeProject | null; backups: ComposeBackupEntry[] }>()
    for (const p of composeProjects)
      map.set(p.name, { project: p, backups: [] })
    for (const b of composeBackups) {
      if (!map.has(b.project)) map.set(b.project, { project: null, backups: [] })
      map.get(b.project)!.backups.push(b)
    }
    return Array.from(map.entries()).map(([name, d]) => ({
      name,
      project: d.project,
      backups: d.backups.sort((a, b) => b.created_at - a.created_at),
    }))
  }, [composeProjects, composeBackups])

  // ── Directory change ───────────────────────────────────────────────────────

  const appendAtlasBackup = (dir: string) => {
    const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '')
    return /\/atlas backup$/i.test(norm) ? norm : `${norm}/Atlas Backup`
  }

  const handlePickFolder = async () => {
    const dir = await api.pickBackupFolder()
    if (!dir) return
    const final = appendAtlasBackup(dir)
    setDirInput(final); setPendingDir(null)
    if (final !== backupDir) applyDirChange(final)
  }

  const applyDirChange = async (newDir: string) => {
    if (!newDir || newDir === backupDir) return
    if (backupDir) {
      try {
        const existing = await api.dockerListBackups(backupDir)
        if (existing.length > 0) { setExistingCount(existing.length); setPendingDir(newDir); return }
      } catch { /* no existing */ }
    }
    commitDirChange(newDir)
    addNotice('success', `Backup directory updated to ${newDir}`)
  }

  const commitDirChange = (newDir: string) => {
    setBackupDir(newDir); setDirInput(newDir); setPendingDir(null); loadBackups(newDir)
  }

  const handleApplyDir = async () => {
    const d = dirInput.trim(); if (!d || d === backupDir) return; await applyDirChange(d)
  }

  const handleTransfer = async (shouldTransfer: boolean) => {
    if (!pendingDir) return
    if (!shouldTransfer) {
      commitDirChange(pendingDir)
      addNotice('info', `Directory changed. Existing backups were not moved.`)
      return
    }
    setTransferring(true)
    try {
      const result = await api.transferBackups(backupDir, pendingDir)
      commitDirChange(pendingDir)
      const msg = `${result.moved} backup${result.moved !== 1 ? 's' : ''} moved.`
        + (result.old_dir_removed ? ' Previous folder removed.' : ' Previous folder kept.')
      addNotice('success', msg)
    } catch (e) {
      addNotice('error', `Transfer failed: ${String(e)}`); setPendingDir(null)
    } finally { setTransferring(false) }
  }

  // ── Volume backup ──────────────────────────────────────────────────────────

  const toggleVolume = (name: string) =>
    setSelected(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s })

  const runBackup = async () => {
    if (!backupDir || selected.size === 0 || isBacking) return
    const initial: Record<string, VolumeProgress> = {}
    for (const v of selected) initial[v] = { status: 'queued', progress: 0, message: 'Queued…' }
    setVolProgress(initial); setIsBacking(true)
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`─── Volume backup (${selected.size} volume${selected.size !== 1 ? 's' : ''})`, 'cmd')
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
          status:   done ? (error ? 'error' : 'done') : 'running',
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
      unlisten(); setIsBacking(false)
      setTimeout(() => setVolProgress({}), 3000)
    }
  }

  const runRestore = async (entry: VolumeBackupEntry) => {
    setConfirmRestore(null)
    const { addTerminalLine } = useAppStore.getState()
    addTerminalLine(`─── Restore: ${entry.volume}`, 'cmd')
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
          status:   done ? (error ? 'error' : 'done') : 'running',
          progress: done ? (error ? (prev[key]?.progress ?? 0) : 100) : progress,
          message: step, error: error ?? undefined,
        },
      }))
    })
    try { await api.dockerVolumeRestore(entry.volume, entry.path) }
    catch (e) { useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error') }
    finally {
      unlisten()
      setTimeout(() => setVolProgress(prev => { const n = { ...prev }; delete n[entry.volume]; return n }), 3000)
    }
  }

  const runDeleteVolBackup = async (entry: VolumeBackupEntry) => {
    setConfirmDelete(null); setIsDeleting(true)
    try {
      await api.dockerDeleteBackup(backupDir, entry.filename)
      setBackups(prev => prev.filter(b => b.filename !== entry.filename))
    } catch (e) { addNotice('error', `Delete failed: ${String(e)}`) }
    finally { setIsDeleting(false) }
  }

  // ── Compose backup ─────────────────────────────────────────────────────────

  const handleBackupCompose = async (project: ComposeProject) => {
    if (!backupDir) { addNotice('error', 'Set a backup directory first'); return }
    setBackingUpCompose(prev => new Set([...prev, project.name]))
    try {
      const saved = await api.dockerBackupCompose(project.name, project.config_files, backupDir)
      if (saved.length === 0) {
        addNotice('info', `${project.name}: No changes — already up to date`)
      } else {
        addNotice('success', `${project.name}: ${saved.length} file${saved.length !== 1 ? 's' : ''} backed up`)
        await loadComposeBackups(backupDir)
      }
    } catch (e) {
      addNotice('error', `${project.name}: backup failed — ${String(e)}`)
    } finally {
      setBackingUpCompose(prev => { const s = new Set(prev); s.delete(project.name); return s })
    }
  }

  const deleteComposeBackup = async (entry: ComposeBackupEntry) => {
    setDeletingCompose(entry.filename)
    try {
      await api.dockerDeleteComposeBackup(backupDir, entry.filename)
      setComposeBackups(prev => prev.filter(b => b.filename !== entry.filename))
    } catch (e) { addNotice('error', `Delete failed: ${String(e)}`) }
    finally { setDeletingCompose(null) }
  }

  // ── Computed ───────────────────────────────────────────────────────────────

  const anyRunning = isBacking || Object.values(volProgress).some(p => p.status === 'running')

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="backup-tab">

      {/* ── Directory bar ─────────────────────────────────────────── */}
      <div className="backup-bar">
        <div className="backup-bar-inner">
          <Folder size={13} className="backup-bar-icon" />
          <input
            className="backup-bar-input"
            value={dirInput}
            onChange={e => { setDirInput(e.target.value); setPendingDir(null) }}
            onBlur={handleApplyDir}
            onKeyDown={e => e.key === 'Enter' && handleApplyDir()}
            placeholder="Select a backup root directory…"
            spellCheck={false}
          />
          <button className="backup-bar-btn" onClick={handlePickFolder} title="Pick folder">
            Select Folder
          </button>
          <button
            className="ctr-action-btn"
            onClick={() => backupDir && loadBackups(backupDir)}
            disabled={!backupDir || backupsLoading}
            title="Refresh"
          >
            <RefreshCw size={12} className={backupsLoading ? 'spin' : ''} />
          </button>
        </div>
        {backupDir && (
          <span className="backup-bar-hint">
            <code>docker/volumes/</code> and <code>docker/compose/</code>
          </span>
        )}
      </div>

      {/* ── Notices ───────────────────────────────────────────────── */}
      {notices.map(n => <NoticeBanner key={n.id} n={n} onDismiss={() => dismissNotice(n.id)} />)}

      {/* ── Transfer prompt ───────────────────────────────────────── */}
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
            <button className="btn-execute btn-execute--success" onClick={() => handleTransfer(true)} disabled={transferring}>
              <MoveRight size={12} />{transferring ? 'Moving…' : 'Transfer & Switch'}
            </button>
            <button className="btn-reset" onClick={() => handleTransfer(false)} disabled={transferring}>Switch without moving</button>
            <button className="btn-reset" onClick={() => { setPendingDir(null); setDirInput(backupDir) }} disabled={transferring}>Cancel</button>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          VOLUMES  (only rendered when section === 'volumes')
          ════════════════════════════════════════════════════════════ */}
      {section === 'volumes' && (<>
      <div className="backup-section-hd">
        <span className="backup-section-title">Volumes</span>
        <span className="backup-section-meta">
          {backupsLoading ? 'Loading…'
            : `${volumes.length} volume${volumes.length !== 1 ? 's' : ''}` +
              (sortedBackups.length - orphanedBackups.length > 0
                ? ` · ${sortedBackups.length - orphanedBackups.length} archive${sortedBackups.length - orphanedBackups.length !== 1 ? 's' : ''}` : '')}
        </span>
      </div>

      {volumes.length === 0
        ? <p className="backup-empty-state">No Docker volumes found.</p>
        : (
          <ul className="backup-item-list">
            {volumes.map(v => {
              const checked     = selected.has(v.name)
              const vp          = volProgress[v.name]
              const showBar     = vp && vp.status !== 'idle'
              const volArchives = backupsByVolume[v.name] ?? []
              const statusCls   = v.containers.length > 0 ? 'badge-active' : v.in_use ? 'badge-paused' : 'badge-idle'
              const statusTxt   = v.containers.length > 0 ? 'running' : v.in_use ? 'stopped ref' : 'unused'

              return (
                <li key={v.name} className="backup-item">
                  {/* ── Volume header row ────── */}
                  <label className={clsx('backup-item-row', checked && 'selected')}>
                    <input
                      type="checkbox"
                      className="backup-item-check"
                      checked={checked}
                      onChange={() => toggleVolume(v.name)}
                      disabled={anyRunning}
                    />
                    <span className="backup-item-name" title={v.name}>{truncName(v.name)}</span>
                    <div className="backup-item-tags">
                      <span className={clsx('badge', statusCls)}>{statusTxt}</span>
                      {v.containers.length > 0 && (
                        <span className="backup-warn-icon" title="Running containers will be paused">
                          <AlertTriangle size={11} />
                        </span>
                      )}
                      {v.containers.length > 0 && (
                        <span className="backup-vol-tag backup-vol-tag--containers" title={v.containers.join(', ')}>
                          {v.containers.join(', ')}
                        </span>
                      )}
                      {v.compose_project && (
                        <span className="backup-vol-tag backup-vol-tag--compose">{v.compose_project}</span>
                      )}
                    </div>
                  </label>

                  {/* Progress bar */}
                  {showBar && <ProgressBar p={vp} />}

                  {/* Archive tree */}
                  {volArchives.length > 0 && (
                    <ul className="backup-tree">
                      {volArchives.map((entry, idx) => {
                        const rp          = volProgress[entry.volume]
                        // Only show progress on the archive row during RESTORE.
                        // During backup the progress bar lives on the volume row itself.
                        const showRBar    = !isBacking && rp && (rp.status === 'running' || rp.status === 'queued')
                        const isConfirmR  = confirmRestore?.filename === entry.filename
                        const isConfirmD  = confirmDelete?.filename  === entry.filename
                        const isLast      = idx === volArchives.length - 1

                        return (
                          <li key={entry.filename}
                            className={clsx('backup-tree-item', isLast && 'last', (isConfirmR || isConfirmD) && 'confirming')}>
                            <div className="backup-tree-content">
                              <div className="backup-tree-info">
                                <span className="backup-tree-date">{formatDate(entry.created_at)}</span>
                                <span className="backup-tree-size">{bytesToHuman(entry.size_bytes)}</span>
                                <span className="backup-tree-file" title={entry.filename}>{entry.filename}</span>
                              </div>
                              {isConfirmR ? (
                                <div className="backup-inline-confirm">
                                  <span className="backup-confirm-text">Restore will overwrite existing data.</span>
                                  <div className="backup-confirm-actions">
                                    <button className="btn-execute btn-execute--success btn-sm" onClick={() => runRestore(entry)} disabled={anyRunning}>
                                      <RotateCcw size={11} /> Confirm
                                    </button>
                                    <button className="btn-reset btn-sm" onClick={() => setConfirmRestore(null)}>Cancel</button>
                                  </div>
                                </div>
                              ) : isConfirmD ? (
                                <div className="backup-inline-confirm">
                                  <span className="backup-confirm-text backup-confirm-text--danger">Permanently delete archive?</span>
                                  <div className="backup-confirm-actions">
                                    <button className="btn-execute btn-execute--danger btn-sm" onClick={() => runDeleteVolBackup(entry)} disabled={isDeleting}>
                                      <Trash2 size={11} /> Delete
                                    </button>
                                    <button className="btn-reset btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="backup-tree-actions">
                                  <button className="ctr-action-btn ctr-action-start"
                                    onClick={() => { setConfirmRestore(entry); setConfirmDelete(null) }}
                                    disabled={anyRunning || isDeleting} title="Restore from this backup">
                                    <RotateCcw size={12} />
                                  </button>
                                  <button className="ctr-action-btn ctr-action-stop"
                                    onClick={() => { setConfirmDelete(entry); setConfirmRestore(null) }}
                                    disabled={anyRunning || isDeleting} title="Delete this backup">
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              )}
                            </div>
                            {showRBar && <ProgressBar p={rp} />}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}

            {/* Orphaned archives */}
            {orphanedBackups.length > 0 && (
              <li className="backup-item backup-item--orphan">
                <div className="backup-orphaned-label">
                  <span>Orphaned archives</span>
                  <span className="backup-section-meta">{orphanedBackups.length} from deleted volumes</span>
                </div>
                <ul className="backup-tree">
                  {orphanedBackups.map((entry, idx) => (
                    <li key={entry.filename}
                      className={clsx('backup-tree-item', idx === orphanedBackups.length - 1 && 'last')}>
                      <div className="backup-tree-content">
                        <div className="backup-tree-info">
                          <span className="backup-tree-vol">{entry.volume}</span>
                          <span className="backup-tree-date">{formatDate(entry.created_at)}</span>
                          <span className="backup-tree-size">{bytesToHuman(entry.size_bytes)}</span>
                          <span className="backup-tree-file" title={entry.filename}>{entry.filename}</span>
                        </div>
                        <div className="backup-tree-actions">
                          <button className="ctr-action-btn ctr-action-stop"
                            onClick={() => { setConfirmDelete(entry); setConfirmRestore(null) }}
                            disabled={anyRunning || isDeleting} title="Delete this backup">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        )
      }

      {/* Volume backup action */}
      <div className="backup-action-row">
        <button
          className="btn-execute btn-execute--success"
          onClick={runBackup}
          disabled={anyRunning || selected.size === 0 || !backupDir}
          title={!backupDir ? 'Set a backup directory first' : ''}
        >
          <HardDriveDownload size={13} />
          {isBacking ? 'Backing up…'
            : selected.size > 0 ? `Backup ${selected.size} selected`
            : 'Select volumes to back up'}
        </button>
      </div>
      </>)}

      {/* ════════════════════════════════════════════════════════════
          COMPOSE  (only rendered when section === 'compose')
          ════════════════════════════════════════════════════════════ */}
      {section === 'compose' && (<>
      <div className="backup-section-hd">
        <span className="backup-section-title">Compose</span>
        <span className="backup-section-meta">
          {allComposeItems.length} project{allComposeItems.length !== 1 ? 's' : ''}
          {composeBackups.length > 0 && ` · ${composeBackups.length} archive${composeBackups.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {allComposeItems.length === 0
        ? <p className="backup-empty-state">No compose projects found.</p>
        : (
          <ul className="backup-item-list">
            {allComposeItems.map(item => {
              const isBacking  = backingUpCompose.has(item.name)
              const dot        = item.project ? composeDot(item.project.status) : 'stopped'

              return (
                <li key={item.name} className="backup-item">
                  {/* ── Project header row ────── */}
                  <div className="backup-item-row backup-item-row--compose">
                    <span className={clsx('compose-status-dot', dot)} />
                    <span className="backup-item-name" title={item.name}>{truncName(item.name)}</span>
                    <div className="backup-item-tags">
                      {!item.project && <span className="badge badge-idle">archived only</span>}
                      {item.project && (
                        <span className="backup-vol-tag" title={item.project.config_files.join(', ')}>
                          {item.project.config_files.length} file{item.project.config_files.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {item.project && (
                      <button
                        className={clsx('btn-execute btn-execute--success btn-sm backup-compose-backup-btn', isBacking && 'loading')}
                        onClick={() => handleBackupCompose(item.project!)}
                        disabled={isBacking || !backupDir}
                        title={!backupDir ? 'Set a backup directory first' : `Back up compose files for '${item.name}'`}
                      >
                        <Download size={11} className={isBacking ? 'spin' : ''} />
                        {isBacking ? 'Backing up…' : 'Backup'}
                      </button>
                    )}
                  </div>

                  {/* Compose archive tree */}
                  {item.backups.length > 0 && (
                    <ul className="backup-tree">
                      {item.backups.map((entry, idx) => {
                        const origFile = entry.original_path.split(/[\\/]/).pop() ?? entry.original_path
                        return (
                          <li key={entry.filename}
                            className={clsx('backup-tree-item', idx === item.backups.length - 1 && 'last')}>
                            <div className="backup-tree-content">
                              <div className="backup-tree-info">
                                <span className="backup-tree-vol">{origFile}</span>
                                <span className="backup-tree-date">{formatDate(entry.created_at)}</span>
                                <span className="backup-tree-size">{bytesToHuman(entry.size_bytes)}</span>
                                <span className="backup-tree-file" title={entry.filename}>{entry.filename}</span>
                              </div>
                              <div className="backup-tree-actions">
                                <button
                                  className="ctr-action-btn ctr-action-stop"
                                  onClick={() => deleteComposeBackup(entry)}
                                  disabled={deletingCompose === entry.filename}
                                  title="Delete this backup"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )
      }
      </>)}

    </div>
  )
}
