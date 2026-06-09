import { useCallback, useEffect, useState } from 'react'
import {
  Save, RotateCcw, FolderOpen, Power, FilePlus, AlertTriangle,
  ListChecks, FileCode2, Archive, History, Trash2, Undo2, ChevronRight, ChevronDown,
} from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import { wslShutdown, revealPath } from '../api'
import { getIniValue, setIniValue, type WslField, type WslSection } from '../ini'
import { bytesToHuman, formatDate } from '../../../utils/format'
import type { WslConfigBackup } from '../types'

export interface IniBackend {
  load: () => Promise<{ path: string; content: string; exists: boolean }>
  save: (content: string) => Promise<void>
  listBackups: () => Promise<WslConfigBackup[]>
  createBackup: () => Promise<WslConfigBackup>
  restoreBackup: (path: string) => Promise<string>
  deleteBackup: (path: string) => Promise<void>
}

type Status = { type: 'success' | 'error'; text: string } | null
type Mode = 'form' | 'raw'

/** One labelled control for a key (select for bool/enum, text otherwise). */
function FieldRow({ field, value, onChange }: {
  field: WslField; value: string; onChange: (v: string) => void
}) {
  const control = () => {
    if (field.type === 'bool' || field.type === 'enum') {
      const opts = field.type === 'bool' ? ['true', 'false'] : (field.options ?? [])
      const all = value && !opts.some(o => o.toLowerCase() === value.toLowerCase()) ? [value, ...opts] : opts
      const selected = all.find(o => o.toLowerCase() === value.toLowerCase()) ?? ''
      return (
        <select className="wslcfg-field-control" value={selected} onChange={e => onChange(e.target.value)}>
          <option value="">Default</option>
          {all.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    return (
      <input
        className="wslcfg-field-control"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={field.placeholder ?? 'unset'}
        spellCheck={false}
        autoComplete="off"
      />
    )
  }
  return (
    <div className="wslcfg-field">
      <div className="wslcfg-field-head">
        <span className="wslcfg-field-label">{field.label}</span>
        <code className="wslcfg-field-key">{field.key}</code>
      </div>
      {control()}
      {field.hint && <span className="wslcfg-field-hint">{field.hint}</span>}
    </div>
  )
}

export default function IniConfigEditor({
  label, sections, commonSplit, template, backend, runningNames, onAfterShutdown,
}: {
  label: string
  sections: WslSection[]
  commonSplit?: boolean
  template?: string
  backend: IniBackend
  runningNames: string[]
  onAfterShutdown: () => void
}) {
  const addActivity     = useAppStore(s => s.addActivity)
  const addTerminalLine = useAppStore(s => s.addTerminalLine)

  const [path, setPath]         = useState('')
  const [text, setText]         = useState('')   // raw file text — single source of truth
  const [original, setOriginal] = useState('')
  const [exists, setExists]     = useState(true)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [status, setStatus]     = useState<Status>(null)
  const [mode, setMode]         = useState<Mode>('form')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const [backups, setBackups]   = useState<WslConfigBackup[]>([])
  const [backing, setBacking]   = useState(false)
  const [confirmRestore, setConfirmRestore] = useState<WslConfigBackup | null>(null)

  const dirty = text !== original

  const load = useCallback(async () => {
    setLoading(true)
    setStatus(null)
    try {
      const cfg = await backend.load()
      setPath(cfg.path)
      setText(cfg.content)
      setOriginal(cfg.content)
      setExists(cfg.exists)
    } catch (e) {
      setStatus({ type: 'error', text: String(e) })
    } finally {
      setLoading(false)
    }
  }, [backend])

  const loadBackups = useCallback(async () => {
    try { setBackups(await backend.listBackups()) } catch { /* ignore */ }
  }, [backend])

  // Reload whenever the backend changes (e.g. a different distro is selected).
  useEffect(() => { load(); loadBackups() }, [load, loadBackups])

  const setField = (field: WslField, section: string, val: string) => {
    setText(t => setIniValue(t, section, field.key, val))
    setStatus(null)
  }

  const grid = (section: string, fields: WslField[]) => (
    <div className="wslcfg-form-grid">
      {fields.map(f => (
        <FieldRow
          key={f.key}
          field={f}
          value={getIniValue(text, section, f.key) ?? ''}
          onChange={v => setField(f, section, v)}
        />
      ))}
    </div>
  )

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      await backend.save(text)
      setOriginal(text)
      setExists(true)
      // The backend emits the command + result to the terminal (no black box).
      addActivity({ module: 'wsl', action: `Edited ${label}`, outcome: 'success' })
      setStatus({ type: 'success', text: 'Saved. Restart WSL to apply changes.' })
    } catch (e) {
      addActivity({ module: 'wsl', action: `Edited ${label}`, outcome: 'failure', detail: String(e) })
      setStatus({ type: 'error', text: String(e) })
    } finally {
      setSaving(false)
    }
  }

  // Snapshot the config. Saves first if there are unsaved edits, so the backup
  // reflects what the user sees.
  const backup = async () => {
    setBacking(true)
    setStatus(null)
    try {
      if (dirty) { await backend.save(text); setOriginal(text); setExists(true) }
      const entry = await backend.createBackup()
      addActivity({ module: 'wsl', action: `Backed up ${label}`, outcome: 'success' })
      setStatus({ type: 'success', text: `Backed up as ${entry.filename}` })
      await loadBackups()
    } catch (e) {
      addActivity({ module: 'wsl', action: `Backed up ${label}`, outcome: 'failure', detail: String(e) })
      setStatus({ type: 'error', text: String(e) })
    } finally {
      setBacking(false)
    }
  }

  const restore = async (entry: WslConfigBackup) => {
    setConfirmRestore(null)
    setStatus(null)
    try {
      const content = await backend.restoreBackup(entry.path)
      setText(content)
      setOriginal(content)
      setExists(true)
      addActivity({ module: 'wsl', action: `Restored ${label}`, outcome: 'success' })
      setStatus({ type: 'success', text: 'Restored. Restart WSL to apply changes.' })
    } catch (e) {
      addActivity({ module: 'wsl', action: `Restored ${label}`, outcome: 'failure', detail: String(e) })
      setStatus({ type: 'error', text: String(e) })
    }
  }

  const removeBackup = async (entry: WslConfigBackup) => {
    try { await backend.deleteBackup(entry.path); await loadBackups() }
    catch (e) { setStatus({ type: 'error', text: String(e) }) }
  }

  const restart = async () => {
    setConfirmRestart(false)
    setRestarting(true)
    setStatus(null)
    addTerminalLine('$ wsl --shutdown', 'cmd')
    try {
      await wslShutdown()
      addTerminalLine('  ✓ all distributions stopped', 'success')
      addActivity({ module: 'wsl', action: 'WSL shutdown', outcome: 'success' })
      setStatus({ type: 'success', text: 'WSL restarted — changes are now applied.' })
      onAfterShutdown()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      addActivity({ module: 'wsl', action: 'WSL shutdown', outcome: 'failure', detail: String(e) })
      setStatus({ type: 'error', text: String(e) })
    } finally {
      setRestarting(false)
    }
  }

  // ── Form layout: optionally split the first section into common/advanced ──
  const first = sections[0]
  const common = commonSplit ? first.fields.filter(f => f.common) : []
  const advanced = commonSplit ? first.fields.filter(f => !f.common) : []
  const restSections = commonSplit ? sections.slice(1) : sections
  const advancedCount = advanced.length + (commonSplit ? restSections.reduce((n, s) => n + s.fields.length, 0) : 0)
  const advancedSet = !commonSplit ? 0 : (
    advanced.filter(f => getIniValue(text, first.name, f.key) !== undefined).length +
    restSections.reduce((n, s) => n + s.fields.filter(f => getIniValue(text, s.name, f.key) !== undefined).length, 0)
  )

  if (loading) return <div className="empty-state" style={{ marginTop: 24 }}>Loading {label}…</div>

  return (
    <div className="wslcfg">
      <div className="wslcfg-bar">
        <button className="wsl-distro-path wslcfg-path" onClick={() => revealPath(path).catch(() => {})} title="Reveal in Explorer">
          <FolderOpen size={12} />
          <span className="wsl-distro-path-text">{path}</span>
        </button>
        {!exists && <span className="wslcfg-missing">File does not exist yet</span>}
      </div>

      <div className="wslcfg-toolbar">
        <div className="wslcfg-modes">
          <button className={mode === 'form' ? 'active' : ''} onClick={() => setMode('form')}>
            <ListChecks size={13} /> Form
          </button>
          <button className={mode === 'raw' ? 'active' : ''} onClick={() => setMode('raw')}>
            <FileCode2 size={13} /> Raw
          </button>
        </div>
        <button className="btn-secondary" onClick={backup} disabled={backing} title={`Snapshot the current ${label} (saves first)`}>
          <Archive size={13} /> {backing ? 'Backing up…' : 'Backup'}
        </button>
      </div>

      {mode === 'form' ? (
        <div className="wslcfg-form">
          {commonSplit ? (
            <>
              <div className="wslcfg-form-section">
                <p className="wslcfg-form-section-title">{first.title}</p>
                {grid(first.name, common)}
                <button className="wslcfg-advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
                  {showAdvanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {showAdvanced ? 'Hide advanced settings' : 'Show advanced settings'}
                  <span className="wslcfg-advanced-count">{advancedCount}</span>
                  {!showAdvanced && advancedSet > 0 && <span className="wslcfg-advanced-active">{advancedSet} set</span>}
                </button>
                {showAdvanced && grid(first.name, advanced)}
              </div>
              {showAdvanced && restSections.map(s => (
                <div key={s.name} className="wslcfg-form-section">
                  <p className="wslcfg-form-section-title">{s.title}</p>
                  {grid(s.name, s.fields)}
                </div>
              ))}
            </>
          ) : (
            sections.map(s => (
              <div key={s.name} className="wslcfg-form-section">
                <p className="wslcfg-form-section-title">{s.title}</p>
                {grid(s.name, s.fields)}
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          {!text && template && (
            <button className="btn-secondary wslcfg-template-btn" onClick={() => setText(template)}>
              <FilePlus size={13} /> Insert template
            </button>
          )}
          <textarea
            className="wslcfg-editor"
            value={text}
            onChange={e => { setText(e.target.value); setStatus(null) }}
            spellCheck={false}
            placeholder={`# ${label} is empty. Switch to Form or type settings here.`}
          />
        </>
      )}

      {status && <div className={`settings-status settings-status--${status.type}`}>{status.text}</div>}

      <div className="wslcfg-actions">
        <button className="btn-filled btn-filled--accent" onClick={save} disabled={!dirty || saving}>
          <Save size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-ghost" onClick={() => setText(original)} disabled={!dirty || saving}>
          <RotateCcw size={12} /> Reset
        </button>
        <button className="btn-secondary wslcfg-restart-btn" onClick={() => setConfirmRestart(true)} disabled={restarting}>
          <Power size={13} /> {restarting ? 'Restarting…' : 'Restart WSL to apply'}
        </button>
      </div>

      <p className="wslcfg-note">Saved changes only take effect after WSL restarts.</p>

      <div className="wslcfg-backups">
        <div className="wslcfg-backups-head">
          <History size={13} />
          <span>Backups</span>
          <span className="wslcfg-backups-count">{backups.length}</span>
        </div>
        {backups.length === 0 ? (
          <p className="wslcfg-backups-empty">No backups yet. Click Backup to snapshot the current config.</p>
        ) : (
          <ul className="wslcfg-backups-list">
            {backups.map(b => (
              <li key={b.path} className="wslcfg-backup-row">
                <span className="wslcfg-backup-date">{formatDate(b.created_at)}</span>
                <span className="wslcfg-backup-size">{bytesToHuman(b.size_bytes)}</span>
                <button className="wslcfg-backup-btn" onClick={() => setConfirmRestore(b)} title="Restore this backup">
                  <Undo2 size={12} /> Restore
                </button>
                <button className="wslcfg-backup-btn wslcfg-backup-del" onClick={() => removeBackup(b)} title="Delete this backup">
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmRestart && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap warning"><AlertTriangle size={16} /></div>
              <h2 className="modal-title">Restart WSL?</h2>
            </div>
            <p className="modal-body">
              <code>wsl --shutdown</code> stops every running distribution immediately.
              {runningNames.length > 0
                ? <> Currently running: <strong>{runningNames.join(', ')}</strong>. Unsaved work inside them will be lost.</>
                : ' No distributions appear to be running.'}
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmRestart(false)}>Cancel</button>
              <button className="btn-filled btn-filled--accent" onClick={restart}>Shut down WSL</button>
            </div>
          </div>
        </div>
      )}

      {confirmRestore && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap warning"><Undo2 size={16} /></div>
              <h2 className="modal-title">Restore backup?</h2>
            </div>
            <p className="modal-body">
              This overwrites your current <code>{label}</code> with the backup from{' '}
              <strong>{formatDate(confirmRestore.created_at)}</strong>. Any unsaved edits will be lost.
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmRestore(null)}>Cancel</button>
              <button className="btn-filled btn-filled--accent" onClick={() => restore(confirmRestore)}>Restore</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
