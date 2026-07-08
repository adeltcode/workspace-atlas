import { useEffect, useLayoutEffect, useState, useMemo, useRef } from 'react'
import { revealItemInDir, openUrl } from '@tauri-apps/plugin-opener'
import {
  Download, AlertCircle, FolderOpen, Trash2, Monitor, Terminal,
  ChevronDown, Play, Square, RotateCcw, Wrench, FileKey, ExternalLink, ArrowLeft, Plug,
  Pencil, Save, X, Info, RotateCcw as RestartIcon,
  ExternalLink as OpenIdeIcon, CheckCircle, MoreHorizontal, FileCode2, ScrollText,
} from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import { runWithDockerLog } from '../dockerLog'
import { ModalOverlay } from '../../../components/Modal'
import { useAppStore } from '../../../store/appStore'
import { emptyMeta, type ComposeProject, type ComposeBackupEntry, type DockerContainer, type ContainerStats, type AppProjectMeta, type DetectedFile, type EditorInfo } from '../types'
import { bytesToHuman, formatDate, hostPorts } from '../../../utils/format'
import ComposePage from './ComposePage'
import ComposeEnvTab from './ComposeEnvTab'
import ComposeDockerfileViewer, { DockerfileLine } from './ComposeDockerfileViewer'
import CodeOverlayEditor from './CodeOverlayEditor'

// ── YAML syntax highlighter ───────────────────────────────────────────────────

// Matches: optional-ip:hostPort:containerPort[/proto]
const PORT_RE = /^(?:[\d.]+:)?(\d+):\d+(?:\/(?:tcp|udp))?$/

// Label a detected file relative to the compose project dir, so nested files
// like ./nginx/Dockerfile and ./php/Dockerfile are distinguishable in the tabs.
function relLabel(path: string, baseDir: string): string {
  const np = path.replace(/\\/g, '/')
  const nb = baseDir.replace(/\\/g, '/').replace(/\/$/, '')
  if (nb && np.toLowerCase().startsWith(nb.toLowerCase() + '/')) return np.slice(nb.length + 1)
  return np.split('/').pop() ?? path
}

// Directory holding a path, and that directory's lowercased leaf name.
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : ''
}
function dirNameOf(p: string): string {
  return dirOf(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? ''
}

// The sidebar file menu for a project: its compose config files followed by the
// already-filtered detected extras (referenced Dockerfiles and .env files).
type FileNav = { path: string; label: string; kind: 'compose' | 'dockerfile' | 'env' }
function buildFileNav(project: ComposeProject, extras: DetectedFile[]): FileNav[] {
  const baseDir = dirOf(project.config_files[0] ?? '')
  return [
    ...project.config_files.map(f => ({ path: f, label: relLabel(f, baseDir), kind: 'compose' as const })),
    ...extras.map(pf => ({
      path:  pf.path,
      label: relLabel(pf.path, baseDir),
      kind:  (pf.kind === 'env' ? 'env' : 'dockerfile') as 'dockerfile' | 'env',
    })),
  ]
}

const EMPTY_FILES: DetectedFile[] = []

// Host ports published by the running containers in a project (deduped, in order)
function runningHostPorts(containers: DockerContainer[]): string[] {
  return [...new Set(containers.filter(c => c.state === 'running' && c.ports).flatMap(c => hostPorts(c.ports)))]
}

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
  line, onOpenPort, onRevealPath, onOpenDockerfile,
}: {
  line:             string
  onOpenPort?:      (port: string) => void
  onRevealPath?:    (path: string) => void
  onOpenDockerfile?:(value: string) => void
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
    const isDockerfileRef = key === 'dockerfile' && !!onOpenDockerfile && rest.trim() !== ''
    return (
      <div className="yaml-line">
        <span>{pre}</span>
        <span className={depth === 0 ? 'yaml-key-root' : 'yaml-key'}>{key}</span>
        <span className="yaml-colon">{colon}</span>
        {rest
          ? (isDockerfileRef
              ? <> <button className="yaml-path-link" onClick={() => onOpenDockerfile!(rest)} title="Open this Dockerfile">
                  <span className="yaml-value">{rest.trim()}</span>
                  <FileCode2 size={9} className="yaml-path-icon" />
                </button></>
              : <> {renderYamlValue(rest, onOpenPort, onRevealPath)}</>)
          : null}
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
  content, onOpenPort, onRevealPath, onOpenDockerfile, initialScrollTop = 0, onScrollTop,
}: {
  content:           string
  onOpenPort?:       (port: string) => void
  onRevealPath?:     (path: string) => void
  onOpenDockerfile?: (value: string) => void
  initialScrollTop?: number
  onScrollTop?:      (top: number) => void
}) {
  const numsRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  const syncScroll = () => {
    const area = areaRef.current
    if (!area) return
    if (numsRef.current) numsRef.current.scrollTop = area.scrollTop
    onScrollTop?.(area.scrollTop)
  }

  // Restore the scroll position from the previous mode before paint.
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.scrollTop = initialScrollTop
    if (numsRef.current) numsRef.current.scrollTop = area.scrollTop
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="compose-code-wrap">
      <div className="compose-line-nums" aria-hidden ref={numsRef}>
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="compose-code-area" ref={areaRef} onScroll={syncScroll}>
        <div className="compose-code-body">
          {lines.map((line, i) => (
            <YamlLine key={i} line={line} onOpenPort={onOpenPort} onRevealPath={onRevealPath} onOpenDockerfile={onOpenDockerfile} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Dockerfile reference parsing (match detected files to the compose file) ──

// Resolve a build context + dockerfile into a normalized project-relative path,
// e.g. context "." + dockerfile "./nginx/Dockerfile" → "nginx/dockerfile".
function refRelFrom(context: string, dockerfile: string): string {
  const parts: string[] = []
  const push = (seg: string) => {
    for (const s of seg.replace(/\\/g, '/').split('/')) {
      if (!s || s === '.') continue
      if (s === '..') { parts.pop(); continue }
      parts.push(s)
    }
  }
  push(context); push(dockerfile)
  return parts.join('/').toLowerCase()
}

// Extract the Dockerfiles a compose file actually builds, as project-relative refs.
function parseDockerfileRefs(yaml: string): string[] {
  const lines = yaml.split('\n')
  const clean = (s: string) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
  const refs: string[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)build\s*:(.*)$/)
    if (!m) { i++; continue }
    const indent = m[1].length
    const inline = clean(m[2])
    if (inline) { refs.push(refRelFrom(inline, 'Dockerfile')); i++; continue }
    // Block form — scan deeper-indented context/dockerfile keys
    let context = '.', dockerfile = 'Dockerfile'
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (l.trim() === '') { i++; continue }
      const childIndent = l.length - l.trimStart().length
      if (childIndent <= indent) break
      const cm = l.match(/^\s*context\s*:\s*(.+)$/)
      const dm = l.match(/^\s*dockerfile\s*:\s*(.+)$/)
      if (cm) context = clean(cm[1])
      if (dm) dockerfile = clean(dm[1])
      i++
    }
    refs.push(refRelFrom(context, dockerfile))
  }
  return refs
}

// Does a detected Dockerfile path correspond to one of the compose refs?
// Anchors on the project dir name so a bare "Dockerfile" ref matches the root
// one rather than a nested nginx/Dockerfile. Format-agnostic (suffix compare).
function dockerfileMatchesRefs(path: string, refRels: string[], dirName: string): boolean {
  const np = path.replace(/\\/g, '/').toLowerCase()
  return refRels.some(rel => {
    if (!rel) return false
    if (dirName && np.endsWith(`/${dirName}/${rel}`)) return true
    return rel.includes('/') && np.endsWith(`/${rel}`)
  })
}

// Editable YAML with live syntax highlighting (highlighted layer behind a
// transparent textarea — see CodeOverlayEditor). Keeps the view ⇄ edit
// transition visually seamless.
function YamlEditor({ value, onChange, initialScrollTop, onScrollTop }: {
  value: string; onChange: (v: string) => void
  initialScrollTop?: number; onScrollTop?: (top: number) => void
}) {
  return (
    <CodeOverlayEditor
      value={value}
      onChange={onChange}
      renderLine={(line, i) => <YamlLine key={i} line={line} />}
      initialScrollTop={initialScrollTop}
      onScrollTop={onScrollTop}
    />
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
  const ports = hostPorts(container.ports)

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
          {ports.length > 0 && <>
            <dt>Host ports</dt>
            <dd>{ports.map(p => `:${p}`).join('  ')}</dd>
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
  // Typed confirmation: wiping named volumes destroys data (databases included)
  // irreversibly, so it sits in the same tier as Nuclear Prune — the user must
  // type the project name before the button arms.
  const [confirmText, setConfirmText] = useState('')
  const armed = confirmText.trim() === projectName
  return (
    <ModalOverlay onClose={onCancel} className="compose-modal-backdrop" dismissable={!running} labelledBy="wipe-confirm-title">
      <div className="compose-modal-box">
        <h3 className="compose-modal-title" id="wipe-confirm-title">Wipe volumes for "{projectName}"?</h3>
        <p className="compose-modal-body">
          This permanently deletes all named volumes for this project — including database
          data — and runs <code>docker compose down -v</code>. This cannot be undone.
        </p>
        <p className="compose-modal-body" style={{ marginTop: 8 }}>
          Type <strong>{projectName}</strong> to confirm.
        </p>
        <input
          className="modal-input"
          type="text"
          placeholder={projectName}
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          disabled={running}
          autoFocus
        />
        <div className="compose-modal-actions">
          <button className="btn-refresh" onClick={onCancel} disabled={running}>Cancel</button>
          <button
            className="compose-modal-btn-danger"
            onClick={onConfirm}
            disabled={running || !armed}
          >
            {running ? <RotateCcw size={11} className="spin" /> : <Trash2 size={11} />}
            {running ? 'Running…' : 'Wipe & Down'}
          </button>
        </div>
      </div>
    </ModalOverlay>
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
          <div key={c.id} className={clsx('csc-card', `csc-card--${stateKey}`)}>
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
  onRefresh?:     () => void
}

export default function ComposeTab({
  refreshTick = 0, containers, containerStats, onRefresh,
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
  // Last scroll position per file, so toggling read-only ⇄ edit (and switching
  // between files) keeps the user at the same place in the document.
  const scrollByFile = useRef<Record<string, number>>({})
  const rememberScroll = (top: number) => { scrollByFile.current[activeFile] = top }

  // ── Per-service controls ──────────────────────────────────────────────────
  const [serviceAction, setServiceAction] = useState<{ service: string; action: string } | null>(null)
  const [inspectContainer, setInspectContainer] = useState<DockerContainer | null>(null)

  // ── Volume wipe ───────────────────────────────────────────────────────────
  const [downDropOpen, setDownDropOpen]     = useState(false)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)
  const [wipeRunning, setWipeRunning]         = useState(false)

  // (legacy .env accordion state removed — .env is now a first-class tab)

  // ── Detected extra project files (Dockerfiles, .env), filtered to those the
  //    compose file references and cached per project. Built once and preloaded
  //    so the sidebar file menu is instant and never flickers as content loads.
  const [filesByProject, setFilesByProject] = useState<Record<string, DetectedFile[]>>({})
  // Projects whose detection is in flight, so the preload and a user-select
  // never run detection for the same project at once.
  const detectingRef = useRef<Set<string>>(new Set())
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

  // ── Logs — routed to the bottom Terminal panel's "Logs" tab ────────────────
  const composeLogContext = useAppStore(s => s.composeLogContext)
  const terminalTab       = useAppStore(s => s.terminalTab)

  const openLogs = (service: string | null) => {
    if (!selected) return
    useAppStore.getState().openComposeLogs({
      project:        selected,
      containers,
      configFile:     selected.config_files[0] ?? '',
      initialService: service,
    })
  }

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

  // Project-level status summary shown in the detail header
  const runningCount = projectContainers.filter(c => c.state === 'running').length
  const totalCount   = projectContainers.length
  const projState: 'none' | 'running' | 'partial' | 'stopped' =
    totalCount === 0     ? 'none'
    : runningCount === 0 ? 'stopped'
    : runningCount === totalCount ? 'running'
    : 'partial'
  const headerPorts = useMemo(() => runningHostPorts(projectContainers).slice(0, 6), [projectContainers])

  // Directory holding the compose file — used to label nested project files
  const composeBaseDir = useMemo(() => dirOf(selected?.config_files[0] ?? ''), [selected])
  const composeDirName = useMemo(() => dirNameOf(selected?.config_files[0] ?? ''), [selected])

  // The selected project's referenced Dockerfiles / .env files, straight from
  // the preloaded cache — stable, so the sidebar menu never flickers.
  const visibleProjectFiles = filesByProject[selected?.name ?? ''] ?? EMPTY_FILES

  // Open the Dockerfile referenced on a `dockerfile:` line as a tab
  const handleOpenDockerfileRef = (raw: string) => {
    const v = raw.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
    if (!v) return
    const rel = refRelFrom('.', v)
    const match = visibleProjectFiles.find(pf =>
      pf.kind === 'dockerfile' && dockerfileMatchesRefs(pf.path, [rel], composeDirName)
    )
    if (match) {
      setActiveFile(match.path); setEditMode(false); loadExtraFile(match.path)
      return
    }
    // Fallback — resolve relative to the compose dir (preserve case) and open
    if (!composeBaseDir || !selected) return
    const sep = composeBaseDir.includes('\\') ? '\\' : '/'
    const abs = `${composeBaseDir.replace(/[/\\]+$/, '')}${sep}${v.replace(/^\.\//, '').replace(/\//g, sep)}`
    setFilesByProject(prev => {
      const cur = prev[selected.name] ?? []
      if (cur.some(p => p.path === abs)) return prev
      return { ...prev, [selected.name]: [...cur, { path: abs, kind: 'dockerfile' }] }
    })
    setActiveFile(abs); setEditMode(false); loadExtraFile(abs)
  }

  // ── Sidebar file menu integration (files live in the sidebar, not as tabs) ──

  const composeFileSelect = useAppStore(s => s.composeFileSelect)

  // Open a file by path — handles both config files and detected extra files.
  // Re-selecting the active file is a no-op unless it failed to load, in which
  // case clicking it again retries.
  const openFile = (path: string) => {
    if (!path || (path === activeFile && !fileError)) return
    setActiveFile(path)
    setEditMode(false)
    setBackupMsg(null)
    if (selected?.config_files.includes(path)) loadFile(path)
    else loadExtraFile(path)
  }

  // Publish the active project's files so the sidebar can render them as a menu
  useEffect(() => {
    if (viewMode !== 'project' || !selected) {
      useAppStore.getState().setComposeFilesNav([])
      return
    }
    useAppStore.getState().setComposeFilesNav(buildFileNav(selected, visibleProjectFiles))
  }, [viewMode, selected, visibleProjectFiles])

  // Publish which file is active so the sidebar can highlight it
  useEffect(() => {
    useAppStore.getState().setComposeActiveFilePath(viewMode === 'project' ? (activeFile || null) : null)
  }, [viewMode, activeFile])

  // React to a sidebar file click
  useEffect(() => {
    if (!composeFileSelect) return
    useAppStore.getState().setComposeFileSelect(null)
    openFile(composeFileSelect)
  }, [composeFileSelect]) // eslint-disable-line

  // (envFilePath no longer used — .env is now a detected first-class tab)

  // ── File type from active file path ──────────────────────────────────────

  const fileType = useMemo((): 'compose' | 'env' | 'dockerfile' => {
    const name = activeFile.split('/').pop()?.split('\\').pop() ?? ''
    if (name === '.env' || name.startsWith('.env.')) return 'env'
    if (name === 'Dockerfile' || name.startsWith('Dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
    return 'compose'
  }, [activeFile])

  // ── Project file detection (cached + preloaded) ──────────────────────────
  // Detect a project's extra files and filter to the Dockerfiles its compose
  // file references, then cache the result. Skips work if already cached. On
  // failure (e.g. WSL busy) it leaves the entry uncached so a later select
  // retries, rather than caching an empty menu.
  const ensureProjectFiles = async (project: ComposeProject, force = false) => {
    if (detectingRef.current.has(project.name)) return
    if (!force && filesByProject[project.name] !== undefined) return
    const firstConfig = project.config_files[0] ?? ''
    if (!firstConfig) { setFilesByProject(prev => ({ ...prev, [project.name]: [] })); return }
    detectingRef.current.add(project.name)
    try {
      const dirName = dirNameOf(firstConfig)
      const detected    = await api.detectComposeProjectFiles(firstConfig)
      const composeText = await api.readFileContent(firstConfig)
      const refs = parseDockerfileRefs(composeText)
      const visible = detected.filter(pf =>
        pf.kind !== 'dockerfile' || dockerfileMatchesRefs(pf.path, refs, dirName)
      )
      setFilesByProject(prev => ({ ...prev, [project.name]: visible }))
    } catch {
      /* leave uncached — a later select will retry */
    } finally {
      detectingRef.current.delete(project.name)
    }
  }

  // ── Load projects ─────────────────────────────────────────────────────────

  const loadProjects = async (): Promise<ComposeProject[]> => {
    setLoading(true); setError(null)
    try {
      const live = await api.dockerComposeLs()
      // Remember the live projects, then re-add any remembered project that is
      // currently down (gone from `docker compose ls`) as a stopped entry, so
      // the user can still see and start it.
      useAppStore.getState().rememberComposeProjects(
        live.map(p => ({ name: p.name, config_files: p.config_files }))
      )
      const liveNames = new Set(live.map(p => p.name))
      const down: ComposeProject[] = Object.entries(useAppStore.getState().knownComposeProjects)
        .filter(([name]) => !liveNames.has(name))
        .map(([name, config_files]) => ({ name, status: '', config_files }))
      const all = [...live, ...down]
      setProjects(all)
      return all
    }
    catch (e) { setError(String(e)); return [] }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProjects() }, [refreshTick]) // eslint-disable-line

  // Preload every project's file menu so opening one shows its Dockerfiles and
  // .env files instantly. Done one project at a time so we never spawn a burst
  // of concurrent `wsl` reads (which can fail, especially during WSL cold-start).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      for (const p of projects) {
        if (cancelled) break
        await ensureProjectFiles(p)
      }
    })()
    return () => { cancelled = true }
  }, [projects]) // eslint-disable-line

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
      if (target) selectProject(target)
      // Don't auto-select first project on initial load — show overview instead
    }
  }, [projects, composePreselect]) // eslint-disable-line

  // ── Project selection ─────────────────────────────────────────────────────

  const selectProject = (project: ComposeProject) => {
    setViewMode('project')
    useAppStore.getState().setComposeActiveProject(project.name)
    // Re-selecting the project that's already open must not tear down and reload
    // content that is already on screen — that re-render is the visible flicker.
    if (selected?.name === project.name) return

    // Publish the new project's file menu in the same render as setSelected, from
    // the preloaded cache, so the sidebar never shows an empty or stale menu.
    useAppStore.getState().setComposeFilesNav(buildFileNav(project, filesByProject[project.name] ?? EMPTY_FILES))
    setSelected(project)
    setFileContent(null)
    setFileError(null)
    setBackupMsg(null)
    setEditMode(false)
    setInspectContainer(null)
    useAppStore.getState().closeComposeLogs() // drop stale logs from the previous project
    setValidatorOpen(false)
    setMetaPanelOpen(false)
    setFileContents({})
    ensureProjectFiles(project) // refresh the cache if this project was not preloaded
    const first = project.config_files[0] ?? ''
    setActiveFile(first)
    if (first) loadFile(first)
    if (backupDir) loadComposeBackups(project.name)
    // Record recent_opened in metadata
    const now = new Date().toISOString()
    const current = metadata[project.name] ?? emptyMeta()
    const updated = { ...current, recent_opened: now }
    setMetadata(prev => ({ ...prev, [project.name]: updated }))
    api.metadataSaveProject(project.name, updated).catch(() => {})
  }

  const handleMetaChange = (name: string, meta: AppProjectMeta) => {
    setMetadata(prev => ({ ...prev, [name]: meta }))
    api.metadataSaveProject(name, meta).catch(() => {})
  }

  // Drop a stopped project from the remembered list and return to the overview.
  const handleForgetProject = () => {
    if (!selected) return
    useAppStore.getState().forgetComposeProject(selected.name)
    useAppStore.getState().setComposeActiveProject(null)
    setViewMode('main')
    loadProjects()
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
          // Merge from the freshest metadata (functional update), not the value
          // captured when the action started — the user may have edited tags or
          // notes during the up-to-5-minute poll, and reading the stale copy here
          // would write those edits back out.
          let toSave: AppProjectMeta | null = null
          setMetadata(prev => {
            const currentMeta = prev[projectName] ?? emptyMeta()
            toSave = { ...currentMeta, startup_times: [...(currentMeta.startup_times ?? []).slice(-9), elapsed] }
            return { ...prev, [projectName]: toSave }
          })
          if (toSave) api.metadataSaveProject(projectName, toSave).catch(() => {})
          return
        }
      } catch { break }
    }
  }

  // ── Inline editor (handles compose + Dockerfile; .env edits live in its tab) ─

  // Content being edited: compose uses fileContent; other text files use the cache.
  const editableContent = fileType === 'compose' ? (fileContent ?? '') : (fileContents[activeFile] ?? '')
  const fileLoaded      = fileType === 'compose' ? fileContent !== null : fileContents[activeFile] !== undefined
  const isEditableType  = fileType === 'compose' || fileType === 'dockerfile'
  // Drop the file's trailing newline for editing so the editor shows the same
  // line count as the read-only viewer (which also hides it). Re-added on save.
  const editBaseline = editableContent.replace(/\n$/, '')
  const isModified = editMode && editDraft !== editBaseline

  const enterEditMode = () => {
    setEditDraft(editBaseline)
    setEditMode(true)
  }

  const cancelEdit = () => {
    setEditMode(false)
  }

  const handleSave = async () => {
    if (!activeFile || editSaving) return
    setEditSaving(true)
    try {
      // Re-add the trailing newline that was dropped for editing, if the file
      // had one, so saving doesn't strip the file's final newline.
      const toWrite = editableContent.endsWith('\n') ? editDraft + '\n' : editDraft
      await api.writeFileContent(activeFile, toWrite)
      if (fileType === 'compose') {
        setFileContent(toWrite)
        if (selected) ensureProjectFiles(selected, true) // build refs may have changed
      } else {
        setFileContents(prev => ({ ...prev, [activeFile]: toWrite }))
      }
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
    try {
      await runWithDockerLog(`─── docker compose ${action} ${service} ───`, () =>
        api.dockerComposeServiceAction(activeFile, action, service))
    } finally {
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
    try {
      await runWithDockerLog('─── docker compose down -v ───', () =>
        api.dockerComposeAction(activeFile, 'down-volumes'))
    } finally {
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
    const actionDef = LIFECYCLE_ACTIONS.find(a => a.id === action)!
    const startMs = Date.now()
    try {
      const { success } = await runWithDockerLog(`─── ${actionDef.title} ───`, () =>
        api.dockerComposeAction(activeFile, action))
      // Kick off startup time tracking for Up/Rebuild actions
      if (success && (action === 'up' || action === 'rebuild') && selected) {
        recordStartupTime(selected.name, startMs)
      }
    } finally {
      setLifecycleRunning(null)
      // Refresh project list and container states to reflect updated status
      onRefresh?.()
      const list = await loadProjects()
      if (selected) {
        const updated = list.find(p => p.name === selected.name)
        if (updated) setSelected(updated)
      }
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
    const actionMap = { up: 'docker compose up -d', down: 'docker compose down', restart: 'docker compose restart' }
    const configFile = project.config_files[0] ?? ''
    try {
      await runWithDockerLog(`─── ${actionMap[action]} (${project.name}) ───`, () =>
        api.dockerComposeAction(configFile, action))
    } finally {
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
          metadata={metadata}
          onMetaChange={handleMetaChange}
          onSelectProject={selectProject}
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

          {/* ── Top bar: project identity + ports + lifecycle ── */}
          <div className="compose-project-topbar">
            <button
              className="compose-back-btn compose-back-btn--icon"
              onClick={() => { setViewMode('main'); useAppStore.getState().setComposeActiveProject(null) }}
              title="Back to all projects"
              aria-label="Back to all projects"
            >
              <ArrowLeft size={14} />
            </button>

            <div className="compose-proj-id">
              <span className={clsx('compose-proj-status-dot', `compose-proj-status-dot--${projState}`)} />
              <h2 className="compose-proj-name" title={selected.name}>{selected.name}</h2>
              {totalCount > 0 && (
                <span className={clsx('compose-proj-health', `compose-proj-health--${projState}`)}>
                  {runningCount}/{totalCount} running
                </span>
              )}
            </div>

            {headerPorts.length > 0 && (
              <div className="compose-proj-ports">
                {headerPorts.map(port => (
                  <button
                    key={port}
                    className="compose-port-chip"
                    onClick={() => openUrl(`http://localhost:${port}`).catch(() => {})}
                    title={`Open http://localhost:${port}`}
                  >
                    <Plug size={9} />{port}<ExternalLink size={8} />
                  </button>
                ))}
              </div>
            )}

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
                    className={clsx('compose-lifecycle-btn',
                      id === 'up' && runningCount === 0 ? 'compose-lifecycle-btn--primary' : `compose-lifecycle-btn--${color}`,
                      lifecycleRunning === id && 'loading')}
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

              {/* Active-file label + edit controls (files are picked in the sidebar) */}
              <div className="compose-left-header">
                <div className="compose-active-file" title={activeFile}>
                  {fileType === 'dockerfile'
                    ? <FileCode2 size={12} style={{ color: '#60a5fa', flexShrink: 0 }} />
                    : fileType === 'env'
                      ? <FileKey size={12} style={{ color: '#f0a500', flexShrink: 0 }} />
                      : <PathOriginLine path={activeFile} />}
                  <span className="compose-active-file-name">{relLabel(activeFile, composeBaseDir)}</span>
                  {isModified && <span className="compose-modified-dot" title="Unsaved changes" />}
                </div>
                <div className="compose-edit-controls">
                  {isEditableType && (editMode ? (
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
                    <button className="compose-edit-btn" onClick={enterEditMode} disabled={!fileLoaded || !!lifecycleRunning} title="Edit file">
                      <Pencil size={11} /> Edit
                    </button>
                  ))}
                  <button className="compose-edit-btn compose-open-ide-btn" onClick={handleOpenInIde} disabled={!activeFile}
                    title={preferredEditor ? `Open in ${preferredEditor.name}` : 'Open in editor'}>
                    <OpenIdeIcon size={11} />
                    {preferredEditor ? preferredEditor.name : 'Open in'}
                  </button>
                  <button className="compose-edit-btn" onClick={() => activeFile &&
                      api.revealPath(activeFile).catch(e => useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error'))}
                    disabled={!activeFile} title="Open file location in Explorer">
                    <FolderOpen size={11} /> Reveal
                  </button>
                </div>
              </div>

              {/* File content */}
              <div className="compose-viewer-body">
                {fileLoading && <div className="compose-viewer-state">Loading file…</div>}
                {fileError && <div className="compose-viewer-state compose-viewer-error"><AlertCircle size={14} />{fileError}</div>}
                {!fileLoading && fileType === 'compose' && fileContent !== null && !editMode && (
                  <YamlViewer key={activeFile} content={fileContent} onOpenPort={handleOpenPort} onRevealPath={handleRevealPath}
                    onOpenDockerfile={handleOpenDockerfileRef}
                    initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                )}
                {!fileLoading && fileType === 'compose' && editMode && (
                  <YamlEditor key={activeFile} value={editDraft} onChange={setEditDraft}
                    initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                )}
                {fileType === 'env' && activeFile && (
                  fileContents[activeFile] !== undefined
                    ? <ComposeEnvTab filePath={activeFile} content={fileContents[activeFile]} yamlContent={fileContent ?? ''}
                        onSaved={newContent => setFileContents(prev => ({ ...prev, [activeFile]: newContent }))} />
                    : <div className="compose-viewer-state">Loading…</div>
                )}
                {fileType === 'dockerfile' && activeFile && (
                  fileContents[activeFile] === undefined
                    ? <div className="compose-viewer-state">Loading…</div>
                    : editMode
                      ? <CodeOverlayEditor key={activeFile} value={editDraft} onChange={setEditDraft}
                          renderLine={(l, i) => <DockerfileLine key={i} line={l} />}
                          initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                      : <ComposeDockerfileViewer key={activeFile} content={fileContents[activeFile]}
                          initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                )}
              </div>
            </div>

            {/* ── RIGHT: Sidebar ── */}
            <div className="compose-project-right">

              {/* Services */}
              {projectContainers.length > 0 && (
                <div className="compose-right-section">
                  <div className="compose-right-section-title">
                    <span>Services</span>
                    <span className="compose-section-count">{runningCount}/{totalCount}</span>
                  </div>
                  <ServiceCards
                    containers={projectContainers}
                    serviceAction={serviceAction}
                    onServiceAction={handleServiceAction}
                    onOpenLogs={svc => openLogs(svc)}
                    onShell={handleShell}
                    onInspect={setInspectContainer}
                  />
                </div>
              )}

              {/* Actions */}
              <div className="compose-right-section">
                <div className="compose-right-section-title">Actions</div>
                <div className="compose-sidebar-tools">
                  <button
                    className={clsx('compose-sidebar-tool-btn',
                      terminalTab === 'logs' && composeLogContext?.project.name === selected.name && 'active')}
                    onClick={() => openLogs(null)} title="Stream logs in the terminal panel">
                    <ScrollText size={13} />
                    <span className="compose-sidebar-tool-label">Logs</span>
                    <ExternalLink size={11} className="compose-sidebar-tool-chevron" />
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
                  {/* Only meaningful for a project that is down (no containers) — it is
                      kept in the list from memory and can be dropped from it here. */}
                  {projectContainers.length === 0 && (
                    <button className="compose-sidebar-tool-btn" onClick={handleForgetProject}
                      title="Remove this stopped project from the list">
                      <Trash2 size={13} />
                      <span className="compose-sidebar-tool-label">Remove from list</span>
                    </button>
                  )}
                </div>
              </div>

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
                const meta = metadata[selected.name] ?? emptyMeta()
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
        <ModalOverlay onClose={() => setIdePickerOpen(false)} className="compose-modal-backdrop" labelledBy="ide-picker-title">
          <div className="compose-modal-box" style={{ maxWidth: 340 }}>
            <h3 className="compose-modal-title" id="ide-picker-title">Open in Editor</h3>
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
        </ModalOverlay>
      )}
    </div>
  )
}
