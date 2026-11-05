import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LogEntry, DockerStatus, DockerSystemDf, DockerImage, DockerContainer, DockerVolume, ComposeProject } from '../features/docker/types'
import type { DistroMetrics } from '../features/wsl/types'
import type { SandboxDetails } from '../features/sandbox/api'
import type { TerminalLine } from '../types/terminal'

export type View      = 'dashboard' | 'docker' | 'wsl' | 'sandbox' | 'packages' | 'ports' | 'locks' | 'settings'
export type Theme     = 'dark' | 'light'
export type DockerTab = 'overview' | 'images' | 'containers' | 'volumes' | 'networks' | 'compose' | 'prune' | 'log'
export type WslView      = 'dashboard' | 'distro' | 'wslconfig' | 'install'
export type WslDistroTab = 'overview' | 'startup' | 'performance' | 'config'

export interface WslDistroNav {
  name: string
  running: boolean
  is_default: boolean
}

const MAX_DOCKER_LOGS    = 10
const MAX_TERMINAL_LINES = 500
const MAX_ACTIVITY       = 50

export type ActivityModule  = 'docker' | 'wsl' | 'packages' | 'system'
export type ActivityOutcome = 'success' | 'failure' | 'dry-run' | 'info'

/** A human summary for the activity log, not full command output. Every module appends to this. */
export interface ActivityEntry {
  id: string
  ts: number
  module: ActivityModule
  /** Short action label, e.g. "Prune - Nuclear", "Volume backup". */
  action: string
  outcome: ActivityOutcome
  /** Optional one-line detail, e.g. "~1.2 GB reclaimed". */
  detail?: string
}

export interface DockerCache {
  status: DockerStatus
  df: DockerSystemDf
  images: DockerImage[]
  containers: DockerContainer[]
  volumes: DockerVolume[]
  fetchedAt: number
}

// Handed to the Terminal panel's "Logs" tab. Carries everything ComposeLogPanel needs, so it can
// stream logs independently of the Compose view.
export interface ComposeLogContext {
  project:        ComposeProject
  containers:     DockerContainer[]
  configFile:     string
  initialService: string | null
}

interface AppState {
  theme: Theme
  activeView: View
  dockerTab: DockerTab
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setActiveView: (view: View) => void
  setDockerTab: (tab: DockerTab) => void

  wslView: WslView
  wslDistroTab: WslDistroTab
  wslSelectedDistro: string | null
  setWslView: (view: WslView) => void
  setWslDistroTab: (tab: WslDistroTab) => void
  setWslSelectedDistro: (name: string | null) => void
  wslDistrosNav: WslDistroNav[]
  setWslDistrosNav: (distros: WslDistroNav[]) => void
  wslBadges: { distros: string } | null
  setWslBadges: (b: { distros: string } | null) => void
  wslImportOpen: boolean
  setWslImportOpen: (open: boolean) => void
  /** Distro mid lifecycle action (start, stop, restart). In-distro pollers must skip it, so a probe
   *  does not reboot a distro that is being stopped. Ephemeral. */
  wslBusyDistro: string | null
  setWslBusyDistro: (name: string | null) => void
  /** Catalog distro whose download or import is in flight. Survives the wizard unmounting (it runs
   *  in the backend), so re-opening the wizard cannot start a second install. Ephemeral. */
  wslInstalling: string | null
  setWslInstalling: (name: string | null) => void
  /** Last-seen live metrics per distro, so reopening a distro's overview shows
   *  them instantly instead of a skeleton while the next probe runs. Ephemeral. */
  wslMetrics: Record<string, DistroMetrics>
  setWslMetric: (distro: string, metrics: DistroMetrics) => void

  /** Outlives the Sandbox page, so coming back to it cannot start a second sandbox by accident. Ephemeral. */
  sandboxStarting: boolean
  setSandboxStarting: (starting: boolean) => void
  sandboxDetails: Record<string, SandboxDetails>
  setSandboxDetails: (id: string, details: SandboxDetails) => void
  /** What a sandbox started with, by ID. Only known for sandboxes started since the app opened. */
  sandboxShared: Record<string, string[]>
  setSandboxShared: (id: string, shared: string[]) => void

  sidebarWidth: number
  terminalHeight: number
  setSidebarWidth: (w: number) => void
  setTerminalHeight: (h: number) => void
  /** Packages table: column widths in px by column key, and hidden column keys. */
  pkgColumns: { widths: Record<string, number>; hidden: string[] }
  setPkgColumns: (c: { widths: Record<string, number>; hidden: string[] }) => void
  /** Ports table: column widths in px by column key, and hidden column keys. */
  portColumns: { widths: Record<string, number>; hidden: string[] }
  setPortColumns: (c: { widths: Record<string, number>; hidden: string[] }) => void

  backupDir: string
  setBackupDir: (dir: string) => void

  // Set before navigating, and consumed once by the target tab.
  imagesFilter: 'dangling' | 'unused-tagged' | null
  volumesFilter: 'unused' | null
  composePreselect: string | null
  setImagesFilter:    (f: 'dangling' | 'unused-tagged' | null) => void
  setVolumesFilter:   (f: 'unused' | null) => void
  setComposePreselect: (name: string | null) => void

  // Updated by DockerView and ComposeTab.
  dockerBadges: { images: number; containers: string; volumes: string } | null
  setDockerBadges: (b: { images: number; containers: string; volumes: string } | null) => void
  composeProjectsNav: Array<{ name: string; status: string }>
  setComposeProjectsNav: (projects: Array<{ name: string; status: string }>) => void
  // Persisted, so a project that is `down`, and so gone from `docker compose ls`, still shows in the
  // list and can be started again.
  knownComposeProjects: Record<string, string[]>
  rememberComposeProjects: (projects: Array<{ name: string; config_files: string[] }>) => void
  forgetComposeProject: (name: string) => void
  composeActiveProject: string | null
  setComposeActiveProject: (name: string | null) => void
  // Published by ComposeTab and shown as a child menu in the sidebar.
  composeFilesNav: Array<{ path: string; label: string; kind: 'compose' | 'dockerfile' | 'env' }>
  setComposeFilesNav: (files: Array<{ path: string; label: string; kind: 'compose' | 'dockerfile' | 'env' }>) => void
  composeActiveFilePath: string | null
  setComposeActiveFilePath: (p: string | null) => void
  // Sidebar → ComposeTab: open this file path (cleared after read)
  composeFileSelect: string | null
  setComposeFileSelect: (p: string | null) => void
  // When true, ComposeTab should switch to main overview page (cleared after read)
  composeShowOverview: boolean
  setComposeShowOverview: (v: boolean) => void
  preferredEditor: { name: string; command: string } | null
  setPreferredEditor: (e: { name: string; command: string } | null) => void

  dockerKeepList: string[]
  addToKeepList: (id: string) => void
  removeFromKeepList: (id: string) => void

  dockerLogs: LogEntry[]
  addDockerLog: (entry: LogEntry) => void
  clearDockerLogs: () => void

  activityLog: ActivityEntry[]
  addActivity: (entry: Omit<ActivityEntry, 'id' | 'ts'>) => void
  clearActivity: () => void

  wslBenchmarks: Record<string, Array<{ ts: number; boot_ms: number }>>
  addWslBenchmark: (distro: string, bootMs: number) => void

  dockerCache: DockerCache | null
  setDockerCache: (cache: DockerCache) => void
  clearDockerCache: () => void

  terminalLines: TerminalLine[]
  terminalOpen: boolean
  addTerminalLine: (text: string, type: TerminalLine['type']) => void
  addTerminalLines: (items: Array<{ text: string; type: TerminalLine['type'] }>) => void
  clearTerminal: () => void
  setTerminalOpen: (open: boolean) => void
  toggleTerminal: () => void

  terminalTab: 'shell' | 'logs'
  setTerminalTab: (tab: 'shell' | 'logs') => void
  composeLogContext: ComposeLogContext | null
  openComposeLogs: (ctx: ComposeLogContext) => void
  closeComposeLogs: () => void

  indexOpen: boolean
  setIndexOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void

  // Unsaved editor content stays in memory, including .env secrets.
  editorDrafts: Record<string, string>
  setEditorDraft: (path: string, content: string) => void
  clearEditorDraft: (path: string, savedContent?: string) => void
}

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

let _lineId = 0

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      theme: getSystemTheme(),
      activeView: 'dashboard',
      dockerTab: 'overview',
      setTheme:      (theme) => { applyTheme(theme); set({ theme }) },
      toggleTheme:   () => { const next = get().theme === 'dark' ? 'light' : 'dark'; applyTheme(next); set({ theme: next }) },
      setActiveView: (view) => { if (!get().wslBusyDistro) set({ activeView: view }) },
      setDockerTab:  (dockerTab) => set({ dockerTab }),

      wslView:           'dashboard',
      wslDistroTab:      'overview',
      wslSelectedDistro: null,
      setWslView:           (wslView) => { if (!get().wslBusyDistro) set({ wslView }) },
      setWslDistroTab:      (wslDistroTab) => set({ wslDistroTab }),
      setWslSelectedDistro: (wslSelectedDistro) => { if (!get().wslBusyDistro) set({ wslSelectedDistro }) },
      wslDistrosNav:        [],
      setWslDistrosNav:     (wslDistrosNav) => set({ wslDistrosNav }),
      wslBadges:            null,
      setWslBadges:         (wslBadges) => set({ wslBadges }),
      wslImportOpen:        false,
      setWslImportOpen:     (wslImportOpen) => set({ wslImportOpen }),
      wslBusyDistro:        null,
      setWslBusyDistro:     (wslBusyDistro) => set({ wslBusyDistro }),
      wslInstalling:        null,
      setWslInstalling:     (wslInstalling) => set({ wslInstalling }),
      wslMetrics:           {},
      setWslMetric:         (distro, metrics) => set((s) => ({ wslMetrics: { ...s.wslMetrics, [distro]: metrics } })),

      sandboxStarting:      false,
      setSandboxStarting:   (sandboxStarting) => set({ sandboxStarting }),
      sandboxDetails:       {},
      setSandboxDetails:    (id, details) => set(s => ({ sandboxDetails: { ...s.sandboxDetails, [id]: details } })),
      sandboxShared:        {},
      setSandboxShared:     (id, shared) => set(s => ({ sandboxShared: { ...s.sandboxShared, [id]: shared } })),

      // sidebarWidth 0 means the CSS default (--sidebar-width).
      sidebarWidth:  0,
      // Enough to read the last few commands.
      terminalHeight: 180,
      setSidebarWidth:   (sidebarWidth)   => set({ sidebarWidth }),
      setTerminalHeight: (terminalHeight) => set({ terminalHeight }),
      pkgColumns: { widths: {}, hidden: ['publisher', 'location'] },
      setPkgColumns: (pkgColumns) => set({ pkgColumns }),
      portColumns: { widths: {}, hidden: ['command', 'folder', 'memory', 'parent', 'address', 'path'] },
      setPortColumns: (portColumns) => set({ portColumns }),

      backupDir: '',
      setBackupDir: (backupDir) => set({ backupDir }),

      imagesFilter:     null,
      volumesFilter:    null,
      composePreselect: null,
      setImagesFilter:     (imagesFilter)     => set({ imagesFilter }),
      setVolumesFilter:    (volumesFilter)    => set({ volumesFilter }),
      setComposePreselect: (composePreselect) => set({ composePreselect }),

      dockerBadges:           null,
      setDockerBadges:        (dockerBadges)        => set({ dockerBadges }),
      composeProjectsNav:     [],
      setComposeProjectsNav:  (composeProjectsNav)  => set({ composeProjectsNav }),
      knownComposeProjects:   {},
      rememberComposeProjects: (projects) =>
        set((s) => {
          const next = { ...s.knownComposeProjects }
          for (const p of projects) next[p.name] = p.config_files
          return { knownComposeProjects: next }
        }),
      forgetComposeProject: (name) =>
        set((s) => {
          const next = { ...s.knownComposeProjects }
          delete next[name]
          return { knownComposeProjects: next }
        }),
      composeActiveProject:   null,
      setComposeActiveProject:(composeActiveProject) => set({ composeActiveProject }),
      composeFilesNav:        [],
      setComposeFilesNav:     (composeFilesNav) => set({ composeFilesNav }),
      composeActiveFilePath:  null,
      setComposeActiveFilePath: (composeActiveFilePath) => set({ composeActiveFilePath }),
      composeFileSelect:      null,
      setComposeFileSelect:   (composeFileSelect) => set({ composeFileSelect }),
      composeShowOverview:    false,
      setComposeShowOverview: (composeShowOverview) => set({ composeShowOverview }),
      preferredEditor:        null,
      setPreferredEditor:     (preferredEditor) => set({ preferredEditor }),

      dockerKeepList: [],
      addToKeepList: (id) =>
        set((s) => ({
          dockerKeepList: s.dockerKeepList.includes(id)
            ? s.dockerKeepList
            : [...s.dockerKeepList, id],
        })),
      removeFromKeepList: (id) =>
        set((s) => ({ dockerKeepList: s.dockerKeepList.filter((k) => k !== id) })),

      dockerLogs: [],
      addDockerLog:  (entry) => set((s) => ({ dockerLogs: [entry, ...s.dockerLogs].slice(0, MAX_DOCKER_LOGS) })),
      clearDockerLogs: () => set({ dockerLogs: [] }),

      activityLog: [],
      addActivity: (entry) =>
        set((s) => ({
          activityLog: [
            // Timestamp + counter so ids stay unique across reloads (activityLog is
            // persisted; a bare counter resets to 0 and would collide with rehydrated ids).
            { ...entry, id: `${Date.now()}-${++_lineId}`, ts: Date.now() },
            ...s.activityLog,
          ].slice(0, MAX_ACTIVITY),
        })),
      clearActivity: () => set({ activityLog: [] }),

      wslBenchmarks: {},
      addWslBenchmark: (distro, bootMs) =>
        set((s) => ({
          wslBenchmarks: {
            ...s.wslBenchmarks,
            [distro]: [{ ts: Date.now(), boot_ms: bootMs }, ...(s.wslBenchmarks[distro] ?? [])].slice(0, 20),
          },
        })),

      dockerCache: null,
      setDockerCache:   (cache) => set({ dockerCache: cache }),
      clearDockerCache: () => set({ dockerCache: null }),

      terminalLines: [],
      // Collapsed by default. Ctrl+` opens it, and an operation that streams output (compose logs) opens
      // it itself.
      terminalOpen: false,
      addTerminalLine: (text, type) =>
        set((s) => ({
          terminalLines: [
            ...s.terminalLines,
            { id: `${++_lineId}`, text, type, ts: Date.now() },
          ].slice(-MAX_TERMINAL_LINES),
        })),
      addTerminalLines: (items) =>
        set((s) => ({
          terminalLines: [
            ...s.terminalLines,
            ...items.map(item => ({ id: `${++_lineId}`, text: item.text, type: item.type, ts: Date.now() })),
          ].slice(-MAX_TERMINAL_LINES),
        })),
      clearTerminal:   () => set({ terminalLines: [] }),
      setTerminalOpen: (open) => set({ terminalOpen: open }),
      toggleTerminal:  () => set((s) => ({ terminalOpen: !s.terminalOpen })),

      terminalTab: 'shell',
      setTerminalTab: (terminalTab) => set({ terminalTab }),
      composeLogContext: null,
      openComposeLogs: (composeLogContext) =>
        set({ composeLogContext, terminalTab: 'logs', terminalOpen: true }),
      closeComposeLogs: () =>
        set({ composeLogContext: null, terminalTab: 'shell' }),

      indexOpen: false,
      setIndexOpen: (indexOpen) => set({ indexOpen }),
      shortcutsOpen: false,
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

      editorDrafts: {},
      setEditorDraft: (path, content) => set(s => ({ editorDrafts: { ...s.editorDrafts, [path]: content } })),
      clearEditorDraft: (path, savedContent) => set(s => {
        if (savedContent !== undefined && s.editorDrafts[path] !== savedContent) return s
        const editorDrafts = { ...s.editorDrafts }
        delete editorDrafts[path]
        return { editorDrafts }
      }),
    }),
    {
      name: 'workspace-atlas-v1',
      partialize: (s) => ({
        theme:           s.theme,
        activeView:      s.activeView,
        dockerTab:       s.dockerTab,
        wslView:         s.wslView,
        wslDistroTab:    s.wslDistroTab,
        wslSelectedDistro: s.wslSelectedDistro,
        sidebarWidth:    s.sidebarWidth,
        terminalHeight:  s.terminalHeight,
        terminalOpen:    s.terminalOpen,
        pkgColumns:      s.pkgColumns,
        portColumns:     s.portColumns,
        backupDir:       s.backupDir,
        dockerKeepList:  s.dockerKeepList,
        dockerLogs:      s.dockerLogs,
        activityLog:     s.activityLog,
        wslBenchmarks:   s.wslBenchmarks,
        preferredEditor: s.preferredEditor,
        knownComposeProjects: s.knownComposeProjects,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Guard against a malformed/partial imported config missing theme.
          if (state.theme === 'dark' || state.theme === 'light') applyTheme(state.theme)
          // Migrate persisted values whose views/tabs no longer exist.
          if (!['dashboard', 'docker', 'wsl', 'sandbox', 'packages', 'ports', 'locks', 'settings'].includes(state.activeView)) {
            state.activeView = 'dashboard'
          }
          if (['backup', 'backup-volumes', 'backup-compose'].includes(state.dockerTab as string)) {
            state.dockerTab = 'volumes'
          }
        }
      },
    }
  )
)
