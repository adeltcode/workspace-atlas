import { useCallback, useRef, useState } from 'react'

/** Drops any call made while one is in flight. The check is a synchronous ref, so it also catches a
 *  same-frame double-click that fires before React re-renders `disabled`. */
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
