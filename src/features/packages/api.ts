import { invoke } from '../../utils/errors'
import type { SourceResult, SourceUpdates, UninstallCheck } from './types'

/** Every source the backend knows how to scan. Ids it does not recognise are
 *  dropped there, so this list can never widen what actually runs. */
export const SOURCE_IDS = [
  'winget', 'choco', 'scoop', 'npm', 'pnpm', 'pip', 'pipx', 'uv', 'conda', 'cargo', 'rustup', 'gem',
  'dotnet', 'dotnet-sdk', 'dotnet-runtime', 'powershell', 'vscode', 'code-insiders', 'cursor', 'codium',
  'registry', 'store',
]

/** Scan the given package managers concurrently. One result per source, in the
 *  backend's own order; a manager that is not installed comes back
 *  `installed: false` rather than as an error. */
export const pkgScan = (sources: string[] = SOURCE_IDS) =>
  invoke<SourceResult[]>('pkg_scan', { sources })

/** Ask npm, pip and Chocolatey which packages have newer versions. Needs the
 *  internet, unlike a scan. One result per tool that is installed. */
export const pkgCheckUpdates = () =>
  invoke<SourceUpdates[]>('pkg_check_updates')

/** Upgrade one package. Resolves when the manager exits; its output streams to
 *  the terminal meanwhile. Resolves to the `pip check` lines that name the
 *  package (pip only). */
export const pkgUpgrade = (source: string, id: string) =>
  invoke<string[]>('pkg_upgrade', { source, id })

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
