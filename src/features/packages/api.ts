import { invoke } from '../../utils/errors'
import type { SourceResult, UninstallCheck } from './types'

/** Every source the backend knows how to scan. Ids it does not recognise are
 *  dropped there, so this list can never widen what actually runs. */
export const SOURCE_IDS = [
  'winget', 'choco', 'scoop', 'npm', 'pnpm', 'pip', 'pipx', 'uv', 'conda', 'cargo', 'rustup', 'gem',
  'dotnet', 'dotnet-sdk', 'dotnet-runtime', 'powershell', 'vscode', 'code-insiders', 'cursor', 'codium',
  'registry', 'store',
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

/** Look before uninstalling. `version` pins winget to one of several installs
 *  sharing an id; `installed` is only used for the reinstall command. */
export const pkgUninstallCheck = (source: string, id: string, name: string, installed: string, version: string | null) =>
  invoke<UninstallCheck>('pkg_uninstall_check', { source, id, name, installed, version })

/** Uninstall one package. Core tools need `confirm` to equal the id. Resolves
 *  to the `pip check` lines that now name the removed package (pip only). */
export const pkgUninstall = (source: string, id: string, version: string | null, confirm: string | null) =>
  invoke<string[]>('pkg_uninstall', { source, id, version, confirm })

/** Save a CSV built by the caller. Returns the chosen path, or null if the save
 *  dialog was cancelled. */
export const pkgExportCsv = (contents: string) =>
  invoke<string | null>('pkg_export_csv', { contents })
