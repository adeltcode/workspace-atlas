/* The frontend half of `src-tauri/src/error.rs`. `toString` returns the sentence alone, so `String(e)`
 * call sites keep working, with no `Error:` prefix. */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/** Mirrors `ErrorKind` in `src-tauri/src/error.rs` (serde kebab-case). */
export type ErrorKind =
  | 'permission' | 'elevation' | 'busy' | 'not-found' | 'disk-full'
  | 'docker-down' | 'wsl-down' | 'network' | 'timeout' | 'cancelled'
  | 'invalid' | 'unknown'

export type RecoveryAction = 'update-wsl' | 'update-wsl-web' | 'stop-docker' | 'open-docker'
  | 'stop-wsl' | 'choose-folder' | 'show-terminal' | 'refresh-distros' | 'wsl-help' | 'conversion-guide'

export class AppError extends Error {
  readonly kind: ErrorKind
  /** What to do next. Absent when the kind implies no single next step. */
  readonly hint?: string
  /** The original text from Windows, Docker or WSL. Never shown by default. */
  readonly detail?: string
  readonly recoveryPath?: string
  readonly action?: RecoveryAction

  constructor(kind: ErrorKind, message: string, hint?: string, detail?: string, recoveryPath?: string, action?: RecoveryAction) {
    super(message)
    this.name = 'AppError'
    this.kind = kind
    this.hint = hint
    this.detail = detail
    this.recoveryPath = recoveryPath
    this.action = action
  }

  /** The sentence alone, so `String(e)` and `${e}` stay useful. */
  override toString() { return this.message }
}

function isPayload(v: unknown): v is { kind: ErrorKind; message: string; hint?: string; detail?: string; recovery_path?: string; action?: RecoveryAction } {
  return typeof v === 'object' && v !== null
    && typeof (v as { message?: unknown }).message === 'string'
    && typeof (v as { kind?: unknown }).kind === 'string'
}

/** Normalizes anything a `catch` can receive. Besides the structured payload, a Tauri-level failure
 *  rejects with a bare string and a frontend bug throws a plain `Error`. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e
  if (isPayload(e)) return new AppError(e.kind, e.message, e.hint, e.detail, e.recovery_path, e.action)
  if (e instanceof Error) return new AppError('unknown', e.message)
  const text = typeof e === 'string' ? e : JSON.stringify(e)
  return new AppError('unknown', text || 'The operation failed without reporting a reason.')
}

/** The single entry point to the Rust backend. Every `api.ts` imports `invoke` from here, so there
 *  is one place where a rejection becomes an `AppError`. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args)
  } catch (e) {
    throw toAppError(e)
  }
}
