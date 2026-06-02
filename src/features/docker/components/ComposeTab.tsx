import { useEffect, useState } from 'react'
import { FileText, Download, AlertCircle, FolderOpen, Trash2, Clock, Monitor, Terminal, ArrowRight } from 'lucide-react'
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

export default function ComposeTab({ refreshTick = 0 }: { refreshTick?: number }) {
  const backupDir    = useAppStore(s => s.backupDir)
  const setDockerTab = useAppStore(s => s.setDockerTab)

  const [projects, setProjects]           = useState<ComposeProject[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [selected, setSelected]           = useState<ComposeProject | null>(null)
  const [activeFile, setActiveFile]       = useState('')
  const [fileContent, setFileContent]     = useState<string | null>(null)
  const [fileLoading, setFileLoading]     = useState(false)
  const [fileError, setFileError]         = useState<string | null>(null)
  // Backup history (read-only view — management happens in Backup tab)
  const [composeBackups, setComposeBackups] = useState<ComposeBackupEntry[]>([])
  const [deletingFile, setDeletingFile]     = useState<string | null>(null)

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

  // ── Render ────────────────────────────────────────────────────────────────

  const goToBackup = () => {
    setDockerTab('backup-compose')
  }

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

          {/* Toolbar: file tabs + actions */}
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
              <button
                className="btn-refresh"
                onClick={goToBackup}
                title="Manage backups in the Backup tab"
              >
                <Download size={12} />
                Backups
                <ArrowRight size={11} />
              </button>
            </div>
          </div>

          {/* Path breadcrumb with origin */}
          <div className="compose-breadcrumb">
            <PathOriginLine path={activeFile} />
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
                <span className="compose-history-count">{fileBackups.length} / 10</span>
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
  )
}
