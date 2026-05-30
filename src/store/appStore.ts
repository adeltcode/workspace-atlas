import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LogEntry } from '../types/docker'
import type { TerminalLine } from '../types/terminal'

export type View = 'dashboard' | 'docker' | 'wsl' | 'packages'
export type Theme = 'dark' | 'light'

const MAX_DOCKER_LOGS    = 10
const MAX_TERMINAL_LINES = 500

interface AppState {
  // ── App
  theme: Theme
  activeView: View
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setActiveView: (view: View) => void

  // ── Docker keep-list
  dockerKeepList: string[]
  addToKeepList: (id: string) => void
  removeFromKeepList: (id: string) => void

  // ── Docker run history (persisted)
  dockerLogs: LogEntry[]
  addDockerLog: (entry: LogEntry) => void
  clearDockerLogs: () => void

  // ── Global terminal (ephemeral — not persisted)
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

      setTheme: (theme) => { applyTheme(theme); set({ theme }) },
      toggleTheme: () => {
        const next = get().theme === 'dark' ? 'light' : 'dark'
        applyTheme(next)
        set({ theme: next })
      },
      setActiveView: (view) => set({ activeView: view }),

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
      addDockerLog: (entry) =>
        set((s) => ({
          dockerLogs: [entry, ...s.dockerLogs].slice(0, MAX_DOCKER_LOGS),
        })),
      clearDockerLogs: () => set({ dockerLogs: [] }),

      // ── Terminal
      terminalLines: [],
      terminalOpen: false,
      addTerminalLine: (text, type) =>
        set((s) => ({
          terminalOpen: true,
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
        dockerKeepList: s.dockerKeepList,
        dockerLogs:     s.dockerLogs,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme)
      },
    }
  )
)
