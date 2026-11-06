import { sortRows, type SortDir } from '../../utils/sortRows'
import type { HoldReason, LockReport, PortEntry, ProcessInfo, ProcessOwner } from './api'

export type PortFilter = 'programs' | 'all'
export type PortSortKey =
  | 'port' | 'program' | 'pid' | 'runs-in' | 'reachable' | 'since'
  | 'command' | 'folder' | 'memory' | 'parent' | 'address' | 'path'

export const canClose = (process: ProcessInfo) =>
  process.owner === 'app' || (process.owner === 'wsl' && process.distro !== null)

export const isContainer = (process: ProcessInfo) => process.owner === 'docker' && process.pid === 0

export type HolderFix = 'close' | 'stop-container' | 'stop-docker' | 'stop-wsl'

/** What frees what this program holds, right from the row. Null when nothing here can. */
export function fixFor(process: ProcessInfo): HolderFix | null {
  if (isContainer(process)) return 'stop-container'
  if (process.owner === 'docker') return 'stop-docker'
  if (process.owner === 'wsl' && process.distro === null) return 'stop-wsl'
  return canClose(process) ? 'close' : null
}

export const FIX_BUTTON: Record<HolderFix, string> = {
  close: 'Close',
  'stop-container': 'Stop',
  'stop-docker': 'Stop Docker',
  'stop-wsl': 'Shut down WSL',
}

export function closeCommand(process: ProcessInfo): string {
  switch (fixFor(process)) {
    case 'stop-container': return `docker stop ${process.name}`
    case 'stop-docker':    return 'docker desktop stop'
    case 'stop-wsl':       return 'wsl --shutdown'
  }
  return process.distro
    ? `wsl -d ${process.distro} -u root kill ${process.pid}`
    : `taskkill /PID ${process.pid} /F`
}

export function fixDone(process: ProcessInfo): string {
  switch (fixFor(process)) {
    case 'stop-container': return `Stopped ${process.name}`
    case 'stop-docker':    return 'Stopped Docker Desktop'
    case 'stop-wsl':       return 'Shut down WSL'
    default:               return `Closed ${process.name}`
  }
}

/** The wording of the dialog that asks before the fix runs. */
export function fixDialog(process: ProcessInfo): { title: string; consequence: string; confirmLabel: string; busyLabel: string } {
  switch (fixFor(process)) {
    case 'stop-container':
      return {
        title: `Stop ${process.name}?`,
        consequence: 'Docker stops this container and releases its published ports. Container data is preserved, and the container can be restarted from the Docker page.',
        confirmLabel: 'Stop container',
        busyLabel: 'Stopping…',
      }
    case 'stop-docker':
      return {
        title: 'Stop Docker Desktop?',
        consequence: `${process.name} is a Docker Desktop process. Releasing this requires stopping Docker Desktop, which also stops all running containers. Docker Desktop can be restarted from the Docker page.`,
        confirmLabel: 'Stop Docker Desktop',
        busyLabel: 'Stopping…',
      }
    case 'stop-wsl':
      return {
        title: 'Shut down WSL?',
        consequence: `${process.name} is a WSL process. Releasing this requires shutting down WSL, which stops all running distros and discards their unsaved work. Docker Desktop also stops if it uses the WSL 2 backend.`,
        confirmLabel: 'Shut down WSL',
        busyLabel: 'Shutting down…',
      }
    default:
      return {
        title: `Close ${process.name}?`,
        consequence: process.distro
          ? `Sends SIGTERM to this process in ${process.distro}. Unsaved data may be lost.`
          : 'Terminates this process immediately. Unsaved data is lost.',
        confirmLabel: 'Close program',
        busyLabel: 'Closing…',
      }
  }
}

/** Shown instead of a button when nothing here can free what the program holds. */
export const NOT_CLOSABLE: Partial<Record<ProcessOwner, string>> = {
  admin: 'Requires administrator',
  'distro-system': 'Distro system process',
  windows: 'Windows system process',
  'this-app': 'This app',
  unknown: 'Not available',
}

const HIDDEN_FROM_PROGRAMS: ProcessOwner[] = ['windows', 'distro-system', 'unknown']

export const HOLD_REASON: Record<HoldReason, string> = {
  'open-file': 'Open file handle',
  'folder-open': 'Open directory handle or working directory',
  'loaded-file': 'Loaded module',
  'running-from-here': 'Executable in this location',
}

/** The last part of a path, which is enough to tell dropped items apart in a table. */
export const itemName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

export function checkedSummary(reports: LockReport[]): string {
  const hasFolder = reports.some(r => r.is_folder)
  const checked = reports.length === 1
    ? `Checked ${reports[0].path}${hasFolder ? ' recursively' : ''}.`
    : `Checked ${reports.length} items${hasFolder ? ', including folder contents' : ''}.`
  return hasFolder
    ? `${checked} Processes running as administrator are detected only when checking the exact file.`
    : checked
}

export function runsIn(entry: PortEntry): string {
  if (entry.source === 'docker') return 'Docker'
  return entry.source === 'wsl' ? `WSL: ${entry.process.distro}` : 'Windows'
}

export const reachableLabel = (entry: PortEntry) =>
  entry.reachable === 'this-pc' ? 'Localhost' : 'Network'

export const addressList = (entry: PortEntry) => entry.addresses.join(', ')

/** Spells out what the time means, because Docker and WSL do not record when the socket opened. */
export function sinceTitle(entry: PortEntry): string | undefined {
  if (entry.listening_since === null) return undefined
  const when = new Date(entry.listening_since * 1000).toLocaleString()
  if (entry.source === 'docker') return `${when}, when the container started`
  return entry.source === 'wsl' ? `${when}, when the program started` : when
}

export function filterPorts(entries: PortEntry[], query: string, show: PortFilter): PortEntry[] {
  const q = query.trim().toLowerCase().replace(/^:/, '')
  return entries.filter(e => {
    if (show === 'programs' && HIDDEN_FROM_PROGRAMS.includes(e.process.owner)) return false
    if (!q) return true
    return String(e.port).startsWith(q)
      || (e.process.pid > 0 && String(e.process.pid).startsWith(q))
      || [e.process.name, e.process.path, runsIn(e), e.details.command, e.details.folder]
        .some(text => (text ?? '').toLowerCase().includes(q))
  })
}

function sortValue(e: PortEntry, key: PortSortKey): string | number | null {
  switch (key) {
    case 'port':      return e.port
    case 'program':   return e.process.name
    case 'pid':       return e.process.pid || null
    case 'runs-in':   return runsIn(e)
    case 'reachable': return reachableLabel(e)
    case 'since':     return e.listening_since
    case 'command':   return e.details.command
    case 'folder':    return e.details.folder
    case 'memory':    return e.details.memory_bytes
    case 'parent':    return e.details.parent
    case 'address':   return addressList(e)
    case 'path':      return e.process.path
  }
}

/** Ties fall back to the port. */
export function sortPorts(entries: PortEntry[], key: PortSortKey, dir: SortDir): PortEntry[] {
  return sortRows(entries, e => sortValue(e, key), (a, b) => a.port - b.port || a.process.pid - b.process.pid, dir)
}
