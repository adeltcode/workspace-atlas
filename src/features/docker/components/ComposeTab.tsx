import { useEffect, useState, useMemo, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { revealItemInDir, openUrl } from '@tauri-apps/plugin-opener'
import {
  Download, AlertCircle, FolderOpen, Trash2, Monitor, Terminal,
  ChevronDown, Play, Square, RotateCcw, Wrench, FileKey, ExternalLink, ArrowLeft, Plug,
  Pencil, Save, X, Info, RotateCcw as RestartIcon,
  ExternalLink as OpenIdeIcon, CheckCircle, MoreHorizontal, FileCode2, ScrollText,
} from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import ModalShell from '../../../components/ModalShell'
import { useAppStore } from '../../../store/appStore'
import { emptyMeta, type ComposeProject, type ComposeBackupEntry, type DockerContainer, type ContainerStats, type AppProjectMeta, type DetectedFile, type EditorInfo } from '../types'
import { bytesToHuman, formatDate, hostPorts } from '../../../utils/format'
import ComposePage from './ComposePage'
import ComposeEnvTab from './ComposeEnvTab'
import { DockerfileLine } from './ComposeDockerfileViewer'
import YamlLine from './YamlLine'
import { buildFileNav, dirNameOf, dirOf, dockerfileMatchesRefs, EMPTY_FILES, parseDockerfileRefs, refRelFrom, relLabel } from './composeFiles'
import CodeViewer from './CodeViewer'
import CodeOverlayEditor from './CodeOverlayEditor'
import { ErrorBanner } from '../../../components/ui'

/** Runs a Compose command with its output in the terminal, and says whether it worked. */
async function runStreamed(title: string, run: () => Promise<unknown>): Promise<boolean> {
  const { addTerminalLine, setTerminalOpen } = useAppStore.getState()
  setTerminalOpen(true)
  addTerminalLine(`─── ${title} ───`, 'info')
  const unlisten = await listen<string>('docker-log', e => {
    const type = e.payload.startsWith('$') ? 'cmd' : e.payload.startsWith('[err]') ? 'stderr' : 'stdout'
    addTerminalLine(e.payload, type)
  })
  try {
    await run()
    addTerminalLine('─── Done ───', 'success')
    return true
  } catch (e) {
    addTerminalLine(`  ✗ ${String(e)}`, 'error')
    return false
  } finally {
    unlisten()
  }
}

function runningHostPorts(containers: DockerContainer[]): string[] {
  return [...new Set(containers.filter(c => c.state === 'running' && c.ports).flatMap(c => hostPorts(c.ports)))]
}

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

const LIFECYCLE_ACTIONS = [
  { id: 'up',      Icon: Play,      label: 'Up',      title: 'docker compose up -d',         color: 'success' },
  { id: 'down',    Icon: Square,    label: 'Down',    title: 'docker compose down',           color: 'danger'  },
  { id: 'restart', Icon: RotateCcw, label: 'Restart', title: 'docker compose restart',       color: 'default' },
  { id: 'rebuild', Icon: Wrench,    label: 'Rebuild', title: 'docker compose up -d --build', color: 'warning' },
] as const

type LifecycleAction = typeof LIFECYCLE_ACTIONS[number]['id']

function InspectDrawer({ container, onClose }: { container: DockerContainer; onClose: () => void }) {
  const ports = hostPorts(container.ports)

  return (
    <ModalShell className="compose-inspect-overlay" label={`Inspect ${container.compose_service ?? container.name}`} onClose={onClose}>
      <div className="compose-inspect-drawer">
        <div className="compose-inspect-header">
          <span className="compose-inspect-title">
            {container.compose_service ?? container.name}
          </span>
          <button className="compose-inspect-close" onClick={onClose} aria-label="Close inspection"><X size={13} /></button>
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
          <dt>Created</dt>
          <dd>{container.created_since}</dd>
        </dl>
      </div>
    </ModalShell>
  )
}

function WipeConfirmModal({ projectName, onConfirm, onCancel, running }: {
  projectName: string; onConfirm: () => void; onCancel: () => void; running: boolean
}) {
  const [confirmText, setConfirmText] = useState('')
  return (
    // Not dismissable while the wipe is running: closing mid-run would hide a
    // destructive operation the user can no longer follow.
    <ModalShell
      className="compose-modal-backdrop"
      label={`Wipe volumes for "${projectName}"?`}
      onClose={running ? undefined : onCancel}
      closeOnBackdrop={!running}
    >
      <div className="compose-modal-box">
        <h3 className="compose-modal-title">Wipe volumes for "{projectName}"?</h3>
        <p className="compose-modal-body">
          This permanently deletes all named volumes for this project, including database
          data, and runs <code>docker compose down -v</code>. This cannot be undone.
          Type <strong>{projectName}</strong> to confirm.
        </p>
        <input
          className="modal-input"
          type="text"
          aria-label={`Type ${projectName} to confirm`}
          placeholder={projectName}
          spellCheck={false}
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          disabled={running}
        />
        <div className="compose-modal-actions">
          <button className="btn-refresh" onClick={onCancel} disabled={running}>Cancel</button>
          <button
            className="compose-modal-btn-danger"
            onClick={onConfirm}
            disabled={running || confirmText.trim() !== projectName}
          >
            {running ? <RotateCcw size={11} className="spin" /> : <Trash2 size={11} />}
            {running ? 'Running…' : 'Down and wipe volumes'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

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

  const [viewMode, setViewMode] = useState<'main' | 'project'>('main')

  const [metadata, setMetadata] = useState<Record<string, AppProjectMeta>>({})

  const [projects, setProjects]           = useState<ComposeProject[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [selected, setSelected]           = useState<ComposeProject | null>(null)
  const [activeFile, setActiveFile]       = useState('')
  const [fileContent, setFileContent]     = useState<string | null>(null)
  const [fileLoading, setFileLoading]     = useState(false)
  const [fileError, setFileError]         = useState<string | null>(null)
  // Only the newest read may update the viewer, so a slow read of one file cannot appear under another.
  const fileRequest = useRef(0)
  const [composeBackups, setComposeBackups] = useState<ComposeBackupEntry[]>([])
  const [deletingFile, setDeletingFile]     = useState<string | null>(null)
  const [backupOpen, setBackupOpen]         = useState(false)
  const [backingUp, setBackingUp]           = useState(false)
  const [backupMsg, setBackupMsg]           = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const [lifecycleRunning, setLifecycleRunning] = useState<LifecycleAction | null>(null)
  const [cardLifecycle, setCardLifecycle] = useState<{ project: string; action: string } | null>(null)

  const [editing, setEditMode]     = useState(false)
  const storedDraft = useAppStore(s => s.editorDrafts[activeFile])
  const [editSaving, setEditSaving] = useState(false)
  const scrollByFile = useRef<Record<string, number>>({})
  const rememberScroll = (top: number) => { scrollByFile.current[activeFile] = top }

  const [serviceAction, setServiceAction] = useState<{ service: string; action: string } | null>(null)
  const [inspectContainer, setInspectContainer] = useState<DockerContainer | null>(null)

  const [downDropOpen, setDownDropOpen]     = useState(false)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)
  const [wipeRunning, setWipeRunning]         = useState(false)

  // Detected Dockerfiles and .env files the compose file references, cached per project.
  const [filesByProject, setFilesByProject] = useState<Record<string, DetectedFile[]>>({})
  // Projects whose detection is in flight, so it never runs twice at once for one project.
  const detectingRef = useRef<Set<string>>(new Set())
  const [fileContents, setFileContents] = useState<Record<string, string>>({})

  const preferredEditor = useAppStore(s => s.preferredEditor)
  const setPreferredEditor = useAppStore(s => s.setPreferredEditor)
  const [idePickerOpen, setIdePickerOpen] = useState(false)
  const [detectedEditors, setDetectedEditors] = useState<EditorInfo[]>([])

  const [metaPanelOpen, setMetaPanelOpen] = useState(false)
  const [metaTagInput, setMetaTagInput]   = useState('')

  const [validatorOpen,    setValidatorOpen]    = useState(false)
  const [validatorRunning, setValidatorRunning] = useState(false)
  const [validatorResult,  setValidatorResult]  = useState<{ yaml?: string; error?: string } | null>(null)

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

  const projectDir = useMemo(() => {
    if (!activeFile) return ''
    const i = Math.max(activeFile.lastIndexOf('/'), activeFile.lastIndexOf('\\'))
    return i >= 0 ? activeFile.slice(0, i) : ''
  }, [activeFile])

  const projectContainers = useMemo(
    () => selected ? containers.filter(c => c.compose_project === selected.name) : [],
    [containers, selected]
  )

  const runningCount = projectContainers.filter(c => c.state === 'running').length
  const totalCount   = projectContainers.length
  const projState: 'none' | 'running' | 'partial' | 'stopped' =
    totalCount === 0     ? 'none'
    : runningCount === 0 ? 'stopped'
    : runningCount === totalCount ? 'running'
    : 'partial'
  const headerPorts = useMemo(() => runningHostPorts(projectContainers).slice(0, 6), [projectContainers])

  const composeBaseDir = useMemo(() => dirOf(selected?.config_files[0] ?? ''), [selected])
  const composeDirName = useMemo(() => dirNameOf(selected?.config_files[0] ?? ''), [selected])

  const visibleProjectFiles = filesByProject[selected?.name ?? ''] ?? EMPTY_FILES

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
    // Fallback: resolve relative to the compose dir, preserving case.
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

  // Re-selecting the active file is a no-op unless it failed to load. Then clicking it again retries.
  const openFile = (path: string) => {
    if (!path || (path === activeFile && !fileError)) return
    setActiveFile(path)
    setEditMode(false)
    setBackupMsg(null)
    if (selected?.config_files.includes(path)) loadFile(path)
    else loadExtraFile(path)
  }

  useEffect(() => {
    useAppStore.getState().setComposeActiveFilePath(viewMode === 'project' ? (activeFile || null) : null)
  }, [viewMode, activeFile])

  const fileType = useMemo((): 'compose' | 'env' | 'dockerfile' => {
    const name = activeFile.split('/').pop()?.split('\\').pop() ?? ''
    if (name === '.env' || name.startsWith('.env.')) return 'env'
    if (name === 'Dockerfile' || name.startsWith('Dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
    return 'compose'
  }, [activeFile])

  // On failure (e.g. WSL busy) the entry stays uncached, so a later select retries rather than
  // caching an empty list.
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
      /* leave uncached - a later select will retry */
    } finally {
      detectingRef.current.delete(project.name)
    }
  }

  const loadProjects = async () => {
    setLoading(projects.length === 0); setError(null)
    try {
      const live = await api.dockerComposeLs()
      // A project that is down drops out of `docker compose ls`, so re-add remembered ones as stopped
      // entries the user can still see and start.
      useAppStore.getState().rememberComposeProjects(
        live.map(p => ({ name: p.name, config_files: p.config_files }))
      )
      const liveNames = new Set(live.map(p => p.name))
      const down: ComposeProject[] = Object.entries(useAppStore.getState().knownComposeProjects)
        .filter(([name]) => !liveNames.has(name))
        .map(([name, config_files]) => ({ name, status: '', config_files }))
      setProjects([...live, ...down])
    }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { loadProjects() }, [refreshTick]) // eslint-disable-line

  useEffect(() => {
    api.metadataLoad().then(setMetadata).catch(() => {})
  }, [])

  useEffect(() => {
    api.detectEditors().then(setDetectedEditors).catch(() => {})
  }, [])

  useEffect(() => {
    useAppStore.getState().setComposeProjectsNav(
      projects.map(p => ({ name: p.name, status: p.status }))
    )
  }, [projects])

  // Also runs when composePreselect changes, so sidebar clicks work while the compose tab is mounted.

  const composePreselect = useAppStore(s => s.composePreselect)

  useEffect(() => {
    if (projects.length === 0) return
    if (composePreselect) {
      useAppStore.getState().setComposePreselect(null)
      const target = projects.find(p => p.name === composePreselect)
      if (target) selectProject(target)
    }
  }, [projects, composePreselect]) // eslint-disable-line

  const selectProject = (project: ComposeProject) => {
    setViewMode('project')
    useAppStore.getState().setComposeActiveProject(project.name)
    // Re-selecting the open project must not reload content already on screen: that causes a visible flicker.
    if (selected?.name === project.name) return

    setSelected(project)
    fileRequest.current++
    setFileLoading(false)
    setFileContent(null)
    setFileError(null)
    setBackupMsg(null)
    setEditMode(false)
    setInspectContainer(null)
    useAppStore.getState().closeComposeLogs()
    setValidatorOpen(false)
    setMetaPanelOpen(false)
    setFileContents({})
    ensureProjectFiles(project)
    const first = project.config_files[0] ?? ''
    setActiveFile(first)
    if (first) loadFile(first)
    if (backupDir) loadComposeBackups(project.name)
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

  const handleForgetProject = () => {
    if (!selected) return
    useAppStore.getState().forgetComposeProject(selected.name)
    useAppStore.getState().setComposeActiveProject(null)
    setViewMode('main')
    loadProjects()
  }

  const loadExtraFile = async (path: string) => {
    const request = ++fileRequest.current
    setFileLoading(false); setFileError(null)
    if (fileContents[path] !== undefined) return
    try {
      const content = await api.readFileContent(path)
      setFileContents(prev => ({ ...prev, [path]: content }))
    } catch (e) {
      if (request === fileRequest.current) setFileError(String(e))
    }
  }

  const handleOpenInIde = async () => {
    if (!activeFile) return
    if (preferredEditor) {
      await api.openInEditor(activeFile, preferredEditor.command).catch(e =>
        useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error')
      )
    } else {
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

  const recordStartupTime = async (projectName: string, startMs: number) => {
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        const ctrs = await api.dockerContainers()
        const projectCtrs = ctrs.filter(c => c.compose_project === projectName)
        if (projectCtrs.length > 0 && projectCtrs.every(c => c.state === 'running')) {
          const elapsed = Date.now() - startMs
          // Read what is saved now: tags or notes may have changed during this wait.
          const currentMeta = (await api.metadataLoad())[projectName] ?? emptyMeta()
          const updated = { ...currentMeta, startup_times: [...(currentMeta.startup_times ?? []).slice(-9), elapsed] }
          setMetadata(prev => ({ ...prev, [projectName]: updated }))
          api.metadataSaveProject(projectName, updated).catch(() => {})
          return
        }
      } catch { break }
    }
  }

  const editableContent = fileType === 'compose' ? (fileContent ?? '') : (fileContents[activeFile] ?? '')
  const fileLoaded      = fileType === 'compose' ? fileContent !== null : fileContents[activeFile] !== undefined
  const isEditableType  = fileType === 'compose' || fileType === 'dockerfile'
  // Drop the file's trailing newline for editing so the editor shows the same
  // line count as the read-only viewer (which also hides it). Re-added on save.
  const editBaseline = editableContent.replace(/\n$/, '')
  const editMode = editing || storedDraft !== undefined
  const editDraft = storedDraft ?? editBaseline
  const setEditDraft = (content: string) => useAppStore.getState().setEditorDraft(activeFile, content)
  const isModified = editMode && editDraft !== editBaseline

  const enterEditMode = () => {
    setEditMode(true)
  }

  const cancelEdit = () => {
    useAppStore.getState().clearEditorDraft(activeFile)
    setEditMode(false)
  }

  const handleSave = async () => {
    if (!activeFile || editSaving) return
    setEditSaving(true)
    try {
      // Re-add the trailing newline dropped for editing, if the file had one.
      const toWrite = editableContent.endsWith('\n') ? editDraft + '\n' : editDraft
      await api.writeFileContent(activeFile, toWrite)
      useAppStore.getState().clearEditorDraft(activeFile, editDraft)
      if (useAppStore.getState().composeActiveFilePath !== activeFile) return
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

  const handleServiceAction = async (service: string, action: 'up' | 'stop' | 'restart') => {
    if (!activeFile || serviceAction) return
    setServiceAction({ service, action })
    await runStreamed(`docker compose ${action} ${service}`, () => api.dockerComposeServiceAction(activeFile, action, service))
    setServiceAction(null)
    loadProjects()
    onRefresh?.()
  }

  const handleShell = async (containerName: string) => {
    try {
      await api.openContainerShell(containerName)
    } catch (e) {
      useAppStore.getState().addTerminalLine(`  ✗ Shell failed: ${String(e)}`, 'error')
    }
  }

  const handleWipeDown = async () => {
    if (!activeFile || wipeRunning) return
    setWipeRunning(true)
    await runStreamed('docker compose down -v', () => api.dockerComposeAction(activeFile, 'down-volumes'))
    setWipeRunning(false)
    setWipeConfirmOpen(false)
    loadProjects()
  }

  const loadFile = async (path: string) => {
    if (!path) return
    const request = ++fileRequest.current
    setFileLoading(true); setFileError(null); setFileContent(null)
    try {
      const content = await api.readFileContent(path)
      if (request === fileRequest.current) setFileContent(content)
    } catch (e) {
      if (request === fileRequest.current) setFileError(String(e))
    } finally {
      if (request === fileRequest.current) setFileLoading(false)
    }
  }

  const handleOpenPort = (port: string) => {
    openUrl(`http://localhost:${port}`).catch(() => {})
  }

  const handleRevealPath = (rel: string) => {
    if (!projectDir) return
    const sep = activeFile.includes('/') ? '/' : '\\'
    const abs = `${projectDir}${sep}${rel.replace(/^\.\//, '').replace(/^\.\.\//, '../')}`
    revealItemInDir(abs).catch(() => {})
  }

  const runComposeAction = async (action: LifecycleAction) => {
    if (!activeFile || lifecycleRunning) return
    setLifecycleRunning(action)
    const actionDef = LIFECYCLE_ACTIONS.find(a => a.id === action)!
    const startMs = Date.now()
    const ok = await runStreamed(actionDef.title, () => api.dockerComposeAction(activeFile, action))
    if (ok && (action === 'up' || action === 'rebuild') && selected) recordStartupTime(selected.name, startMs)
    setLifecycleRunning(null)
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

  const runBackup = async () => {
    if (!selected || !backupDir) return
    setBackingUp(true)
    setBackupMsg(null)
    const { addTerminalLine } = useAppStore.getState()
    try {
      const saved = await api.dockerBackupCompose(selected.name, selected.config_files, backupDir)
      if (saved.length === 0) {
        addTerminalLine(`  → already up to date`, 'info')
        setBackupMsg({ type: 'info', text: 'Already up to date. There are no changes to back up.' })
      } else {
        setBackupMsg({ type: 'success', text: `${saved.length} file${saved.length !== 1 ? 's' : ''} backed up` })
        await loadComposeBackups(selected.name)
      }
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setBackupMsg({ type: 'error', text: String(e) })
    } finally { setBackingUp(false) }
  }

  const runCardLifecycle = async (project: ComposeProject, action: 'up' | 'down' | 'restart') => {
    if (cardLifecycle) return
    setCardLifecycle({ project: project.name, action })
    const actionMap = { up: 'docker compose up -d', down: 'docker compose down', restart: 'docker compose restart' }
    const configFile = project.config_files[0] ?? ''
    await runStreamed(`${actionMap[action]} (${project.name})`, () => api.dockerComposeAction(configFile, action))
    setCardLifecycle(null)
    loadProjects()
  }

  return (
    <div className="compose-tab">
      {error && (
        <ErrorBanner className="error-banner--bleed" error={error} />
      )}

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

      {viewMode === 'project' && selected && (
        <div className="compose-viewer">

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
                            <Trash2 size={11} /> Down and wipe volumes
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

          <div className="compose-project-layout">

            <div className="compose-project-left">

              {selected && (() => {
                const files = buildFileNav(selected, visibleProjectFiles)
                return files.length > 1 && (
                  <div className="compose-file-tabs" role="group" aria-label="Project files">
                    {files.map(f => (
                      <button
                        key={f.path}
                        className={clsx('compose-file-path-item', f.path === activeFile && 'active')}
                        onClick={() => openFile(f.path)}
                        title={f.path}
                        aria-current={f.path === activeFile ? 'true' : undefined}
                      >
                        {f.kind === 'dockerfile' && <FileCode2 size={11} style={{ color: 'var(--chart-4)', flexShrink: 0 }} />}
                        {f.kind === 'env' && <FileKey size={11} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />}
                        <span className="compose-file-path-text"><bdi>{f.label}</bdi></span>
                      </button>
                    ))}
                  </div>
                )
              })()}

              <div className="compose-left-header">
                <div className="compose-active-file" title={activeFile}>
                  {fileType === 'dockerfile'
                    ? <FileCode2 size={12} style={{ color: 'var(--chart-4)', flexShrink: 0 }} />
                    : fileType === 'env'
                      ? <FileKey size={12} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
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
                    {preferredEditor ? preferredEditor.name : 'Open in editor'}
                  </button>
                  <button className="compose-edit-btn" onClick={() => activeFile &&
                      api.revealPath(activeFile).catch(e => useAppStore.getState().addTerminalLine(`  ✗ ${String(e)}`, 'error'))}
                    disabled={!activeFile} title="Show in Explorer">
                    <FolderOpen size={11} /> Show in Explorer
                  </button>
                </div>
              </div>

              <div className="compose-viewer-body">
                {fileLoading && <div className="compose-viewer-state">Loading file…</div>}
                {fileError && <div className="compose-viewer-state compose-viewer-error"><AlertCircle size={14} />{fileError}</div>}
                {!fileLoading && fileType === 'compose' && fileContent !== null && !editMode && (
                  <CodeViewer key={activeFile} content={fileContent}
                    renderLine={(line, i) => <YamlLine key={i} line={line} onOpenPort={handleOpenPort} onRevealPath={handleRevealPath} onOpenDockerfile={handleOpenDockerfileRef} />}
                    initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                )}
                {!fileLoading && fileType === 'compose' && editMode && (
                  <CodeOverlayEditor key={activeFile} label="Compose file contents" value={editDraft} onChange={setEditDraft}
                    renderLine={(line, i) => <YamlLine key={i} line={line} />}
                    initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                )}
                {fileType === 'env' && activeFile && !fileError && (
                  fileContents[activeFile] !== undefined
                    ? <ComposeEnvTab key={activeFile} filePath={activeFile} content={fileContents[activeFile]} yamlContent={fileContent ?? ''}
                        onSaved={newContent => setFileContents(prev => ({ ...prev, [activeFile]: newContent }))} />
                    : <div className="compose-viewer-state">Loading…</div>
                )}
                {fileType === 'dockerfile' && activeFile && !fileError && (
                  fileContents[activeFile] === undefined
                    ? <div className="compose-viewer-state">Loading…</div>
                    : editMode
                      ? <CodeOverlayEditor key={activeFile} label="Dockerfile contents" value={editDraft} onChange={setEditDraft}
                          renderLine={(l, i) => <DockerfileLine key={i} line={l} />}
                          initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                      : <CodeViewer key={activeFile} content={fileContents[activeFile]}
                          renderLine={(l, i) => <DockerfileLine key={i} line={l} />}
                          initialScrollTop={scrollByFile.current[activeFile] ?? 0} onScrollTop={rememberScroll} />
                )}
              </div>
            </div>

            <div className="compose-project-right">

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
                    <span className="compose-sidebar-tool-label">Validate config</span>
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
                  {/* Only meaningful for a project that is down (no containers) - it is
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
                          {meta.favorite ? '★ Favorite' : '☆ Add to favorites'}
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
                          <input className="compose-meta-tag-input" aria-label="Add tag" placeholder="Add tag…" value={metaTagInput}
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
                          placeholder="Admin URLs, setup notes, context…"
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

              {backupOpen && (
                <div className="compose-sidebar-panel">
                  <div className="compose-sidebar-panel-header">
                    <span>Backup</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {backupMsg && <span className={clsx('compose-toolbar-status', backupMsg.type)} style={{ fontSize: 10.5 }}>{backupMsg.text}</span>}
                      <button className="compose-run-backup-btn" onClick={runBackup} disabled={backingUp || !backupDir || !selected}>
                        <Download size={11} className={backingUp ? 'spin' : ''} />
                        {backingUp ? 'Backing up…' : 'Back up now'}
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
                                  <button className="ctr-action-btn" onClick={() => revealItemInDir(entry.path).catch(() => {})}
                                    title="Show in Explorer" aria-label={`Open the folder holding ${entry.filename}`}><FolderOpen size={12} /></button>
                                  <button className="ctr-action-btn ctr-action-remove" onClick={() => handleDeleteBackup(entry)}
                                    disabled={deletingFile === entry.filename} title="Delete this backup"
                                    aria-label={`Delete backup ${entry.filename}`}><Trash2 size={12} /></button>
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

      {inspectContainer && (
        <InspectDrawer container={inspectContainer} onClose={() => setInspectContainer(null)} />
      )}

      {wipeConfirmOpen && selected && (
        <WipeConfirmModal
          projectName={selected.name}
          onConfirm={handleWipeDown}
          onCancel={() => setWipeConfirmOpen(false)}
          running={wipeRunning}
        />
      )}

      {idePickerOpen && (
        <ModalShell className="compose-modal-backdrop" label="Open in editor" onClose={() => setIdePickerOpen(false)}>
          <div className="compose-modal-box" style={{ maxWidth: 340 }}>
            <h3 className="compose-modal-title">Open in editor</h3>
            <p className="compose-modal-body" style={{ marginBottom: 12 }}>
              Choose your preferred editor. Atlas uses it from now on.
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
        </ModalShell>
      )}
    </div>
  )
}
