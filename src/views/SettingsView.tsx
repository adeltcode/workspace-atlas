import { useEffect, useState } from 'react'
import { Folder, RefreshCw, MoveRight, HardDriveDownload, Info, ExternalLink, Shield, Upload, Download } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { SheetHead } from '../components/ui'
import * as api from '../features/docker/api'
import { exportConfig, importConfig } from '../features/config/api'

const STORAGE_KEY = 'workspace-atlas-v1'

// Persisted keys that are NOT configuration: transient navigation and local
// history. Stripped from config export/import so importing settings never yanks
// the user to another view or overwrites their run history.
const NON_CONFIG_KEYS = ['activeView', 'dockerTab', 'dockerLogs', 'activityLog']

/** Return the persisted blob with non-config keys removed, or null if unparseable. */
function stripNonConfig(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.state !== 'object') return null
    for (const k of NON_CONFIG_KEYS) delete parsed.state[k]
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

export default function SettingsView() {
  const { backupDir, setBackupDir } = useAppStore()

  const [dirInput, setDirInput]       = useState(backupDir)
  const [pendingDir, setPendingDir]   = useState<string | null>(null)
  const [existingCount, setExistingCount] = useState(0)
  const [transferring, setTransferring]   = useState(false)
  const [refreshing, setRefreshing]       = useState(false)
  const [statusMsg, setStatusMsg]         = useState<{ type: 'success' | 'info' | 'error'; text: string } | null>(null)

  useEffect(() => { setDirInput(backupDir) }, [backupDir])

  useEffect(() => {
    if (!backupDir) {
      api.getDefaultBackupDir().then(dir => {
        setBackupDir(dir)
        setDirInput(dir)
      }).catch(() => {})
    }
  }, []) // eslint-disable-line

  const appendAtlasBackup = (dir: string) => {
    const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '')
    return /\/atlas backup$/i.test(norm) ? norm : `${norm}/Atlas Backup`
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
      } catch { /* no existing */ }
    }
    commitDirChange(newDir)
    setStatusMsg({ type: 'success', text: `Backup directory updated to ${newDir}` })
  }

  const commitDirChange = (newDir: string) => {
    setBackupDir(newDir)
    setDirInput(newDir)
    setPendingDir(null)
  }

  const handlePickFolder = async () => {
    const dir = await api.pickBackupFolder()
    if (!dir) return
    const final = appendAtlasBackup(dir)
    setDirInput(final)
    setPendingDir(null)
    if (final !== backupDir) applyDirChange(final)
  }

  const handleApplyDir = async () => {
    const d = dirInput.trim()
    if (!d || d === backupDir) return
    await applyDirChange(d)
  }

  const handleTransfer = async (shouldTransfer: boolean) => {
    if (!pendingDir) return
    if (!shouldTransfer) {
      commitDirChange(pendingDir)
      setStatusMsg({ type: 'info', text: 'Directory changed. Existing backups were not moved.' })
      return
    }
    setTransferring(true)
    try {
      const result = await api.transferBackups(backupDir, pendingDir)
      commitDirChange(pendingDir)
      const msg = `${result.moved} backup${result.moved !== 1 ? 's' : ''} moved.`
        + (result.old_dir_removed ? ' Previous folder removed.' : ' Previous folder kept.')
      setStatusMsg({ type: 'success', text: msg })
    } catch (e) {
      setStatusMsg({ type: 'error', text: `Transfer failed: ${String(e)}` })
      setPendingDir(null)
    } finally { setTransferring(false) }
  }

  const handleExportConfig = async () => {
    const raw = localStorage.getItem(STORAGE_KEY)
    const contents = raw && stripNonConfig(raw)
    if (!contents) {
      setStatusMsg({ type: 'error', text: 'No configuration to export yet.' })
      return
    }
    try {
      const path = await exportConfig(contents)
      if (path) setStatusMsg({ type: 'success', text: `Configuration exported to ${path}` })
    } catch (e) {
      setStatusMsg({ type: 'error', text: `Export failed: ${String(e)}` })
    }
  }

  const handleImportConfig = async () => {
    let contents: string | null
    try {
      contents = await importConfig()
    } catch (e) {
      setStatusMsg({ type: 'error', text: `Import failed: ${String(e)}` })
      return
    }
    if (!contents) return // cancelled
    try {
      // Sanitize first: rejects junk, and strips navigation/history so an import
      // can't yank the user to another view or replace local run history. Missing
      // keys are kept at their current values by zustand's merge-on-rehydrate.
      const sanitized = stripNonConfig(contents)
      if (!sanitized) {
        throw new Error('Not a valid Workspace Atlas configuration file')
      }
      localStorage.setItem(STORAGE_KEY, sanitized)
      await useAppStore.persist.rehydrate()
      setStatusMsg({ type: 'success', text: 'Configuration imported and applied.' })
    } catch (e) {
      setStatusMsg({ type: 'error', text: `Import failed: ${String(e)}` })
    }
  }

  const handleRefresh = async () => {
    if (!backupDir) return
    setRefreshing(true)
    try {
      const count = await api.dockerListBackups(backupDir)
      setStatusMsg({ type: 'info', text: `${count.length} backup${count.length !== 1 ? 's' : ''} found in directory.` })
    } catch {
      setStatusMsg({ type: 'error', text: 'Could not read backup directory.' })
    } finally { setRefreshing(false) }
  }

  return (
    <div className="view-container">
      <div className="page-head">
        <SheetHead
          crumbs={[
            { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
            { label: 'Settings' },
          ]}
          title="Settings"
          subtitle="Preferences, backup location, and configuration transfer."
        />
      </div>

      <div className="page-scroll settings-body">

        {/* ── Backup Location ─────────────────────────────────────────────── */}
        <div className="settings-card">
          <div className="settings-card-header">
            <HardDriveDownload size={15} className="settings-card-icon" />
            <div>
              <h2 className="settings-card-title">Backup Location</h2>
              <p className="settings-card-desc">
                The root directory where volume and compose backups are stored.
                Atlas automatically creates <code>docker/volumes/</code> and <code>docker/compose/</code> subdirectories.
              </p>
            </div>
          </div>

          <div className="settings-dir-row">
            <div className="settings-dir-input-wrap">
              <Folder size={13} className="settings-dir-icon" />
              <input
                className="settings-dir-input"
                aria-label="Backup directory path"
                value={dirInput}
                onChange={e => { setDirInput(e.target.value); setPendingDir(null); setStatusMsg(null) }}
                onBlur={handleApplyDir}
                onKeyDown={e => e.key === 'Enter' && handleApplyDir()}
                placeholder="No backup directory configured…"
                spellCheck={false}
              />
            </div>
            <button className="settings-dir-btn" onClick={handlePickFolder}>
              Browse…
            </button>
            <button
              className="settings-dir-refresh"
              onClick={handleRefresh}
              disabled={!backupDir || refreshing}
              title="Check backup directory"
            >
              <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
            </button>
          </div>

          {backupDir && (
            <p className="settings-dir-hint">
              Archives are saved under <code>{backupDir}/docker/volumes/</code> and <code>.../docker/compose/</code>
            </p>
          )}

          {/* Status message */}
          {statusMsg && (
            <div className={`settings-status settings-status--${statusMsg.type}`}>
              {statusMsg.text}
            </div>
          )}

          {/* Transfer prompt */}
          {pendingDir && (
            <div className="settings-transfer-card">
              <div className="settings-transfer-header">
                <MoveRight size={14} className="settings-transfer-icon" />
                <div className="settings-transfer-body">
                  <span className="settings-transfer-title">
                    {existingCount} backup{existingCount !== 1 ? 's' : ''} found in current directory
                  </span>
                  <span className="settings-transfer-sub">
                    Move them to <code>{pendingDir}</code> before switching?
                  </span>
                </div>
              </div>
              <div className="settings-transfer-actions">
                <button
                  className="btn-filled btn-filled--success"
                  onClick={() => handleTransfer(true)}
                  disabled={transferring}
                >
                  <MoveRight size={12} />
                  {transferring ? 'Moving…' : 'Transfer & Switch'}
                </button>
                <button className="btn-ghost" onClick={() => handleTransfer(false)} disabled={transferring}>
                  Switch without moving
                </button>
                <button className="btn-ghost" onClick={() => { setPendingDir(null); setDirInput(backupDir) }} disabled={transferring}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Configuration ─────────────────────────────────────────────────── */}
        <div className="settings-card">
          <div className="settings-card-header">
            <HardDriveDownload size={15} className="settings-card-icon" />
            <div>
              <h2 className="settings-card-title">Configuration</h2>
              <p className="settings-card-desc">
                Export all Atlas preferences (backup location, keep-list, editor, activity log)
                to a single portable file, and re-import it on another machine.
              </p>
            </div>
          </div>
          <div className="settings-config-actions">
            <button className="settings-dir-btn" onClick={handleExportConfig}>
              <Download size={13} />
              Export configuration
            </button>
            <button className="settings-dir-btn" onClick={handleImportConfig}>
              <Upload size={13} />
              Import configuration
            </button>
          </div>
        </div>

        {/* ── About ────────────────────────────────────────────────────────── */}
        <div className="settings-card">
          <div className="settings-card-header">
            <Info size={15} className="settings-card-icon" style={{ color: 'var(--color-text-secondary)' }} />
            <div>
              <h2 className="settings-card-title">About</h2>
              <p className="settings-card-desc">Version info and project details.</p>
            </div>
          </div>
          <div className="settings-about-body">
            <div className="settings-about-row">
              <span className="settings-about-label">Version</span>
              <span className="settings-about-value">v0.1.0-dev</span>
            </div>
            <div className="settings-about-row">
              <span className="settings-about-label">Repository</span>
              <a
                className="settings-about-link"
                href="https://github.com/adeltcode/workspace-atlas"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={12} />
                adeltcode/workspace-atlas
              </a>
            </div>
            <div className="settings-about-row">
              <span className="settings-about-label">Privacy</span>
              <span className="settings-about-value settings-about-privacy">
                <Shield size={12} />
                Fully offline - no telemetry, no account
              </span>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
