import type { HoldReason, PortEntry, ProcessInfo, ProcessOwner } from './api'

export type PortFilter = 'programs' | 'all'

export function closeCommand(process: ProcessInfo): string {
  return process.distro
    ? `wsl -d ${process.distro} -u root kill ${process.pid}`
    : `taskkill /PID ${process.pid} /F`
}

export const canClose = (process: ProcessInfo) =>
  process.owner === 'app' || (process.owner === 'wsl' && process.distro !== null)

/** Shown instead of a Close button. Docker and WSL's own programs link to their page instead. */
export const NOT_CLOSABLE: Partial<Record<ProcessOwner, string>> = {
  admin: 'Needs administrator',
  'distro-system': 'Part of the distro',
  windows: 'Part of Windows',
  'this-app': 'This app',
  unknown: 'Not available',
}

const HIDDEN_FROM_PROGRAMS: ProcessOwner[] = ['windows', 'distro-system', 'unknown']

export const HOLD_REASON: Record<HoldReason, string> = {
  'open-file': 'Has a file open',
  'folder-open': 'Has a folder open or is working in it',
  'loaded-file': 'Has a file loaded',
  'running-from-here': 'Running from this folder',
}

export function filterPorts(entries: PortEntry[], query: string, show: PortFilter): PortEntry[] {
  const q = query.trim().toLowerCase().replace(/^:/, '')
  return entries.filter(e => {
    if (show === 'programs' && HIDDEN_FROM_PROGRAMS.includes(e.process.owner)) return false
    if (!q) return true
    return String(e.port).startsWith(q)
      || (e.process.pid > 0 && String(e.process.pid).startsWith(q))
      || e.process.name.toLowerCase().includes(q)
      || (e.process.path ?? '').toLowerCase().includes(q)
  })
}
