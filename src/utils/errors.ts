/* The frontend half of the typed error.
 *
 * `src-tauri/src/error.rs` classifies every command failure into a kind, a
 * plain sentence and a recovery hint. This file is what turns that JSON back
 * into something a `catch` block can use.
 *
 * The important detail is `toString`. Eighty-eight call sites in this app were
 * written as `setError(String(e))`, and they keep working unchanged: `String()`
 * on an AppError returns the sentence on its own, with no `Error:` prefix and
 * no `[object Object]`. Surfaces that want the hint, the raw detail or a
 * recovery button reach for the fields instead. */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/** Mirrors `ErrorKind` in `src-tauri/src/error.rs` (serde kebab-case). */
export type ErrorKind =
  | 'permission' | 'elevation' | 'busy' | 'not-found' | 'disk-full'
  | 'docker-down' | 'wsl-down' | 'network' | 'timeout' | 'cancelled'
  | 'invalid' | 'unknown'

export class AppError extends Error {
  readonly kind: ErrorKind
  /** What to do next. Absent when the kind implies no single next step. */
  readonly hint?: string
  /** The original text from Windows, Docker or WSL. Never shown by default. */
  readonly detail?: string

  constructor(kind: ErrorKind, message: string, hint?: string, detail?: string) {
    super(message)
    this.name = 'AppError'
    this.kind = kind
    this.hint = hint
    this.detail = detail
  }

  /** The sentence alone, so `String(e)` and `${e}` stay useful. */
  override toString() { return this.message }
}

function isPayload(v: unknown): v is { kind: ErrorKind; message: string; hint?: string; detail?: string } {
  return typeof v === 'object' && v !== null
    && typeof (v as { message?: unknown }).message === 'string'
    && typeof (v as { kind?: unknown }).kind === 'string'
}

/**
 * Normalise anything a `catch` can receive.
 *
 * The structured payload is the expected case. The rest are real: a Tauri-level
 * failure (an unregistered command, a serialisation fault) rejects with a bare
 * string, and a bug in our own frontend code throws a plain `Error`.
 */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e
  if (isPayload(e)) return new AppError(e.kind, e.message, e.hint, e.detail)
  if (e instanceof Error) return new AppError('unknown', e.message)
  const text = typeof e === 'string' ? e : JSON.stringify(e)
  return new AppError('unknown', text || 'The operation failed without reporting a reason.')
}

/**
 * The single entry point to the Rust backend.
 *
 * Every `api.ts` imports `invoke` from here rather than from Tauri directly, so
 * there is one place where a rejection becomes an `AppError` and no call site
 * has to remember to normalise.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args)
  } catch (e) {
    throw toAppError(e)
  }
}
