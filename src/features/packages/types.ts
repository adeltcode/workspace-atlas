/** One installed package, as reported by its manager. */
export interface Package {
  name: string
  /** Package id where the manager has one distinct from the name (winget). */
  id: string
  version: string
  /** Newer version the manager reports as installable. Empty when not reported.
   *  A scan fills this for winget; a check for updates adds npm, pip and
   *  Chocolatey. */
  available: string
  /** Scanner source id, matching `SourceResult.id`. */
  source: string
  /** The exact command an upgrade runs. Null when this package cannot be
   *  upgraded here. */
  upgrade_command: string | null
  /** Whether Atlas can uninstall this package (winget, pip, npm, VS Code). */
  uninstallable: boolean
  /** Installed or last updated, as Unix seconds. Null when unknown. */
  updated: number | null
  /** Empty when the source does not name one. */
  publisher: string
  /** Install folder or file. Empty when unknown. */
  location: string
}

/** One package with a newer version, from a check for updates. */
export interface PackageUpdate {
  id: string
  available: string
  upgrade_command: string | null
}

/** Outcome of checking one package manager for updates. */
export interface SourceUpdates {
  source: string
  label: string
  updates: PackageUpdate[]
  /** Set when the check failed, which does not mean nothing is outdated. */
  error: string | null
}

/** What removing a package would break, gathered before anything runs. */
export interface UninstallCheck {
  command: string
  /** Puts the package back at its current version. Logged, never run. */
  reinstall_command: string
  /** A tool other tools stand on. Removing it needs the id typed out. */
  core: boolean
  /** Installed packages that require this one. Null when unknown (winget). */
  needed_by: string[] | null
  /** Commands on PATH that disappear with the package. */
  commands: string[]
  /** Processes running from the app's folder. Null when unknown or n/a. */
  running: string[] | null
  /** Files pip would delete. Null for other managers. */
  files: number | null
  /** What the check could not see, one sentence each. */
  limits: string[]
}

/** Outcome of scanning one package manager. */
export interface SourceResult {
  id: string
  label: string
  /** The command that was run, copy-pasteable into PowerShell. */
  command: string
  /** False when the manager is not on PATH. Absent, not broken. */
  installed: boolean
  packages: Package[]
  error: string | null
}
