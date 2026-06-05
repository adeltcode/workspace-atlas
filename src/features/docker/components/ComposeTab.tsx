import { useEffect, useState, useMemo } from 'react'
import { listen } from '@tauri-apps/api/event'
import { revealItemInDir, openUrl } from '@tauri-apps/plugin-opener'
import {
  Download, AlertCircle, FolderOpen, Trash2, Monitor, Terminal,
  ChevronDown, Play, Square, RotateCcw, Wrench, FileKey, ExternalLink, ArrowLeft,
} from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { ComposeProject, ComposeBackupEntry, DockerContainer, ContainerStats, AppProjectMeta } from '../types'
import { bytesToHuman, formatDate } from '../../../utils/format'
import ComposePage from './ComposePage'

// ── .env parser ───────────────────────────────────────────────────────────────

function parseEnvPairs(content: string): Array<{ key: string; value: string }> {
  return content.split('\n')
    .filter(line => { const t = line.trim(); return t && !t.startsWith('#') })
    .map(line => {
      const eq = line.indexOf('=')
      if (eq === -1) return { key: line.trim(), value: '' }
      return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1) }
    })
}

// ── YAML syntax highlighter ───────────────────────────────────────────────────

// Matches: optional-ip:hostPort:containerPort[/proto]
const PORT_RE = /^(?:[\d.]+:)?(\d+):\d+(?:\/(?:tcp|udp))?$/

function renderYamlValue(
  raw: string,
  onOpenPort?: (port: string) => void,
  onRevealPath?: (path: string) => void,
): React.ReactNode {
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

  // Strip outer quotes for pattern matching
  const stripped = trimmed.replace(/^['"]|['"]$/g, '')

  // Clickable port mapping: "3000:3000", "127.0.0.1:8080:80/tcp"
  if (onOpenPort) {
    const pm = stripped.match(PORT_RE)
    if (pm) {
      return (
        <button className="yaml-port-link" onClick={() => onOpenPort(pm[1])}>
          <span className="yaml-string">{val}</span>
          <ExternalLink size={9} className="yaml-port-icon" />
        </button>
      )
    }
  }

  // Clickable relative volume path: ./app, ./app:/container
  if (onRevealPath && (stripped.startsWith('./') || stripped.startsWith('../'))) {
    const source = stripped.split(':')[0]
    return (
      <button className="yaml-path-link" onClick={() => onRevealPath(source)}>
        <span className="yaml-value">{val}</span>
        <FolderOpen size={9} className="yaml-path-icon" />
      </button>
    )
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

function YamlLine({
  line, onOpenPort, onRevealPath,
}: {
  line:          string
  onOpenPort?:   (port: string) => void
  onRevealPath?: (path: string) => void
}) {
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
        {rest ? <> {renderYamlValue(rest, onOpenPort, onRevealPath)}</> : null}
      </div>
    )
  }
  const lm = line.match(/^(\s*)(-)(\s+)(.*)$/)
  if (lm) {
    const [, pre, dash, sp, rest] = lm
    return (
      <div className="yaml-line">
        <span>{pre}</span><span className="yaml-dash">{dash}</span>
        <span>{sp}</span>{renderYamlValue(rest, onOpenPort, onRevealPath)}
      </div>
    )
  }
  return <div className="yaml-line">{line}</div>
}

function YamlViewer({
  content, onOpenPort, onRevealPath,
}: {
  content:       string
  onOpenPort?:   (port: string) => void
  onRevealPath?: (path: string) => void
}) {
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return (
    <div className="compose-code-wrap">
      <div className="compose-line-nums" aria-hidden>
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="compose-code-body">
        {lines.map((line, i) => (
          <YamlLine key={i} line={line} onOpenPort={onOpenPort} onRevealPath={onRevealPath} />
        ))}
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

// ── Compose lifecycle actions ─────────────────────────────────────────────────

const LIFECYCLE_ACTIONS = [
  { id: 'up',      Icon: Play,      label: 'Up',      title: 'docker compose up -d',         color: 'success' },
  { id: 'down',    Icon: Square,    label: 'Down',    title: 'docker compose down',           color: 'danger'  },
  { id: 'restart', Icon: RotateCcw, label: 'Restart', title: 'docker compose restart',       color: 'default' },
  { id: 'rebuild', Icon: Wrench,    label: 'Rebuild', title: 'docker compose up -d --build', color: 'warning' },
] as const

type LifecycleAction = typeof LIFECYCLE_ACTIONS[number]['id']

// ── Main component ────────────────────────────────────────────────────────────

interface ComposeTabProps {
  refreshTick?:   number
  containers:     DockerContainer[]
  containerStats: ContainerStats[]
  statHistory:    Map<string, { cpu: number[]; mem: number[] }>
}

export default function ComposeTab({
  refreshTick = 0, containers, containerStats, statHistory,
}: ComposeTabProps) {
  const backupDir = useAppStore(s => s.backupDir)

  // ── View mode: 'main' = overview page, 'project' = file detail ───────────
  const [viewMode, setViewMode] = useState<'main' | 'project'>('main')

  // ── Metadata ─────────────────────────────────────────────────────────────
  const [metadata, setMetadata] = useState<Record<string, AppProjectMeta>>({})

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

  // Lifecycle controls
  const [lifecycleRunning, setLifecycleRunning] = useState<LifecycleAction | null>(null)
  // For the main page: track which project + action is running
  const [cardLifecycle, setCardLifecycle] = useState<{ project: string; action: string } | null>(null)

  // .env viewer
  const [envOpen, setEnvOpen]       = useState(false)
  const [envContent, setEnvContent] = useState<string | null>(null)
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError]     = useState<string | null>(null)

  // ── Computed ──────────────────────────────────────────────────────────────

  const projectDir = useMemo(() => {
    if (!activeFile) return ''
    const i = Math.max(activeFile.lastIndexOf('/'), activeFile.lastIndexOf('\\'))
    return i >= 0 ? activeFile.slice(0, i) : ''
  }, [activeFile])

  const envFilePath = useMemo(() => {
    if (!projectDir) return ''
    const sep = activeFile.includes('/') ? '/' : '\\'
    return `${projectDir}${sep}.env`
  }, [projectDir, activeFile])

  // ── Load projects ─────────────────────────────────────────────────────────

  const loadProjects = async () => {
    setLoading(true); setError(null)
    try { setProjects(await api.dockerComposeLs()) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProjects() }, [refreshTick]) // eslint-disable-line

  // ── Load metadata once on mount ──────────────────────────────────────────

  useEffect(() => {
    api.metadataLoad().then(setMetadata).catch(() => {})
  }, [])

  // ── React to "go to overview" signal from sidebar ────────────────────────

  const composeShowOverview = useAppStore(s => s.composeShowOverview)

  useEffect(() => {
    if (!composeShowOverview) return
    useAppStore.getState().setComposeShowOverview(false)
    setViewMode('main')
    setSelected(null)
    useAppStore.getState().setComposeActiveProject(null)
  }, [composeShowOverview])

  // ── Sync compose project list to sidebar nav ─────────────────────────────

  useEffect(() => {
    useAppStore.getState().setComposeProjectsNav(
      projects.map(p => ({ name: p.name, status: p.status }))
    )
  }, [projects])

  // ── React to composePreselect from sidebar or overview panel ─────────────
  // Runs on initial project load AND whenever composePreselect changes so that
  // sidebar clicks work even when the compose tab is already mounted.

  const composePreselect = useAppStore(s => s.composePreselect)

  useEffect(() => {
    if (projects.length === 0) return
    if (composePreselect) {
      useAppStore.getState().setComposePreselect(null)
      const target = projects.find(p => p.name === composePreselect)
      if (target) { selectProject(target); setViewMode('project') }
      // Don't auto-select first project on initial load — show overview instead
    }
  }, [projects, composePreselect]) // eslint-disable-line

  // ── Project selection ─────────────────────────────────────────────────────

  const selectProject = (project: ComposeProject) => {
    setSelected(project)
    useAppStore.getState().setComposeActiveProject(project.name)
    setFileContent(null)
    setFileError(null)
    setBackupMsg(null)
    setEnvContent(null)
    setEnvError(null)
    setEnvOpen(false)
    const first = project.config_files[0] ?? ''
    setActiveFile(first)
    if (first) loadFile(first)
    if (backupDir) loadComposeBackups(project.name)
    // Record recent_opened in metadata
    const now = new Date().toISOString()
    const current = metadata[project.name] ?? { favorite: false, tags: [], note: '', active_env: null, recent_opened: null, startup_times: [] }
    const updated = { ...current, recent_opened: now }
    setMetadata(prev => ({ ...prev, [project.name]: updated }))
    api.metadataSaveProject(project.name, updated).catch(() => {})
  }

  const handleMetaChange = (name: string, meta: AppProjectMeta) => {
    setMetadata(prev => ({ ...prev, [name]: meta }))
    api.metadataSaveProject(name, meta).catch(() => {})
  }

  const loadFile = async (path: string) => {
    if (!path) return
    setFileLoading(true); setFileError(null); setFileContent(null)
    try { setFileContent(await api.readFileContent(path)) }
    catch (e) { setFileError(String(e)) }
    finally { setFileLoading(false) }
  }

  // ── .env loader ───────────────────────────────────────────────────────────

  const toggleEnv = async () => {
    if (envOpen) { setEnvOpen(false); return }
    setEnvOpen(true)
    if (envContent !== null || envLoading) return
    if (!envFilePath) return
    setEnvLoading(true); setEnvError(null)
    try { setEnvContent(await api.readFileContent(envFilePath)) }
    catch (e) {
      const msg = String(e).toLowerCase()
      // File-not-found is a normal case — show "no .env" message rather than an error
      if (msg.includes('not found') || msg.includes('cannot access') || msg.includes('no such file')) {
        setEnvContent('')
      } else {
        setEnvError(String(e))
      }
    }
    finally { setEnvLoading(false) }
  }

  // ── YAML callbacks ────────────────────────────────────────────────────────

  const handleOpenPort = (port: string) => {
    openUrl(`http://localhost:${port}`).catch(() => {})
  }

  const handleRevealPath = (rel: string) => {
    if (!projectDir) return
    const sep = activeFile.includes('/') ? '/' : '\\'
    const abs = `${projectDir}${sep}${rel.replace(/^\.\//, '').replace(/^\.\.\//, '../')}`
    revealItemInDir(abs).catch(() => {})
  }

  // ── Lifecycle controls ────────────────────────────────────────────────────

  const runComposeAction = async (action: LifecycleAction) => {
    if (!activeFile || lifecycleRunning) return
    setLifecycleRunning(action)
    const { addTerminalLine, setTerminalOpen } = useAppStore.getState()
    setTerminalOpen(true)
    const actionDef = LIFECYCLE_ACTIONS.find(a => a.id === action)!
    addTerminalLine(`─── ${actionDef.title} ───`, 'info')

    const unlistenLog = await listen<string>('docker-log', e => {
      const type = e.payload.startsWith('$') ? 'cmd'
        : e.payload.startsWith('[err]') ? 'stderr'
        : 'stdout'
      useAppStore.getState().addTerminalLine(e.payload, type)
    })

    try {
      await api.dockerComposeAction(activeFile, action)
      useAppStore.getState().addTerminalLine('─── Done ───', 'success')
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlistenLog()
      setLifecycleRunning(null)
      // Refresh project list to reflect updated status
      loadProjects().then(() => {
        if (selected) {
          setProjects(prev => {
            const updated = prev.find(p => p.name === selected.name)
            if (updated) setSelected(updated)
            return prev
          })
        }
      })
    }
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
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally { setDeletingFile(null) }
  }

  const fileBackups = composeBackups.filter(e => !activeFile || e.original_path === activeFile)

  // ── Backup ────────────────────────────────────────────────────────────────

  const runBackup = async () => {
    if (!selected || !backupDir) return
    setBackingUp(true)
    setBackupMsg(null)
    const { addTerminalLine } = useAppStore.getState()
    try {
      const saved = await api.dockerBackupCompose(selected.name, selected.config_files, backupDir)
      if (saved.length === 0) {
        addTerminalLine(`  → already up to date`, 'info')
        setBackupMsg({ type: 'info', text: 'Already up to date — no changes to back up' })
      } else {
        setBackupMsg({ type: 'success', text: `${saved.length} file${saved.length !== 1 ? 's' : ''} backed up` })
        await loadComposeBackups(selected.name)
      }
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setBackupMsg({ type: 'error', text: String(e) })
    } finally { setBackingUp(false) }
  }

  // ── Card-level lifecycle (from main page cards) ──────────────────────────

  const runCardLifecycle = async (project: ComposeProject, action: 'up' | 'down' | 'restart') => {
    if (cardLifecycle) return
    setCardLifecycle({ project: project.name, action })
    const { addTerminalLine, setTerminalOpen } = useAppStore.getState()
    setTerminalOpen(true)
    const actionMap = { up: 'docker compose up -d', down: 'docker compose down', restart: 'docker compose restart' }
    addTerminalLine(`─── ${actionMap[action]} (${project.name}) ───`, 'info')
    const configFile = project.config_files[0] ?? ''

    const unlistenLog = await listen<string>('docker-log', e => {
      const type = e.payload.startsWith('$') ? 'cmd'
        : e.payload.startsWith('[err]') ? 'stderr'
        : 'stdout'
      useAppStore.getState().addTerminalLine(e.payload, type)
    })

    try {
      await api.dockerComposeAction(configFile, action)
      useAppStore.getState().addTerminalLine('─── Done ───', 'success')
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlistenLog()
      setCardLifecycle(null)
      loadProjects()
    }
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

      {/* ── Main overview page ───────────────────────────────────────────── */}
      {viewMode === 'main' && !loading && (
        <ComposePage
          projects={projects}
          containers={containers}
          containerStats={containerStats}
          statHistory={statHistory}
          metadata={metadata}
          onMetaChange={handleMetaChange}
          onSelectProject={p => { selectProject(p); setViewMode('project') }}
          onLifecycle={runCardLifecycle}
          lifecycleRunning={cardLifecycle}
        />
      )}
      {viewMode === 'main' && loading && (
        <div className="compose-viewer-placeholder">
          <span className="compose-placeholder-text">Loading projects…</span>
        </div>
      )}

      {/* ── Project detail view ───────────────────────────────────────────── */}
      {viewMode === 'project' && selected && (
        <div className="compose-viewer">

          {/* ── Toolbar row ─────────────────────────────────────────────── */}
          <div className="compose-viewer-toolbar">

            {/* Back to overview */}
            <button
              className="compose-back-btn"
              onClick={() => {
                setViewMode('main')
                useAppStore.getState().setComposeActiveProject(null)
              }}
              title="Back to all projects"
            >
              <ArrowLeft size={12} />
              <span className="compose-back-label">{selected.name}</span>
            </button>

            {/* File selector */}
            <div className="compose-file-tabs">
              {selected.config_files.map(f => (
                <button
                  key={f}
                  className={clsx('compose-file-path-item', activeFile === f && 'active')}
                  onClick={() => { setActiveFile(f); loadFile(f); setBackupMsg(null); setEnvContent(null); setEnvOpen(false) }}
                  title={f}
                >
                  <PathOriginLine path={f} />
                  <span className="compose-file-path-text">{f}</span>
                </button>
              ))}
            </div>

            {/* Lifecycle action buttons */}
            <div className="compose-lifecycle-btns">
              {LIFECYCLE_ACTIONS.map(({ id, Icon, label, title, color }) => (
                <button
                  key={id}
                  className={clsx('compose-lifecycle-btn', `compose-lifecycle-btn--${color}`, lifecycleRunning === id && 'loading')}
                  onClick={() => runComposeAction(id)}
                  disabled={!!lifecycleRunning || !activeFile}
                  title={title}
                >
                  <Icon size={11} className={lifecycleRunning === id ? 'spin' : ''} />
                  {label}
                </button>
              ))}
            </div>

            {/* Status + Backup + .env toggles */}
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
              <button
                className={clsx('compose-env-toggle-btn', envOpen && 'active')}
                onClick={toggleEnv}
                disabled={!envFilePath}
                title={envFilePath ? `Toggle .env viewer (${envFilePath})` : 'No active file'}
              >
                <FileKey size={12} />
                .env
                <ChevronDown size={10} className={clsx('compose-backup-toggle-chevron', envOpen && 'open')} />
              </button>
            </div>
          </div>

          {/* ── Backup accordion ─────────────────────────────────────────── */}
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

          {/* ── .env accordion ───────────────────────────────────────────── */}
          <div className={clsx('compose-accordion-wrap', envOpen && 'open')}>
            <div className="compose-env-accordion">
              {envLoading && <p className="compose-backup-empty">Loading .env…</p>}
              {envError  && <p className="compose-backup-empty compose-backup-empty--error">{envError}</p>}
              {!envLoading && !envError && envContent === '' && (
                <p className="compose-backup-empty">No .env file found in this project directory.</p>
              )}
              {!envLoading && !envError && envContent && (() => {
                const pairs = parseEnvPairs(envContent)
                return (
                  <table className="env-table">
                    <thead>
                      <tr>
                        <th className="env-th">Variable</th>
                        <th className="env-th">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.map(({ key, value }) => (
                        <tr key={key} className="env-row">
                          <td className="env-key">{key}</td>
                          <td className="env-val">{value || <span className="env-empty">(empty)</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              })()}
            </div>
          </div>

          {/* ── File content ─────────────────────────────────────────────── */}
          <div className="compose-viewer-body">
            {fileLoading && <div className="compose-viewer-state">Loading file…</div>}
            {fileError && (
              <div className="compose-viewer-state compose-viewer-error">
                <AlertCircle size={14} />{fileError}
              </div>
            )}
            {!fileLoading && fileContent !== null && (
              <YamlViewer
                content={fileContent}
                onOpenPort={handleOpenPort}
                onRevealPath={handleRevealPath}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
