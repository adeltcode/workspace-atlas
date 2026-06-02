import { useEffect, useRef, useState } from 'react'
import { FileText, Download, AlertCircle, FolderOpen, ChevronRight, Trash2, Clock } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { ComposeProject, ComposeBackupEntry } from '../types'

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const filename = (path: string) => path.split(/[\\/]/).pop() ?? path

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

/** running: all services running; partial: some running; stopped: none running */
function statusLabel(raw: string): { text: string; dot: 'running' | 'partial' | 'stopped' } {
  const parts = parseComposeStatus(raw)
  if (!parts.length) return { text: raw || 'unknown', dot: 'stopped' }

  const total   = parts.reduce((s, p) => s + p.count, 0)
  const running = parts.find(p => p.state === 'running')?.count ?? 0

  // Human-readable: "2 running, 1 exited"
  const segments = parts.map(p => `${p.count} ${p.state}`)
  const text = segments.join(', ')

  const dot = running === 0 ? 'stopped'
    : running === total     ? 'running'
    :                         'partial'

  return { text, dot }
}

function bytesToHuman(b: number) {
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`
  return `${b} B`
}

function formatDate(ts: number) {
  const d   = new Date(ts * 1000)
  const now = new Date()
  const t   = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today ${t}`
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Main component ────────────────────────────────────────────────────────────

const MIN_SIDEBAR = 140
const MAX_SIDEBAR = 480

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
  const [backingUp, setBackingUp]         = useState(false)
  const [backupMsg, setBackupMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  // Backup history
  const [composeBackups, setComposeBackups]   = useState<ComposeBackupEntry[]>([])
  const [deletingFile, setDeletingFile]       = useState<string | null>(null)

  // Sidebar resize — null = auto/max-content, number = user-set px
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null)
  const sidebarRef  = useRef<HTMLDivElement>(null)
  const isDragging  = useRef(false)
  const dragStartX  = useRef(0)
  const dragStartW  = useRef(0)

  // ── Load projects ─────────────────────────────────────────────

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

  // ── Project selection ─────────────────────────────────────────

  const selectProject = (project: ComposeProject) => {
    setSelected(project)
    setBackupMsg(null)
    setFileContent(null)
    setFileError(null)
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

  // ── Backup history ────────────────────────────────────────────

  const loadComposeBackups = async (projectName: string) => {
    if (!backupDir) { setComposeBackups([]); return }
    try {
      const entries = await api.dockerListComposeBackups(backupDir, projectName)
      setComposeBackups(entries)
    } catch { setComposeBackups([]) }
  }

  const handleBackup = async () => {
    if (!selected || !backupDir) return
    setBackingUp(true); setBackupMsg(null)
    try {
      const saved = await api.dockerBackupCompose(selected.name, selected.config_files, backupDir)
      if (saved.length === 0) {
        setBackupMsg({ ok: true, text: 'No changes — backup is up to date' })
      } else {
        setBackupMsg({ ok: true, text: `${saved.length} file${saved.length !== 1 ? 's' : ''} backed up` })
        await loadComposeBackups(selected.name)
      }
    } catch (e) {
      setBackupMsg({ ok: false, text: `Backup failed: ${String(e)}` })
    } finally { setBackingUp(false) }
  }

  const handleDeleteBackup = async (entry: ComposeBackupEntry) => {
    if (!backupDir) return
    setDeletingFile(entry.filename)
    try {
      await api.dockerDeleteComposeBackup(backupDir, entry.filename)
      setComposeBackups(prev => prev.filter(b => b.filename !== entry.filename))
    } catch (e) {
      setBackupMsg({ ok: false, text: `Delete failed: ${String(e)}` })
    } finally { setDeletingFile(null) }
  }

  // ── Drag-to-resize sidebar ────────────────────────────────────

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    // Capture actual rendered width (works whether we're in max-content or fixed-px mode)
    const actualW = sidebarRef.current?.offsetWidth ?? MIN_SIDEBAR
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartW.current = actualW

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const delta = ev.clientX - dragStartX.current
      setSidebarWidth(Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, dragStartW.current + delta)))
    }
    const onUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Backup history filtered to active file ────────────────────

  const fileBackups = composeBackups.filter(e =>
    !activeFile || e.original_path === activeFile
  )

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="compose-tab">
      <div className="compose-header">
        <span className="compose-header-title">Compose Projects</span>
      </div>

      {error && (
        <div className="error-banner">
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      <div
        className="compose-layout"
        style={{
          gridTemplateColumns: `${sidebarWidth !== null ? `${sidebarWidth}px` : 'max-content'} 5px 1fr`
        }}
      >
        {/* ── Left: project sidebar ─────────────────────────── */}
        <div className="compose-sidebar" ref={sidebarRef}>
          {loading && <p className="compose-empty">Loading…</p>}
          {!loading && projects.length === 0 && !error && (
            <p className="compose-empty">
              No compose projects found.<br />
              Run <code>docker compose up</code> to get started.
            </p>
          )}
          <ul className="compose-project-list">
            {projects.map(p => {
              const { text: stText, dot } = statusLabel(p.status)
              const isActive = selected?.name === p.name
              return (
                <li key={p.name}>
                  <button
                    className={clsx('compose-project-row', isActive && 'active')}
                    onClick={() => selectProject(p)}
                  >
                    <span className={clsx('compose-status-dot', dot)} />
                    <div className="compose-project-info">
                      <span className="compose-project-name">{p.name}</span>
                      <span className="compose-project-status">{stText}</span>
                    </div>
                    <ChevronRight size={13} className={clsx('compose-chevron', isActive && 'active')} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* ── Resize handle ─────────────────────────────────── */}
        <div className="compose-resize-handle" onMouseDown={handleResizeStart} />

        {/* ── Right: file viewer ────────────────────────────── */}
        {selected ? (
          <div className="compose-viewer">

            {/* Toolbar */}
            <div className="compose-viewer-toolbar">
              <div className="compose-file-tabs">
                {selected.config_files.map(f => (
                  <button
                    key={f}
                    className={clsx('compose-file-tab', activeFile === f && 'active')}
                    onClick={() => { setActiveFile(f); loadFile(f) }}
                  >
                    <FileText size={11} />
                    {filename(f)}
                  </button>
                ))}
              </div>
              <div className="compose-viewer-actions">
                {backupMsg && (
                  <span className={clsx('compose-backup-msg', backupMsg.ok ? 'ok' : 'error')}>
                    {backupMsg.text}
                  </span>
                )}
                <button
                  className="btn-refresh"
                  onClick={handleBackup}
                  disabled={backingUp || !backupDir}
                  title={!backupDir
                    ? 'Set a backup directory in the Backup tab first'
                    : `Backup config files for '${selected.name}'`}
                >
                  <Download size={12} className={backingUp ? 'spin' : ''} />
                  {backingUp ? 'Backing up…' : 'Backup files'}
                </button>
              </div>
            </div>

            {/* Path breadcrumb */}
            <div className="compose-breadcrumb">
              <FolderOpen size={11} className="compose-breadcrumb-icon" />
              <span className="compose-breadcrumb-path" title={activeFile}>{activeFile}</span>
            </div>

            {/* File content */}
            <div className="compose-viewer-body">
              {fileLoading && <div className="compose-viewer-state">Loading file…</div>}
              {fileError && (
                <div className="compose-viewer-state compose-viewer-error">
                  <AlertCircle size={14} />{fileError}
                </div>
              )}
              {!fileLoading && fileContent !== null && <YamlViewer content={fileContent} />}
            </div>

            {/* Backup history */}
            {fileBackups.length > 0 && (
              <div className="compose-history">
                <div className="compose-history-header">
                  <Clock size={12} className="compose-history-icon" />
                  <span className="compose-history-title">Backup History</span>
                  <span className="compose-history-count">
                    {fileBackups.length} / 10
                  </span>
                </div>
                <ul className="compose-history-list">
                  {fileBackups.map(entry => (
                    <li key={entry.filename} className="compose-history-item">
                      <div className="compose-history-info">
                        <span className="compose-history-date">{formatDate(entry.created_at)}</span>
                        <span className="compose-history-size">{bytesToHuman(entry.size_bytes)}</span>
                      </div>
                      <span className="compose-history-file" title={entry.filename}>
                        {entry.filename}
                      </span>
                      <button
                        className="ctr-action-btn ctr-action-stop"
                        onClick={() => handleDeleteBackup(entry)}
                        disabled={deletingFile === entry.filename}
                        title="Delete this backup"
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="compose-viewer-placeholder">
            <FileText size={32} className="compose-placeholder-icon" />
            <span className="compose-placeholder-text">Select a project to view its configuration</span>
          </div>
        )}
      </div>
    </div>
  )
}
