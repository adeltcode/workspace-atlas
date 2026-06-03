import { useEffect, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { FileText, Download, AlertCircle, FolderOpen, Trash2, Monitor, Terminal, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { ComposeProject, ComposeBackupEntry } from '../types'
import { bytesToHuman, formatDate } from '../../../utils/format'

// ── YAML syntax highlighter ───────────────────────────────────────────────────

function renderYamlValue(raw: string): React.ReactNode {
  if (!raw) return null
  const val     = raw.trimEnd()
  const trimmed = val.trimStart()
  if (!trimmed) return <span>{val}</span>

  const ci = trimmed.search(/ #/)
  if (ci > -1) {
    const v = val.slice(0, val.length - trimmed.length + ci)
    const c = val.slice(val.length - trimmed.length + ci)
    return <><span className="yaml-value">{v}</span><span className="yaml-comment">{c}</span></>
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'"))
    return <span className="yaml-string">{val}</span>
  if (/^(true|false|null|yes|no|on|off)$/i.test(trimmed))
    return <span className="yaml-bool">{val}</span>
  if (/^-?\d+(\.\d+)?$/.test(trimmed))
    return <span className="yaml-number">{val}</span>
  if (trimmed.includes('$')) {
    const parts = val.split(/(\$\{[^}]+\}|\$[A-Z_a-z][A-Z0-9_a-z]*)/g)
    return <>{parts.map((p, i) => p.startsWith('$')
      ? <span key={i} className="yaml-env">{p}</span>
      : <span key={i}>{p}</span>)}</>
  }
  return <span className="yaml-value">{val}</span>
}

function YamlLine({ line }: { line: string }) {
  const trimmed = line.trimStart()
  const indent  = line.length - trimmed.length
  if (!trimmed) return <div className="yaml-line">&nbsp;</div>
  if (trimmed.startsWith('#'))
    return <div className="yaml-line"><span className="yaml-comment">{line}</span></div>
  const km = line.match(/^(\s*)([\w.\-/]+)(\s*:)(.*)$/)
  if (km) {
    const [, pre, key, colon, rest] = km
    const depth = Math.floor(indent / 2)
    return (
      <div className="yaml-line">
        <span>{pre}</span>
        <span className={depth === 0 ? 'yaml-key-root' : 'yaml-key'}>{key}</span>
        <span className="yaml-colon">{colon}</span>
        {rest ? <> {renderYamlValue(rest)}</> : null}
      </div>
    )
  }
  const lm = line.match(/^(\s*)(-)(\s+)(.*)$/)
  if (lm) {
    const [, pre, dash, sp, rest] = lm
    return (
      <div className="yaml-line">
        <span>{pre}</span><span className="yaml-dash">{dash}</span>
        <span>{sp}</span>{renderYamlValue(rest)}
      </div>
    )
  }
  return <div className="yaml-line">{line}</div>
}

function YamlViewer({ content }: { content: string }) {
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return (
    <div className="compose-code-wrap">
      <div className="compose-line-nums" aria-hidden>
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="compose-code-body">
        {lines.map((line, i) => <YamlLine key={i} line={line} />)}
      </div>
    </div>
  )
}

// ── Path origin detection ─────────────────────────────────────────────────────

type PathOrigin = 'windows' | 'wsl-mount' | 'wsl'

function detectOrigin(path: string): PathOrigin {
  if (/^[A-Za-z]:[/\\]/.test(path)) return 'windows'
  if (/^\/mnt\/[a-z]\//i.test(path))  return 'wsl-mount'
  return 'wsl'
}

function PathOriginLine({ path }: { path: string }) {
  const origin = detectOrigin(path)
  const isWin  = origin === 'windows'
  return (
    <>
      <span className={clsx('path-origin-icon', isWin ? 'path-origin-win' : 'path-origin-wsl')}>
        {isWin ? <Monitor size={11} /> : <Terminal size={11} />}
      </span>
      <span className="compose-breadcrumb-label">
        {isWin ? 'Windows' : origin === 'wsl-mount' ? 'WSL mount' : 'WSL'}
      </span>
    </>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────


interface ServiceState { state: string; count: number }

function parseComposeStatus(raw: string): ServiceState[] {
  return raw.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const m = part.match(/^(\w+)\((\d+)\)$/)
      return m ? { state: m[1], count: parseInt(m[2], 10) } : { state: part, count: 1 }
    })
}

function statusLabel(raw: string): { text: string; dot: 'running' | 'partial' | 'stopped' } {
  const parts = parseComposeStatus(raw)
  if (!parts.length) return { text: raw || 'unknown', dot: 'stopped' }

  const total   = parts.reduce((s, p) => s + p.count, 0)
  const running = parts.find(p => p.state === 'running')?.count ?? 0
  const text    = parts.map(p => `${p.count} ${p.state}`).join(', ')

  const dot = running === 0 ? 'stopped'
    : running === total     ? 'running'
    :                         'partial'

  return { text, dot }
}


// ── Main component ────────────────────────────────────────────────────────────

export default function ComposeTab({ refreshTick = 0 }: { refreshTick?: number }) {
  const backupDir = useAppStore(s => s.backupDir)

  const [projects, setProjects]           = useState<ComposeProject[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [selected, setSelected]           = useState<ComposeProject | null>(null)
  const [activeFile, setActiveFile]       = useState('')
  const [fileContent, setFileContent]     = useState<string | null>(null)
  const [fileLoading, setFileLoading]     = useState(false)
  const [fileError, setFileError]         = useState<string | null>(null)
  const [composeBackups, setComposeBackups] = useState<ComposeBackupEntry[]>([])
  const [deletingFile, setDeletingFile]     = useState<string | null>(null)
  const [backupOpen, setBackupOpen]         = useState(false)
  const [backingUp, setBackingUp]           = useState(false)
  const [backupMsg, setBackupMsg]           = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  // ── Load projects ─────────────────────────────────────────────────────────

  const loadProjects = async () => {
    setLoading(true); setError(null)
    try { setProjects(await api.dockerComposeLs()) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProjects() }, [refreshTick]) // eslint-disable-line

  // Auto-open the first project once loaded
  useEffect(() => {
    if (projects.length > 0 && !selected) selectProject(projects[0])
  }, [projects]) // eslint-disable-line

  // ── Project selection ─────────────────────────────────────────────────────

  const selectProject = (project: ComposeProject) => {
    setSelected(project)
    setFileContent(null)
    setFileError(null)
    setBackupMsg(null)
    const first = project.config_files[0] ?? ''
    setActiveFile(first)
    if (first) loadFile(first)
    if (backupDir) loadComposeBackups(project.name)
  }

  const loadFile = async (path: string) => {
    if (!path) return
    setFileLoading(true); setFileError(null); setFileContent(null)
    try { setFileContent(await api.readFileContent(path)) }
    catch (e) { setFileError(String(e)) }
    finally { setFileLoading(false) }
  }

  // ── Backup history ────────────────────────────────────────────────────────

  const loadComposeBackups = async (projectName: string) => {
    if (!backupDir) { setComposeBackups([]); return }
    try {
      setComposeBackups(await api.dockerListComposeBackups(backupDir, projectName))
    } catch { setComposeBackups([]) }
  }

  const handleDeleteBackup = async (entry: ComposeBackupEntry) => {
    if (!backupDir) return
    setDeletingFile(entry.filename)
    try {
      await api.dockerDeleteComposeBackup(backupDir, entry.filename)
      setComposeBackups(prev => prev.filter(b => b.filename !== entry.filename))
    } catch {
      // silent — backup history panel will just stay unchanged
    } finally { setDeletingFile(null) }
  }

  const fileBackups = composeBackups.filter(e => !activeFile || e.original_path === activeFile)

  // ── Backup ────────────────────────────────────────────────────────────────

  const runBackup = async () => {
    if (!selected || !backupDir) return
    setBackingUp(true)
    setBackupMsg(null)
    try {
      const saved = await api.dockerBackupCompose(selected.name, selected.config_files, backupDir)
      if (saved.length === 0) {
        setBackupMsg({ type: 'info', text: 'Already up to date — no changes to back up' })
      } else {
        setBackupMsg({ type: 'success', text: `${saved.length} file${saved.length !== 1 ? 's' : ''} backed up` })
        await loadComposeBackups(selected.name)
      }
    } catch (e) {
      setBackupMsg({ type: 'error', text: String(e) })
    } finally { setBackingUp(false) }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="compose-tab">
      {error && (
        <div className="error-banner" style={{ margin: '0 32px 12px' }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {/* ── Horizontal project tab bar ─────────────────────────────────── */}
      <div className="compose-project-tabs-bar">
        {loading && <span className="compose-tabs-state">Loading…</span>}
        {!loading && projects.length === 0 && !error && (
          <span className="compose-tabs-state">
            No compose projects found — run <code>docker compose up</code> to get started.
          </span>
        )}
        {projects.map(p => {
          const { text: stText, dot } = statusLabel(p.status)
          const isActive = selected?.name === p.name
          return (
            <button
              key={p.name}
              className={clsx('compose-project-tab', isActive && 'active')}
              onClick={() => selectProject(p)}
              title={`${p.name} — ${stText}`}
            >
              <span className={clsx('compose-status-dot', dot)} />
              <span className="compose-tab-name">{p.name}</span>
            </button>
          )
        })}
      </div>

      {/* ── File viewer ────────────────────────────────────────────────── */}
      {selected ? (
        <div className="compose-viewer">

          {/* ── Toolbar: path selector on left (replaces redundant file tabs) ── */}
          <div className="compose-viewer-toolbar">

            {/* File selector — plain path display, one per config file */}
            <div className="compose-file-tabs">
              {selected.config_files.map(f => (
                <button
                  key={f}
                  className={clsx('compose-file-path-item', activeFile === f && 'active')}
                  onClick={() => { setActiveFile(f); loadFile(f); setBackupMsg(null) }}
                  title={f}
                >
                  <PathOriginLine path={f} />
                  <span className="compose-file-path-text">{f}</span>
                </button>
              ))}
            </div>

            {/* Status + Run Backup — inline in toolbar, no extra row */}
            <div className="compose-viewer-actions">
              {backupOpen && (
                <>
                  {backupMsg && (
                    <span className={clsx('compose-toolbar-status', backupMsg.type)}>
                      {backupMsg.text}
                    </span>
                  )}
                  <button
                    className="compose-run-backup-btn"
                    onClick={runBackup}
                    disabled={backingUp || !backupDir || !selected}
                    title={!backupDir ? 'Configure a backup directory in Settings first' : `Back up all files for '${selected?.name}'`}
                  >
                    <Download size={11} className={backingUp ? 'spin' : ''} />
                    {backingUp ? 'Backing up…' : 'Run Backup'}
                  </button>
                </>
              )}
              <button
                className={clsx('compose-backup-toggle-btn', backupOpen && 'active')}
                onClick={() => setBackupOpen(o => !o)}
                title={fileBackups.length > 0 ? `${fileBackups.length} backup${fileBackups.length !== 1 ? 's' : ''} — click to manage` : 'Backup history and controls'}
              >
                <Download size={12} />
                Backup
                {fileBackups.length > 0 && (
                  <span className="compose-backup-btn-count">{fileBackups.length}</span>
                )}
                <ChevronDown size={10} className={clsx('compose-backup-toggle-chevron', backupOpen && 'open')} />
              </button>
            </div>
          </div>

          {/* ── Backup list — no head row, just entries ──────────────── */}
          <div className={clsx('compose-accordion-wrap', backupOpen && 'open')}>
            <div className="compose-backup-accordion">
              {fileBackups.length === 0 ? (
                <p className="compose-backup-empty">No backups yet for this file.</p>
              ) : (
                <ul className="compose-backup-list">
                  {fileBackups.map(entry => (
                    <li key={entry.filename} className="compose-backup-entry">
                      <span className="compose-backup-entry-date">{formatDate(entry.created_at)}</span>
                      <span className="compose-backup-entry-size">{bytesToHuman(entry.size_bytes)}</span>
                      <span className="compose-backup-entry-file" title={entry.filename}>{entry.filename}</span>
                      <div className="compose-backup-entry-actions">
                        <button className="ctr-action-btn" onClick={() => revealItemInDir(entry.path).catch(() => {})} title="Open file location">
                          <FolderOpen size={12} />
                        </button>
                        <button className="ctr-action-btn ctr-action-remove" onClick={() => handleDeleteBackup(entry)}
                          disabled={deletingFile === entry.filename} title="Delete this backup">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── File content ─────────────────────────────────────────── */}
          <div className="compose-viewer-body">
            {fileLoading && <div className="compose-viewer-state">Loading file…</div>}
            {fileError && (
              <div className="compose-viewer-state compose-viewer-error">
                <AlertCircle size={14} />{fileError}
              </div>
            )}
            {!fileLoading && fileContent !== null && <YamlViewer content={fileContent} />}
          </div>
        </div>
      ) : (
        <div className="compose-viewer-placeholder">
          <FileText size={32} className="compose-placeholder-icon" />
          <span className="compose-placeholder-text">Select a project to view its configuration</span>
        </div>
      )}
    </div>
  )
}
