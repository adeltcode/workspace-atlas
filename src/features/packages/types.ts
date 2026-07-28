/** One installed package, as reported by its manager. */
export interface Package {
  name: string
  /** Package id where the manager has one distinct from the name (winget). */
  id: string
  version: string
  /** Newer version the manager reports as installable. Empty when not reported. */
  available: string
  /** Scanner source id, matching `SourceResult.id`. */
  source: string
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
