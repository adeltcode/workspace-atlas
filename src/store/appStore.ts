import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LogEntry, DockerStatus, DockerSystemDf, DockerImage, DockerContainer, DockerVolume, ComposeProject } from '../features/docker/types'
import type { TerminalLine } from '../types/terminal'

export type View      = 'dashboard' | 'docker' | 'wsl' | 'packages' | 'automation' | 'settings'
export type Theme     = 'dark' | 'light'
export type DockerTab = 'overview' | 'images' | 'containers' | 'volumes' | 'networks' | 'compose' | 'backup-volumes' | 'backup-compose' | 'prune' | 'log'
export type WslTab    = 'dashboard' | 'distros' | 'startup' | 'performance' | 'config'
export type WslConfigSub = 'wslconfig' | 'conf'

/** Lightweight distro entry for the sidebar grandchild list. */
export interface WslDistroNav {
  name: string
  running: boolean
  is_default: boolean
  version: number
}

const MAX_DOCKER_LOGS    = 10
const MAX_TERMINAL_LINES = 500
const MAX_ACTIVITY       = 50

export type ActivityModule  = 'docker' | 'wsl' | 'packages' | 'system'
export type ActivityOutcome = 'success' | 'failure' | 'dry-run' | 'info'

/** One cross-module operation record for the unified activity log. Lightweight
 *  by design — a human summary, not full command output (that lives in the
 *  Terminal / Docker run-log). Every module appends to this. */
export interface ActivityEntry {
  id: string
  ts: number
  module: ActivityModule
  /** Short action label, e.g. "Prune — Nuclear", "Volume backup". */
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

// Context handed to the bottom Terminal panel's "Logs" tab when the user opens
// compose logs for a project. Carries everything ComposeLogPanel needs so the
// wide bottom panel can stream logs independently of the Compose view.
export interface ComposeLogContext {
  project:        ComposeProject
  containers:     DockerContainer[]
  configFile:     string
  initialService: string | null
}

interface AppState {
  // ── App
  theme: Theme
  activeView: View
  dockerTab: DockerTab
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setActiveView: (view: View) => void
  setDockerTab: (tab: DockerTab) => void

  // ── WSL navigation (wslTab/configSub/selected persisted; nav+badges ephemeral)
  wslTab: WslTab
  wslConfigSub: WslConfigSub
  wslSelectedDistro: string | null
  setWslTab: (tab: WslTab) => void
  setWslConfigSub: (sub: WslConfigSub) => void
  setWslSelectedDistro: (name: string | null) => void
  wslDistrosNav: WslDistroNav[]
  setWslDistrosNav: (distros: WslDistroNav[]) => void
  wslBadges: { distros: string } | null
  setWslBadges: (b: { distros: string } | null) => void

  // ── Layout sizes (persisted)
  sidebarWidth: number
  terminalHeight: number
  setSidebarWidth: (w: number) => void
  setTerminalHeight: (h: number) => void

  // ── Backup directory (persisted)
  backupDir: string
  setBackupDir: (dir: string) => void

  // ── Backup pre-select — set before navigating to backup tab (ephemeral)
  backupPreselect: string | null
  setBackupPreselect: (name: string | null) => void

  // ── Tab pre-filters — set before navigating, consumed once by target tab (ephemeral)
  imagesFilter: 'dangling' | 'unused-tagged' | null
  volumesFilter: 'unused' | null
  composePreselect: string | null
  setImagesFilter:    (f: 'dangling' | 'unused-tagged' | null) => void
  setVolumesFilter:   (f: 'unused' | null) => void
  setComposePreselect: (name: string | null) => void

  // ── Docker sidebar nav data (ephemeral — updated by DockerView / ComposeTab)
  dockerBadges: { images: number; containers: string; volumes: string } | null
  setDockerBadges: (b: { images: number; containers: string; volumes: string } | null) => void
  composeProjectsNav: Array<{ name: string; status: string }>
  setComposeProjectsNav: (projects: Array<{ name: string; status: string }>) => void
  // Compose projects we have seen (name → config files), persisted so a project
  // that is `down` — and thus drops out of `docker compose ls` — still shows in
  // the list and can be started again.
  knownComposeProjects: Record<string, string[]>
  rememberComposeProjects: (projects: Array<{ name: string; config_files: string[] }>) => void
  forgetComposeProject: (name: string) => void
  composeActiveProject: string | null
  setComposeActiveProject: (name: string | null) => void
  // Active project's files, shown as a child menu in the sidebar (replaces the
  // in-editor file tabs). Published by ComposeTab.
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
  // Preferred external editor for "Open in IDE" (persisted)
  preferredEditor: { name: string; command: string } | null
  setPreferredEditor: (e: { name: string; command: string } | null) => void

  // ── Docker keep-list (persisted)
  dockerKeepList: string[]
  addToKeepList: (id: string) => void
  removeFromKeepList: (id: string) => void

  // ── Docker run history (persisted)
  dockerLogs: LogEntry[]
  addDockerLog: (entry: LogEntry) => void
  clearDockerLogs: () => void

  // ── Unified cross-module activity log (persisted)
  activityLog: ActivityEntry[]
  addActivity: (entry: Omit<ActivityEntry, 'id' | 'ts'>) => void
  clearActivity: () => void

  // ── WSL cold-boot benchmark history, per distro (persisted)
  wslBenchmarks: Record<string, Array<{ ts: number; boot_ms: number }>>
  addWslBenchmark: (distro: string, bootMs: number) => void

  // ── Docker data cache (ephemeral)
  dockerCache: DockerCache | null
  setDockerCache: (cache: DockerCache) => void
  clearDockerCache: () => void

  // ── Global terminal (ephemeral)
  terminalLines: TerminalLine[]
  terminalOpen: boolean
  addTerminalLine: (text: string, type: TerminalLine['type']) => void
  addTerminalLines: (items: Array<{ text: string; type: TerminalLine['type'] }>) => void
  clearTerminal: () => void
  setTerminalOpen: (open: boolean) => void
  toggleTerminal: () => void

  // ── Terminal tabs + compose log routing (ephemeral)
  terminalTab: 'shell' | 'logs'
  setTerminalTab: (tab: 'shell' | 'logs') => void
  composeLogContext: ComposeLogContext | null
  openComposeLogs: (ctx: ComposeLogContext) => void
  closeComposeLogs: () => void
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
      // ── App
      theme: getSystemTheme(),
      activeView: 'dashboard',
      dockerTab: 'overview',
      setTheme:      (theme) => { applyTheme(theme); set({ theme }) },
      toggleTheme:   () => { const next = get().theme === 'dark' ? 'light' : 'dark'; applyTheme(next); set({ theme: next }) },
      setActiveView: (view) => set({ activeView: view }),
      setDockerTab:  (dockerTab) => set({ dockerTab }),

      // ── WSL navigation
      wslTab:            'dashboard',
      wslConfigSub:      'wslconfig',
      wslSelectedDistro: null,
      setWslTab:            (wslTab) => set({ wslTab }),
      setWslConfigSub:      (wslConfigSub) => set({ wslConfigSub }),
      setWslSelectedDistro: (wslSelectedDistro) => set({ wslSelectedDistro }),
      wslDistrosNav:        [],
      setWslDistrosNav:     (wslDistrosNav) => set({ wslDistrosNav }),
      wslBadges:            null,
      setWslBadges:         (wslBadges) => set({ wslBadges }),

      // ── Layout sizes (sidebarWidth 0 = auto/fit-content)
      sidebarWidth:  0,
      terminalHeight: 260,
      setSidebarWidth:   (sidebarWidth)   => set({ sidebarWidth }),
      setTerminalHeight: (terminalHeight) => set({ terminalHeight }),

      // ── Backup directory
      backupDir: '',
      setBackupDir: (backupDir) => set({ backupDir }),

      // ── Backup pre-select (ephemeral)
      backupPreselect: null,
      setBackupPreselect: (backupPreselect) => set({ backupPreselect }),

      // ── Tab pre-filters (ephemeral)
      imagesFilter:     null,
      volumesFilter:    null,
      composePreselect: null,
      setImagesFilter:     (imagesFilter)     => set({ imagesFilter }),
      setVolumesFilter:    (volumesFilter)    => set({ volumesFilter }),
      setComposePreselect: (composePreselect) => set({ composePreselect }),

      // ── Docker sidebar nav data (ephemeral)
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

      // ── Docker keep-list
      dockerKeepList: [],
      addToKeepList: (id) =>
        set((s) => ({
          dockerKeepList: s.dockerKeepList.includes(id)
            ? s.dockerKeepList
            : [...s.dockerKeepList, id],
        })),
      removeFromKeepList: (id) =>
        set((s) => ({ dockerKeepList: s.dockerKeepList.filter((k) => k !== id) })),

      // ── Docker logs
      dockerLogs: [],
      addDockerLog:  (entry) => set((s) => ({ dockerLogs: [entry, ...s.dockerLogs].slice(0, MAX_DOCKER_LOGS) })),
      clearDockerLogs: () => set({ dockerLogs: [] }),

      // ── Unified activity log
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

      // ── WSL benchmark history (keep the 20 most recent per distro)
      wslBenchmarks: {},
      addWslBenchmark: (distro, bootMs) =>
        set((s) => ({
          wslBenchmarks: {
            ...s.wslBenchmarks,
            [distro]: [{ ts: Date.now(), boot_ms: bootMs }, ...(s.wslBenchmarks[distro] ?? [])].slice(0, 20),
          },
        })),

      // ── Docker cache
      dockerCache: null,
      setDockerCache:   (cache) => set({ dockerCache: cache }),
      clearDockerCache: () => set({ dockerCache: null }),

      // ── Terminal
      terminalLines: [],
      terminalOpen: false,
      addTerminalLine: (text, type) =>
        set((s) => ({
          terminalLines: [
            ...s.terminalLines,
            { id: `${++_lineId}`, text, type, ts: Date.now() },
          ].slice(-MAX_TERMINAL_LINES),
        })),
      // Batch variant — one set() call for many lines, avoids per-line re-renders
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

      // ── Terminal tabs + compose log routing (ephemeral)
      terminalTab: 'shell',
      setTerminalTab: (terminalTab) => set({ terminalTab }),
      composeLogContext: null,
      openComposeLogs: (composeLogContext) =>
        set({ composeLogContext, terminalTab: 'logs', terminalOpen: true }),
      closeComposeLogs: () =>
        set({ composeLogContext: null, terminalTab: 'shell' }),
    }),
    {
      name: 'workspace-atlas-v1',
      partialize: (s) => ({
        theme:           s.theme,
        activeView:      s.activeView,
        dockerTab:       s.dockerTab,
        wslTab:          s.wslTab,
        wslConfigSub:    s.wslConfigSub,
        wslSelectedDistro: s.wslSelectedDistro,
        sidebarWidth:    s.sidebarWidth,
        terminalHeight:  s.terminalHeight,
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
          // Migrate legacy 'backup' tab value that may be stored in localStorage
          if ((state.dockerTab as string) === 'backup') {
            state.dockerTab = 'backup-volumes'
          }
        }
      },
    }
  )
)
