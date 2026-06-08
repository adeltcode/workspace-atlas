import { useEffect, useState, useMemo } from 'react'
import { listen } from '@tauri-apps/api/event'
import { revealItemInDir, openUrl } from '@tauri-apps/plugin-opener'
import {
  Download, AlertCircle, FolderOpen, Trash2, Monitor, Terminal,
  ChevronDown, Play, Square, RotateCcw, Wrench, FileKey, ExternalLink, ArrowLeft,
  Pencil, Save, X, Info, RotateCcw as RestartIcon,
  ExternalLink as OpenIdeIcon, CheckCircle, MoreHorizontal, FileCode2, ScrollText,
} from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { useAppStore } from '../../../store/appStore'
import type { ComposeProject, ComposeBackupEntry, DockerContainer, ContainerStats, AppProjectMeta, DetectedFile, EditorInfo } from '../types'
import { bytesToHuman, formatDate } from '../../../utils/format'
import ComposePage from './ComposePage'
import ComposeEnvTab from './ComposeEnvTab'
import ComposeDockerfileViewer from './ComposeDockerfileViewer'
import ComposeLogPanel from './ComposeLogPanel'

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

// ── Service table ─────────────────────────────────────────────────────────────

// ── Inspect drawer ────────────────────────────────────────────────────────────

function InspectDrawer({ container, onClose }: { container: DockerContainer; onClose: () => void }) {
  const portRe = /:(\d+)->/g
  const hostPorts: string[] = []
  let m: RegExpExecArray | null
  while ((m = portRe.exec(container.ports)) !== null) {
    if (m[1] !== '0') hostPorts.push(m[1])
  }

  return (
    <div className="compose-inspect-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="compose-inspect-drawer">
        <div className="compose-inspect-header">
          <span className="compose-inspect-title">
            {container.compose_service ?? container.name}
          </span>
          <button className="compose-inspect-close" onClick={onClose}><X size={13} /></button>
        </div>
        <dl className="compose-inspect-dl">
          <dt>Image</dt>
          <dd title={container.image}>{container.image}</dd>
          <dt>State</dt>
          <dd className={clsx(
            container.state === 'running'    ? 'inspect-state--running'
            : container.state === 'restarting' ? 'inspect-state--restarting'
            : 'inspect-state--stopped'
          )}>{container.state}</dd>
          <dt>Status</dt>
          <dd>{container.status}</dd>
          {hostPorts.length > 0 && <>
            <dt>Host ports</dt>
            <dd>{hostPorts.map(p => `:${p}`).join('  ')}</dd>
          </>}
          <dt>Container</dt>
          <dd title={container.name}>{container.name}</dd>
          <dt>Running for</dt>
          <dd>{container.created_since}</dd>
        </dl>
      </div>
    </div>
  )
}

// ── Wipe confirmation modal ───────────────────────────────────────────────────

function WipeConfirmModal({ projectName, onConfirm, onCancel, running }: {
  projectName: string; onConfirm: () => void; onCancel: () => void; running: boolean
}) {
  return (
    <div className="compose-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="compose-modal-box">
        <h3 className="compose-modal-title">Wipe volumes for "{projectName}"?</h3>
        <p className="compose-modal-body">
          This permanently deletes all named volumes for this project — including database
          data — and runs <code>docker compose down -v</code>. This cannot be undone.
        </p>
        <div className="compose-modal-actions">
          <button className="btn-refresh" onClick={onCancel} disabled={running}>Cancel</button>
          <button
            className="compose-modal-btn-danger"
            onClick={onConfirm}
            disabled={running}
          >
            {running ? <RotateCcw size={11} className="spin" /> : <Trash2 size={11} />}
            {running ? 'Running…' : 'Wipe & Down'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Service cards (sidebar, replaces table in project view) ───────────────────

interface ServiceCardsProps {
  containers:      DockerContainer[]
  serviceAction:   { service: string; action: string } | null
  onServiceAction: (service: string, action: 'up' | 'stop' | 'restart') => void
  onOpenLogs:      (service: string) => void
  onShell:         (containerName: string) => void
  onInspect:       (container: DockerContainer) => void
}

function ServiceCards({ containers, serviceAction, onServiceAction, onOpenLogs, onShell, onInspect }: ServiceCardsProps) {
  if (containers.length === 0) return null
  return (
    <div className="csc-list">
      {containers.map(c => {
        const svc       = c.compose_service ?? c.name
        const isRunning = c.state === 'running'
        const isBusy    = serviceAction?.service === svc
        const stateKey  = isRunning ? 'running' : c.state === 'restarting' ? 'restarting' : 'stopped'
        return (
          <div key={c.id} className="csc-card">
            <div className="csc-card-row">
              <span className={clsx('cst-dot', `cst-dot--${stateKey}`)} />
              <span className="csc-name">{svc}</span>
              <span className={clsx('cst-state-badge', `cst-state--${stateKey}`)}>{c.state}</span>
            </div>
            <div className="csc-container-id" title={c.name}>{c.name}</div>
            <div className="csc-actions">
              {isRunning ? (
                <>
                  <button className="csc-btn csc-btn--stop"    onClick={() => onServiceAction(svc,'stop')}    disabled={isBusy} title="Stop"><Square size={11}/></button>
                  <button className="csc-btn csc-btn--restart" onClick={() => onServiceAction(svc,'restart')} disabled={isBusy} title="Restart"><RestartIcon size={11}/></button>
                  <button className="csc-btn"                  onClick={() => onOpenLogs(svc)}                title="Open logs"><ScrollText size={11}/></button>
                  <button className="csc-btn"                  onClick={() => onShell(c.name)}               title="Open shell"><Terminal size={11}/></button>
                </>
              ) : (
                <button className="csc-btn csc-btn--start" onClick={() => onServiceAction(svc,'up')} disabled={isBusy} title="Start"><Play size={11}/></button>
              )}
              <button className="csc-btn csc-btn--inspect" onClick={() => onInspect(c)} title="Inspect"><Info size={11}/></button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface ComposeTabProps {
  refreshTick?:   number
  containers:     DockerContainer[]
  containerStats: ContainerStats[]
  statHistory:    Map<string, { cpu: number[]; mem: number[] }>
  onRefresh?:     () => void
}

export default function ComposeTab({
  refreshTick = 0, containers, containerStats, statHistory, onRefresh,
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

  // ── Inline editor ─────────────────────────────────────────────────────────
  const [editMode, setEditMode]     = useState(false)
  const [editDraft, setEditDraft]   = useState('')
  const [editSaving, setEditSaving] = useState(false)

  // ── Per-service controls ──────────────────────────────────────────────────
  const [serviceAction, setServiceAction] = useState<{ service: string; action: string } | null>(null)
  const [inspectContainer, setInspectContainer] = useState<DockerContainer | null>(null)

  // ── Volume wipe ───────────────────────────────────────────────────────────
  const [downDropOpen, setDownDropOpen]     = useState(false)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)
  const [wipeRunning, setWipeRunning]         = useState(false)

  // (legacy .env accordion state removed — .env is now a first-class tab)

  // ── Detected extra project files (Dockerfiles, .env) ─────────────────────
  const [projectFiles, setProjectFiles] = useState<DetectedFile[]>([])
  // Cache of loaded file contents keyed by path
  const [fileContents, setFileContents] = useState<Record<string, string>>({})

  // ── Open in IDE ───────────────────────────────────────────────────────────
  const preferredEditor = useAppStore(s => s.preferredEditor)
  const setPreferredEditor = useAppStore(s => s.setPreferredEditor)
  const [idePickerOpen, setIdePickerOpen] = useState(false)
  const [detectedEditors, setDetectedEditors] = useState<EditorInfo[]>([])

  // ── Metadata panel ────────────────────────────────────────────────────────
  const [metaPanelOpen, setMetaPanelOpen] = useState(false)
  const [metaTagInput, setMetaTagInput]   = useState('')

  // ── Config validator ──────────────────────────────────────────────────────
  const [validatorOpen,    setValidatorOpen]    = useState(false)
  const [validatorRunning, setValidatorRunning] = useState(false)
  const [validatorResult,  setValidatorResult]  = useState<{ yaml?: string; error?: string } | null>(null)

  // ── Log panel ─────────────────────────────────────────────────────────────
  const [logPanelOpen,      setLogPanelOpen]      = useState(false)
  const [logInitialService, setLogInitialService] = useState<string | null>(null)

  // ── Computed ──────────────────────────────────────────────────────────────

  const projectDir = useMemo(() => {
    if (!activeFile) return ''
    const i = Math.max(activeFile.lastIndexOf('/'), activeFile.lastIndexOf('\\'))
    return i >= 0 ? activeFile.slice(0, i) : ''
  }, [activeFile])

  const projectContainers = useMemo(
    () => selected ? containers.filter(c => c.compose_project === selected.name) : [],
    [containers, selected]
  )

  // (envFilePath no longer used — .env is now a detected first-class tab)

  // ── File type from active file path ──────────────────────────────────────

  const fileType = useMemo((): 'compose' | 'env' | 'dockerfile' => {
    const name = activeFile.split('/').pop()?.split('\\').pop() ?? ''
    if (name === '.env' || name.startsWith('.env.')) return 'env'
    if (name === 'Dockerfile' || name.startsWith('Dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
    return 'compose'
  }, [activeFile])

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

  // Detect editors in PATH once on mount
  useEffect(() => {
    api.detectEditors().then(setDetectedEditors).catch(() => {})
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
    setEditMode(false)
    setInspectContainer(null)
    setLogPanelOpen(false)
    setValidatorOpen(false)
    setMetaPanelOpen(false)
    setProjectFiles([])
    setFileContents({})
    // Detect additional project files (Dockerfiles, .env)
    const firstConfig = project.config_files[0]
    if (firstConfig) {
      api.detectComposeProjectFiles(firstConfig).then(setProjectFiles).catch(() => {})
    }
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

  // ── Extra file loader (Dockerfiles, .env tabs) ────────────────────────────

  const loadExtraFile = async (path: string) => {
    if (fileContents[path] !== undefined) return
    try {
      const content = await api.readFileContent(path)
      setFileContents(prev => ({ ...prev, [path]: content }))
    } catch (e) {
      setFileContents(prev => ({ ...prev, [path]: '' }))
    }
  }

  // ── Open in IDE ───────────────────────────────────────────────────────────

  const handleOpenInIde = async () => {
    if (!activeFile) return
    if (preferredEditor) {
      await api.openInEditor(activeFile, preferredEditor.command).catch(e =>
        useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
      )
    } else {
      // Show picker on first use
      if (detectedEditors.length === 0) {
        await api.detectEditors().then(setDetectedEditors).catch(() => {})
      }
      setIdePickerOpen(true)
    }
  }

  const handleEditorPick = async (editor: EditorInfo) => {
    setPreferredEditor(editor)
    setIdePickerOpen(false)
    if (activeFile) {
      await api.openInEditor(activeFile, editor.command).catch(e =>
        useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
      )
    }
  }

  // ── Config validator ──────────────────────────────────────────────────────

  const handleValidate = async () => {
    if (!activeFile || validatorRunning) return
    setValidatorRunning(true)
    setValidatorResult(null)
    setValidatorOpen(true)
    try {
      const yaml = await api.dockerComposeConfig(activeFile)
      setValidatorResult({ yaml })
    } catch (e) {
      setValidatorResult({ error: String(e) })
    } finally {
      setValidatorRunning(false)
    }
  }

  // ── Startup time tracking ─────────────────────────────────────────────────

  const recordStartupTime = async (projectName: string, startMs: number) => {
    // Poll until all containers for project are running (max 5 min)
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        const ctrs = await api.dockerContainers()
        const projectCtrs = ctrs.filter(c => c.compose_project === projectName)
        if (projectCtrs.length > 0 && projectCtrs.every(c => c.state === 'running')) {
          const elapsed = Date.now() - startMs
          const currentMeta = metadata[projectName] ?? { favorite: false, tags: [], note: '', active_env: null, recent_opened: null, startup_times: [] }
          const updated = { ...currentMeta, startup_times: [...(currentMeta.startup_times ?? []).slice(-9), elapsed] }
          setMetadata(prev => ({ ...prev, [projectName]: updated }))
          api.metadataSaveProject(projectName, updated).catch(() => {})
          return
        }
      } catch { break }
    }
  }

  // ── Inline editor ─────────────────────────────────────────────────────────

  const isModified = editMode && editDraft !== (fileContent ?? '')

  const enterEditMode = () => {
    setEditDraft(fileContent ?? '')
    setEditMode(true)
  }

  const cancelEdit = () => {
    setEditMode(false)
  }

  const handleSave = async () => {
    if (!activeFile || editSaving) return
    setEditSaving(true)
    try {
      await api.writeFileContent(activeFile, editDraft)
      setFileContent(editDraft)
      setEditMode(false)
      useAppStore.getState().addTerminalLine(`  ✓ Saved ${activeFile}`, 'success')
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ Save failed: ${String(e)}`, 'error')
    } finally {
      setEditSaving(false)
    }
  }

  // ── Per-service controls ──────────────────────────────────────────────────

  const handleServiceAction = async (service: string, action: 'up' | 'stop' | 'restart') => {
    if (!activeFile || serviceAction) return
    setServiceAction({ service, action })
    const { addTerminalLine, setTerminalOpen } = useAppStore.getState()
    setTerminalOpen(true)
    addTerminalLine(`─── docker compose ${action} ${service} ───`, 'info')
    const unlistenLog = await listen<string>('docker-log', e => {
      const type = e.payload.startsWith('$') ? 'cmd' : e.payload.startsWith('[err]') ? 'stderr' : 'stdout'
      useAppStore.getState().addTerminalLine(e.payload, type)
    })
    try {
      await api.dockerComposeServiceAction(activeFile, action, service)
      useAppStore.getState().addTerminalLine('─── Done ───', 'success')
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlistenLog()
      setServiceAction(null)
      loadProjects()
      onRefresh?.()
    }
  }

  const handleShell = async (containerName: string) => {
    try {
      await api.openContainerShell(containerName)
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ Shell failed: ${String(e)}`, 'error')
    }
  }

  // ── Volume wipe ───────────────────────────────────────────────────────────

  const handleWipeDown = async () => {
    if (!activeFile || wipeRunning) return
    setWipeRunning(true)
    const { addTerminalLine, setTerminalOpen } = useAppStore.getState()
    setTerminalOpen(true)
    addTerminalLine('─── docker compose down -v ───', 'info')
    const unlistenLog = await listen<string>('docker-log', e => {
      const type = e.payload.startsWith('$') ? 'cmd' : e.payload.startsWith('[err]') ? 'stderr' : 'stdout'
      useAppStore.getState().addTerminalLine(e.payload, type)
    })
    try {
      await api.dockerComposeAction(activeFile, 'down-volumes')
      useAppStore.getState().addTerminalLine('─── Done ───', 'success')
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlistenLog()
      setWipeRunning(false)
      setWipeConfirmOpen(false)
      loadProjects()
    }
  }

  const loadFile = async (path: string) => {
    if (!path) return
    setFileLoading(true); setFileError(null); setFileContent(null)
    try { setFileContent(await api.readFileContent(path)) }
    catch (e) { setFileError(String(e)) }
    finally { setFileLoading(false) }
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

    const startMs = Date.now()
    try {
      await api.dockerComposeAction(activeFile, action)
      useAppStore.getState().addTerminalLine('─── Done ───', 'success')
      // Kick off startup time tracking for Up/Rebuild actions
      if ((action === 'up' || action === 'rebuild') && selected) {
        recordStartupTime(selected.name, startMs)
      }
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlistenLog()
      setLifecycleRunning(null)
      // Refresh project list and container states to reflect updated status
      onRefresh?.()
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

          {/* ── Top bar: back + lifecycle only ── */}
          <div className="compose-project-topbar">
            <button
              className="compose-back-btn"
              onClick={() => { setViewMode('main'); useAppStore.getState().setComposeActiveProject(null) }}
              title="Back to all projects"
            >
              <ArrowLeft size={12} />
              <span className="compose-back-label">{selected.name}</span>
            </button>
            <div className="compose-topbar-spacer" />
            <div className="compose-lifecycle-btns">
              {LIFECYCLE_ACTIONS.map(({ id, Icon, label, title, color }) => {
                const busy = !!lifecycleRunning || !activeFile || isModified
                if (id === 'down') {
                  return (
                    <div key={id} className="compose-split-btn-wrap">
                      <button
                        className={clsx('compose-lifecycle-btn compose-split-btn-main', 'compose-lifecycle-btn--danger', lifecycleRunning === 'down' && 'loading')}
                        onClick={() => runComposeAction('down')} disabled={busy} title="docker compose down"
                      >
                        <Square size={11} className={lifecycleRunning === 'down' ? 'spin' : ''} /> Down
                      </button>
                      <button
                        className={clsx('compose-split-btn-arrow', 'compose-lifecycle-btn--danger', downDropOpen && 'open')}
                        onClick={() => setDownDropOpen(o => !o)} disabled={busy} title="More options"
                      >
                        <ChevronDown size={10} />
                      </button>
                      {downDropOpen && (
                        <div className="compose-split-dropdown">
                          <button className="compose-split-dropdown-item compose-split-dropdown-item--danger"
                            onClick={() => { setDownDropOpen(false); setWipeConfirmOpen(true) }}>
                            <Trash2 size={11} /> Down + Wipe Volumes
                          </button>
                        </div>
                      )}
                    </div>
                  )
                }
                return (
                  <button key={id}
                    className={clsx('compose-lifecycle-btn', `compose-lifecycle-btn--${color}`, lifecycleRunning === id && 'loading')}
                    onClick={() => runComposeAction(id)} disabled={busy} title={title}
                  >
                    <Icon size={11} className={lifecycleRunning === id ? 'spin' : ''} /> {label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Two-column layout ── */}
          <div className="compose-project-layout">

            {/* ── LEFT: File editor ── */}
            <div className="compose-project-left">

              {/* Tab strip + edit controls */}
              <div className="compose-left-header">
                <div className="compose-file-tabs">
                  {selected.config_files.map(f => (
                    <button key={f}
                      className={clsx('compose-file-path-item', activeFile === f && 'active')}
                      onClick={() => { setActiveFile(f); loadFile(f); setBackupMsg(null); setEditMode(false) }}
                      title={f}
                    >
                      <PathOriginLine path={f} />
                      <span className="compose-file-path-text">{f.split('/').pop()?.split('\\').pop()}</span>
                      {activeFile === f && isModified && <span className="compose-modified-dot" title="Unsaved changes" />}
                    </button>
                  ))}
                  {projectFiles.map(pf => {
                    const name = pf.path.split('/').pop()?.split('\\').pop() ?? pf.path
                    const isActive = activeFile === pf.path
                    return (
                      <button key={pf.path}
                        className={clsx('compose-file-path-item compose-file-path-item--extra', isActive && 'active')}
                        onClick={() => { setActiveFile(pf.path); setEditMode(false); loadExtraFile(pf.path) }}
                        title={pf.path}
                      >
                        {pf.kind === 'dockerfile'
                          ? <FileCode2 size={11} style={{ color: '#60a5fa', flexShrink: 0 }} />
                          : <FileKey size={11} style={{ color: '#f0a500', flexShrink: 0 }} />}
                        <span className="compose-file-path-text">{name}</span>
                      </button>
                    )
                  })}
                </div>
                {fileType === 'compose' && (
                  <div className="compose-edit-controls">
                    {editMode ? (
                      <>
                        <button className="compose-save-btn" onClick={handleSave} disabled={editSaving || !isModified} title="Save file">
                          <Save size={11} className={editSaving ? 'spin' : ''} />
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button className="compose-cancel-edit-btn" onClick={cancelEdit} disabled={editSaving} title="Discard changes">
                          <X size={11} /> Cancel
                        </button>
                      </>
                    ) : (
                      <button className="compose-edit-btn" onClick={enterEditMode} disabled={!fileContent || !!lifecycleRunning} title="Edit file">
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* File content */}
              <div className="compose-viewer-body">
                {fileLoading && <div className="compose-viewer-state">Loading file…</div>}
                {fileError && <div className="compose-viewer-state compose-viewer-error"><AlertCircle size={14} />{fileError}</div>}
                {!fileLoading && fileType === 'compose' && fileContent !== null && !editMode && (
                  <YamlViewer content={fileContent} onOpenPort={handleOpenPort} onRevealPath={handleRevealPath} />
                )}
                {!fileLoading && fileType === 'compose' && editMode && (
                  <div className="compose-editor-wrap">
                    <div className="compose-line-nums compose-line-nums--edit" aria-hidden>
                      {editDraft.split('\n').map((_, i) => <span key={i}>{i + 1}</span>)}
                    </div>
                    <textarea className="compose-editor-textarea" value={editDraft}
                      onChange={e => setEditDraft(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
                  </div>
                )}
                {fileType === 'env' && activeFile && (
                  fileContents[activeFile] !== undefined
                    ? <ComposeEnvTab filePath={activeFile} content={fileContents[activeFile]} yamlContent={fileContent ?? ''}
                        onSaved={newContent => setFileContents(prev => ({ ...prev, [activeFile]: newContent }))} />
                    : <div className="compose-viewer-state">Loading…</div>
                )}
                {fileType === 'dockerfile' && activeFile && (
                  fileContents[activeFile] !== undefined
                    ? <ComposeDockerfileViewer filePath={activeFile} content={fileContents[activeFile]}
                        onSaved={newContent => setFileContents(prev => ({ ...prev, [activeFile]: newContent }))} />
                    : <div className="compose-viewer-state">Loading…</div>
                )}
              </div>
            </div>

            {/* ── RIGHT: Sidebar ── */}
            <div className="compose-project-right">

              {/* Services */}
              {projectContainers.length > 0 && (
                <div className="compose-right-section">
                  <div className="compose-right-section-title">Services</div>
                  <ServiceCards
                    containers={projectContainers}
                    serviceAction={serviceAction}
                    onServiceAction={handleServiceAction}
                    onOpenLogs={svc => { setLogInitialService(svc); setLogPanelOpen(true) }}
                    onShell={handleShell}
                    onInspect={setInspectContainer}
                  />
                </div>
              )}

              {/* Actions */}
              <div className="compose-right-section">
                <div className="compose-right-section-title">Actions</div>
                <div className="compose-sidebar-tools">
                  <button className="compose-sidebar-tool-btn" onClick={handleOpenInIde} disabled={!activeFile}
                    title={preferredEditor ? `Open in ${preferredEditor.name}` : 'Open in editor'}>
                    <OpenIdeIcon size={13} />
                    <span className="compose-sidebar-tool-label">{preferredEditor ? preferredEditor.name : 'Open in IDE'}</span>
                  </button>
                  <button className={clsx('compose-sidebar-tool-btn', logPanelOpen && 'active')}
                    onClick={() => { setLogInitialService(null); setLogPanelOpen(o => !o) }}>
                    <ScrollText size={13} />
                    <span className="compose-sidebar-tool-label">Logs</span>
                    <ChevronDown size={10} className={clsx('compose-sidebar-tool-chevron', logPanelOpen && 'open')} />
                  </button>
                  <button className={clsx('compose-sidebar-tool-btn', validatorOpen && 'active')}
                    onClick={handleValidate} disabled={validatorRunning || !activeFile} title="Run docker compose config">
                    <CheckCircle size={13} className={validatorRunning ? 'spin' : ''} />
                    <span className="compose-sidebar-tool-label">Validate Config</span>
                  </button>
                  <button className={clsx('compose-sidebar-tool-btn', metaPanelOpen && 'active')}
                    onClick={() => setMetaPanelOpen(o => !o)} title="Project metadata">
                    <MoreHorizontal size={13} />
                    <span className="compose-sidebar-tool-label">Metadata</span>
                    <ChevronDown size={10} className={clsx('compose-sidebar-tool-chevron', metaPanelOpen && 'open')} />
                  </button>
                  {backupDir && (
                    <button className={clsx('compose-sidebar-tool-btn', backupOpen && 'active')}
                      onClick={() => setBackupOpen(o => !o)}
                      title={fileBackups.length > 0 ? `${fileBackups.length} backup${fileBackups.length !== 1 ? 's' : ''}` : 'Backup history'}>
                      <Download size={13} />
                      <span className="compose-sidebar-tool-label">Backup</span>
                      {fileBackups.length > 0 && <span className="compose-backup-btn-count">{fileBackups.length}</span>}
                      <ChevronDown size={10} className={clsx('compose-sidebar-tool-chevron', backupOpen && 'open')} />
                    </button>
                  )}
                </div>
              </div>

              {/* Log panel - inline in sidebar */}
              {logPanelOpen && selected && (
                <div className="compose-sidebar-panel">
                  <ComposeLogPanel project={selected} containers={containers}
                    configFile={selected.config_files[0] ?? ''}
                    initialService={logInitialService ?? undefined}
                    onClose={() => setLogPanelOpen(false)} />
                </div>
              )}

              {/* Validator - inline in sidebar */}
              {validatorOpen && (
                <div className="compose-sidebar-panel">
                  <div className="compose-sidebar-panel-header">
                    <span>{validatorRunning ? 'Validating…' : validatorResult?.error ? 'Validation errors' : 'Resolved config'}</span>
                    <button className="compose-inspect-close" onClick={() => setValidatorOpen(false)}><X size={12} /></button>
                  </div>
                  <div className="compose-sidebar-panel-body">
                    {validatorRunning && <div className="compose-viewer-state" style={{ fontSize: 11 }}>Running docker compose config…</div>}
                    {!validatorRunning && validatorResult?.error && (
                      <pre className="compose-validator-error" style={{ margin: 8, fontSize: 10.5 }}>{validatorResult.error}</pre>
                    )}
                    {!validatorRunning && validatorResult?.yaml && (() => {
                      const yamlLines = validatorResult.yaml.split('\n')
                      return (
                        <div className="compose-code-wrap" style={{ fontSize: 10.5 }}>
                          <div className="compose-line-nums" aria-hidden>
                            {yamlLines.map((_, i) => <span key={i}>{i + 1}</span>)}
                          </div>
                          <div className="compose-code-body">
                            {yamlLines.map((line, i) => <YamlLine key={i} line={line} />)}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )}

              {/* Metadata - inline in sidebar */}
              {metaPanelOpen && selected && (() => {
                const meta = metadata[selected.name] ?? { favorite: false, tags: [], note: '', active_env: null, recent_opened: null, startup_times: [] }
                const saveMeta = (patch: Partial<AppProjectMeta>) => handleMetaChange(selected.name, { ...meta, ...patch })
                return (
                  <div className="compose-sidebar-panel">
                    <div className="compose-sidebar-panel-header">
                      <span>Metadata</span>
                      <button className="compose-inspect-close" onClick={() => setMetaPanelOpen(false)}><X size={12} /></button>
                    </div>
                    <div className="compose-meta-panel-body">
                      <div className="compose-meta-row">
                        <span className="compose-meta-label">Favorite</span>
                        <button className={clsx('compose-meta-favorite-btn', meta.favorite && 'active')}
                          onClick={() => saveMeta({ favorite: !meta.favorite })}>
                          {meta.favorite ? '★ Starred' : '☆ Star this project'}
                        </button>
                      </div>
                      <div className="compose-meta-row compose-meta-row--col">
                        <span className="compose-meta-label">Tags</span>
                        <div className="compose-meta-tags">
                          {meta.tags.map(tag => (
                            <span key={tag} className="compose-tag-chip">{tag}
                              <button className="compose-meta-tag-remove" onClick={() => saveMeta({ tags: meta.tags.filter(t => t !== tag) })}><X size={8} /></button>
                            </span>
                          ))}
                          <input className="compose-meta-tag-input" placeholder="Add tag…" value={metaTagInput}
                            onChange={e => setMetaTagInput(e.target.value)}
                            onKeyDown={e => {
                              if ((e.key === 'Enter' || e.key === ',') && metaTagInput.trim()) {
                                e.preventDefault()
                                const tag = metaTagInput.trim().replace(/,/g, '')
                                if (!meta.tags.includes(tag)) saveMeta({ tags: [...meta.tags, tag] })
                                setMetaTagInput('')
                              }
                            }} />
                        </div>
                      </div>
                      <div className="compose-meta-row compose-meta-row--col">
                        <span className="compose-meta-label">Notes</span>
                        <textarea className="compose-meta-notes" value={meta.note}
                          placeholder="Admin URLs, credentials hints, context…"
                          onChange={e => saveMeta({ note: e.target.value })} rows={4} />
                      </div>
                      {meta.startup_times && meta.startup_times.length > 0 && (
                        <div className="compose-meta-row compose-meta-row--col">
                          <span className="compose-meta-label">Startup times</span>
                          <div className="compose-meta-startup-list">
                            {meta.startup_times.slice(-5).reverse().map((ms, i) => (
                              <span key={i} className="compose-meta-startup-item">{(ms / 1000).toFixed(1)}s</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* Backup - inline in sidebar */}
              {backupOpen && (
                <div className="compose-sidebar-panel">
                  <div className="compose-sidebar-panel-header">
                    <span>Backup</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {backupMsg && <span className={clsx('compose-toolbar-status', backupMsg.type)} style={{ fontSize: 10.5 }}>{backupMsg.text}</span>}
                      <button className="compose-run-backup-btn" onClick={runBackup} disabled={backingUp || !backupDir || !selected}>
                        <Download size={11} className={backingUp ? 'spin' : ''} />
                        {backingUp ? 'Backing up…' : 'Run Backup'}
                      </button>
                    </div>
                  </div>
                  <div className="compose-sidebar-panel-body">
                    <div className="compose-backup-accordion" style={{ border: 'none' }}>
                      {fileBackups.length === 0
                        ? <p className="compose-backup-empty">No backups yet for this file.</p>
                        : (
                          <ul className="compose-backup-list">
                            {fileBackups.map(entry => (
                              <li key={entry.filename} className="compose-backup-entry">
                                <span className="compose-backup-entry-date">{formatDate(entry.created_at)}</span>
                                <span className="compose-backup-entry-size">{bytesToHuman(entry.size_bytes)}</span>
                                <span className="compose-backup-entry-file" title={entry.filename}>{entry.filename}</span>
                                <div className="compose-backup-entry-actions">
                                  <button className="ctr-action-btn" onClick={() => revealItemInDir(entry.path).catch(() => {})} title="Open file location"><FolderOpen size={12} /></button>
                                  <button className="ctr-action-btn ctr-action-remove" onClick={() => handleDeleteBackup(entry)}
                                    disabled={deletingFile === entry.filename} title="Delete this backup"><Trash2 size={12} /></button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )
                      }
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

            {/* ── Inspect drawer ──────────────────────────────────────────────────── */}
      {inspectContainer && (
        <InspectDrawer container={inspectContainer} onClose={() => setInspectContainer(null)} />
      )}

      {/* ── Wipe confirmation modal ──────────────────────────────────────────── */}
      {wipeConfirmOpen && selected && (
        <WipeConfirmModal
          projectName={selected.name}
          onConfirm={handleWipeDown}
          onCancel={() => setWipeConfirmOpen(false)}
          running={wipeRunning}
        />
      )}

      {/* ── IDE picker modal ─────────────────────────────────────────────────── */}
      {idePickerOpen && (
        <div className="compose-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setIdePickerOpen(false) }}>
          <div className="compose-modal-box" style={{ maxWidth: 340 }}>
            <h3 className="compose-modal-title">Open in Editor</h3>
            <p className="compose-modal-body" style={{ marginBottom: 12 }}>
              Choose your preferred editor. This preference is saved and used for all future opens.
            </p>
            {detectedEditors.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                No editors detected in PATH. Install VS Code, Cursor, or Sublime Text.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detectedEditors.map(ed => (
                  <button
                    key={ed.command}
                    className="compose-ide-pick-btn"
                    onClick={() => handleEditorPick(ed)}
                  >
                    {ed.name}
                    <span className="compose-ide-pick-cmd">{ed.command}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="compose-modal-actions" style={{ marginTop: 16 }}>
              <button className="btn-refresh" onClick={() => setIdePickerOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
