import type { SourceResult } from './types'

// Its own key, so the list stays out of exported configuration and is not rewritten on every store change.
const KEY = 'workspace-atlas-packages-v1'
const FRESH_MS = 10 * 60 * 1000

export interface SavedScan {
  results: SourceResult[]
  scannedAt: number
}

export const isFresh = (scannedAt: number, now = Date.now()) => now - scannedAt < FRESH_MS

export function loadScan(storage: Pick<Storage, 'getItem'> = localStorage): SavedScan | null {
  try {
    const saved = JSON.parse(storage.getItem(KEY) ?? 'null')
    return Array.isArray(saved?.results) && typeof saved?.scannedAt === 'number' ? saved : null
  } catch {
    return null
  }
}

/** A failed write costs nothing but a scan on the next launch. */
export function saveScan(scan: SavedScan, storage: Pick<Storage, 'setItem'> = localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(scan))
  } catch { /* storage full or unavailable */ }
}
