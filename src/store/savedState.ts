import type { PersistStorage, StorageValue } from 'zustand/middleware'

const SAVE_DELAY_MS = 300
const MAX_LOG_LINES = 500
const MAX_DETAIL_CHARS = 4000

/** The store changes on every terminal line and keystroke. This keeps the newest state and writes it
 *  at most once per delay, and only when the saved text changed. */
export function delayedStorage<T>(
  disk: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  delayMs = SAVE_DELAY_MS,
): PersistStorage<T> & { flush: () => void } {
  let waiting: { name: string; value: StorageValue<T> } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let written: string | null = null

  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    waiting = null
  }

  const flush = () => {
    if (!waiting) return
    const { name, value } = waiting
    cancel()
    const text = JSON.stringify(value)
    if (text === written) return
    disk.setItem(name, text)
    written = text
  }

  return {
    // Reading means the disk is right, as after an import, so an older waiting write must not land on it.
    getItem(name) {
      cancel()
      written = disk.getItem(name)
      return written === null ? null : JSON.parse(written)
    },
    setItem(name, value) {
      waiting = { name, value }
      timer ??= setTimeout(flush, delayMs)
    },
    removeItem(name) {
      cancel()
      disk.removeItem(name)
    },
    flush,
  }
}

export function capLines(lines: string[]): string[] {
  return lines.length <= MAX_LOG_LINES
    ? lines
    : ['[Earlier output trimmed. Latest lines shown.]', ...lines.slice(-MAX_LOG_LINES)]
}

export function capDetail(detail: string | undefined): string | undefined {
  return detail && detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail
}
