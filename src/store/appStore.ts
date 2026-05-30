import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LogEntry } from '../types/docker'

export type View = 'dashboard' | 'docker' | 'wsl' | 'packages'
export type Theme = 'dark' | 'light'

const MAX_DOCKER_LOGS = 10

interface AppState {
  // ── App
  theme: Theme
  activeView: View
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setActiveView: (view: View) => void

  // ── Docker keep-list (image IDs pinned from pruning)
  dockerKeepList: string[]
  addToKeepList: (id: string) => void
  removeFromKeepList: (id: string) => void

  // ── Docker run history (last 10 entries)
  dockerLogs: LogEntry[]
  addDockerLog: (entry: LogEntry) => void
  clearDockerLogs: () => void
}

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // ── App
      theme: getSystemTheme(),
      activeView: 'dashboard',

      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
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
    }),
    {
      name: 'workspace-atlas-v1',
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme)
      },
    }
  )
)
