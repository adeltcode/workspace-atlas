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
        consequence: 'Docker stops this container and frees its ports. Its files stay, and you can start it again from the Docker page.',
        confirmLabel: 'Stop container',
        busyLabel: 'Stopping…',
      }
    case 'stop-docker':
      return {
        title: 'Stop Docker Desktop?',
        consequence: `${process.name} is part of Docker Desktop, so the only way to free this is to stop Docker Desktop. Every running container stops with it. You can start it again from the Docker page.`,
        confirmLabel: 'Stop Docker Desktop',
        busyLabel: 'Stopping…',
      }
    case 'stop-wsl':
      return {
        title: 'Shut down WSL?',
        consequence: `${process.name} is part of WSL, so the only way to free this is to shut WSL down. Every running distro stops, and anything they have not saved is lost. Docker Desktop also stops working if it runs on WSL.`,
        confirmLabel: 'Shut down WSL',
        busyLabel: 'Shutting down…',
      }
    default:
      return {
        title: `Close ${process.name}?`,
        consequence: process.distro
          ? `Linux asks this program in ${process.distro} to stop. Anything it has not saved may be lost.`
          : 'Windows ends this program right away, without letting it save. Anything it has not saved is lost.',
        confirmLabel: 'Close program',
        busyLabel: 'Closing…',
      }
  }
}

/** Shown instead of a button when nothing here can free what the program holds. */
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
  'running-from-here': 'Running from this location',
}

/** The last part of a path, which is enough to tell dropped items apart in a table. */
export const itemName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

export function checkedSummary(reports: LockReport[]): string {
  const hasFolder = reports.some(r => r.is_folder)
  const checked = reports.length === 1
    ? `Checked ${reports[0].path}${hasFolder ? ' and everything inside it' : ''}.`
    : `Checked ${reports.length} items${hasFolder ? ', including everything inside the folders' : ''}.`
  return hasFolder
    ? `${checked} A program running as administrator only shows up when you check the exact file it is using.`
    : checked
}

export function runsIn(entry: PortEntry): string {
  if (entry.source === 'docker') return 'Docker'
  return entry.source === 'wsl' ? `WSL: ${entry.process.distro}` : 'Windows'
}

export const reachableLabel = (entry: PortEntry) =>
  entry.reachable === 'this-pc' ? 'This PC only' : 'Your network'

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

/** Unknown values sort last in both directions, and ties fall back to the port. */
export function sortPorts(entries: PortEntry[], key: PortSortKey, dir: 'asc' | 'desc'): PortEntry[] {
  return [...entries].sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key)
    const byPort = a.port - b.port || a.process.pid - b.process.pid
    if (va === null || vb === null) return va === vb ? byPort : va === null ? 1 : -1
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base', numeric: true })
    return (dir === 'asc' ? cmp : -cmp) || byPort
  })
}
