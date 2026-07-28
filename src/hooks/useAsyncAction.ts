import { useCallback, useRef, useState } from 'react'

/**
 * Runs an async action while blocking re-entry, so a button wired to it cannot be
 * triggered again until the first call settles (double-click, Enter-spam, an
 * impatient second press while the backend is still working).
 *
 * `run` drops any call made while one is already in flight, checked synchronously
 * via a ref - so it also catches a same-frame double-click that fires before React
 * has re-rendered the `disabled` state. `pending` drives the button's `disabled`
 * attribute and any "working…" label.
 */
export function useAsyncAction() {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)

  const run = useCallback(async (fn: () => unknown | Promise<unknown>) => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    try {
      await fn()
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [])

  return { run, pending }
}
