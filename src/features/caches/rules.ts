import { sortRows, type SortDir } from '../../utils/sortRows'
import { bytesToHuman } from '../../utils/format'
import type { CacheItem, CacheKind, CacheScan, ClearResult } from './api'

export type CacheFilter = 'all' | 'idle'
export type CacheSortKey = 'name' | 'type' | 'size' | 'files' | 'used' | 'restore' | 'location'

export const IDLE_DAYS = 30
const DAY_SECONDS = 86_400

export const KIND_LABEL: Record<CacheKind, string> = {
  'node-modules': 'Node modules',
  'rust-target': 'Cargo target',
  'maven-target': 'Maven target',
  'gradle-build': 'Gradle build',
  'python-venv': 'Python venv',
  'python-bytecode': 'Python bytecode',
  shared: 'Global cache',
}

export const itemKey = (item: CacheItem) => item.paths[0]

export const isIdle = (item: CacheItem, nowSeconds: number) =>
  item.last_used !== null && nowSeconds - item.last_used > IDLE_DAYS * DAY_SECONDS

/** Whether `restore` is something to type, rather than a sentence about what happens. */
export const restoreIsCommand = (item: CacheItem) => item.kind !== 'python-bytecode'

export function filterItems(items: CacheItem[], query: string, filter: CacheFilter, kinds: string[], nowSeconds: number): CacheItem[] {
  const q = query.trim().toLowerCase()
  return items.filter(item => {
    if (filter === 'idle' && !isIdle(item, nowSeconds)) return false
    if (kinds.length > 0 && !kinds.includes(item.kind)) return false
    return !q || [item.name, KIND_LABEL[item.kind], ...item.paths].some(text => text.toLowerCase().includes(q))
  })
}

/** Ties fall back to the biggest. */
export function sortItems(items: CacheItem[], key: CacheSortKey, dir: SortDir): CacheItem[] {
  const valueOf = (item: CacheItem): string | number | null => {
    switch (key) {
      case 'name':     return item.name
      case 'type':     return KIND_LABEL[item.kind]
      case 'size':     return item.size_bytes
      case 'files':    return item.file_count
      case 'used':     return item.last_used
      case 'restore':  return item.restore
      case 'location': return item.paths[0]
    }
  }
  return sortRows(items, valueOf, (a, b) => b.size_bytes - a.size_bytes, dir)
}

export const totalBytes = (items: CacheItem[]) => items.reduce((sum, item) => sum + item.size_bytes, 0)

export const cacheCount = (count: number) => `${count} ${count === 1 ? 'cache' : 'caches'}`

const powershellQuote = (text: string) => `'${text.replace(/'/g, "''")}'`

export const clearCommand = (items: CacheItem[]) =>
  `Remove-Item -LiteralPath ${items.flatMap(item => item.paths).map(powershellQuote).join(', ')} -Recurse -Force`

export const clearNotes = (items: CacheItem[]) =>
  [...new Set(items.flatMap(item => (item.note ? [`${item.name}: ${item.note}`] : [])))]

/** Takes out what was removed. A row only goes once all of its folders have. */
export function afterClear(scan: CacheScan, removed: string[]): CacheScan {
  const gone = new Set(removed)
  return {
    ...scan,
    items: scan.items.flatMap(item => {
      const paths = item.paths.filter(path => !gone.has(path))
      if (paths.length === 0) return []
      return [paths.length === item.paths.length ? item : { ...item, paths }]
    }),
  }
}

export function clearSummary(items: CacheItem[], result: ClearResult): string {
  const gone = new Set(result.removed)
  const cleared = items.filter(item => item.paths.every(path => gone.has(path))).length
  const freed = result.drives
    .filter(drive => drive.freed_bytes > 0)
    .map(drive => `Reclaimed ${bytesToHuman(drive.freed_bytes)} on ${drive.drive}`)
  return [`Cleared ${cacheCount(cleared)}`, ...freed].join('. ') + '.'
}
