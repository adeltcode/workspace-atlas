import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LogEntry, DockerStatus, DockerSystemDf, DockerImage, DockerContainer, DockerVolume } from '../features/docker/types'
import type { TerminalLine } from '../types/terminal'

export type View      = 'dashboard' | 'docker' | 'wsl' | 'packages' | 'automation'
export type Theme     = 'dark' | 'light'
export type DockerTab = 'overview' | 'images' | 'containers' | 'volumes' | 'networks' | 'compose' | 'backup-volumes' | 'backup-compose' | 'prune' | 'log'

const MAX_DOCKER_LOGS    = 10
const MAX_TERMINAL_LINES = 500

export interface DockerCache {
  status: DockerStatus
  df: DockerSystemDf
  images: DockerImage[]
  containers: DockerContainer[]
  volumes: DockerVolume[]
  fetchedAt: number
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

  // ── Docker keep-list (persisted)
  dockerKeepList: string[]
  addToKeepList: (id: string) => void
  removeFromKeepList: (id: string) => void

  // ── Docker run history (persisted)
  dockerLogs: LogEntry[]
  addDockerLog: (entry: LogEntry) => void
  clearDockerLogs: () => void

  // ── Docker data cache (ephemeral)
  dockerCache: DockerCache | null
  setDockerCache: (cache: DockerCache) => void
  clearDockerCache: () => void

  // ── Global terminal (ephemeral)
  terminalLines: TerminalLine[]
  terminalOpen: boolean
  addTerminalLine: (text: string, type: TerminalLine['type']) => void
  clearTerminal: () => void
  setTerminalOpen: (open: boolean) => void
  toggleTerminal: () => void
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

      // ── Docker cache
      dockerCache: null,
      setDockerCache:   (cache) => set({ dockerCache: cache }),
      clearDockerCache: () => set({ dockerCache: null }),

      // ── Terminal
      terminalLines: [],
      terminalOpen: false,
      addTerminalLine: (text, type) =>
        set((s) => ({
          // Do NOT force-open the terminal — user controls visibility explicitly
          terminalLines: [
            ...s.terminalLines,
            { id: `${++_lineId}`, text, type, ts: Date.now() },
          ].slice(-MAX_TERMINAL_LINES),
        })),
      clearTerminal:   () => set({ terminalLines: [] }),
      setTerminalOpen: (open) => set({ terminalOpen: open }),
      toggleTerminal:  () => set((s) => ({ terminalOpen: !s.terminalOpen })),
    }),
    {
      name: 'workspace-atlas-v1',
      partialize: (s) => ({
        theme:          s.theme,
        activeView:     s.activeView,
        dockerTab:      s.dockerTab,
        sidebarWidth:   s.sidebarWidth,
        terminalHeight: s.terminalHeight,
        backupDir:      s.backupDir,
        dockerKeepList: s.dockerKeepList,
        dockerLogs:     s.dockerLogs,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme)
          // Migrate legacy 'backup' tab value that may be stored in localStorage
          if ((state.dockerTab as string) === 'backup') {
            state.dockerTab = 'backup-volumes'
          }
        }
      },
    }
  )
)
