import { invoke } from '../../utils/errors'
import type { SourceResult } from './types'

/** Every source the backend knows how to scan. Ids it does not recognise are
 *  dropped there, so this list can never widen what actually runs. */
export const SOURCE_IDS = [
  'winget', 'choco', 'scoop', 'npm', 'pip', 'cargo', 'dotnet', 'powershell', 'vscode', 'registry',
]

/** Scan the given package managers concurrently. One result per source, in the
 *  order requested; a manager that is not installed comes back `installed: false`
 *  rather than as an error. */
export const pkgScan = (sources: string[] = SOURCE_IDS) =>
  invoke<SourceResult[]>('pkg_scan', { sources })

/** Upgrade one winget package. Resolves when winget exits 0; its output
 *  streams to the terminal meanwhile. */
export const pkgUpgrade = (id: string) =>
  invoke<void>('pkg_upgrade', { source: 'winget', id })

/** Save a CSV built by the caller. Returns the chosen path, or null if the save
 *  dialog was cancelled. */
export const pkgExportCsv = (contents: string) =>
  invoke<string | null>('pkg_export_csv', { contents })
