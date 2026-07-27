import { useEffect, useRef } from 'react'

/**
 * Run `fn` every `ms`, but only while the window is actually being looked at.
 *
 * Every poll in this app shells out: `docker stats`, `wsl -l`, a bash probe
 * piped into a distro. Left ungated, a minimised window keeps spawning those
 * processes forever, which is how a background utility earns a reputation for
 * eating battery. On becoming visible again the callback fires once immediately
 * so the user never reads stale numbers.
 *
 * `fn` is held in a ref, so callers can pass an inline closure without
 * restarting the timer on every render.
 */
export function useVisiblePoll(fn: () => void, ms: number, enabled = true) {
  const saved = useRef(fn)
  saved.current = fn

  useEffect(() => {
    if (!enabled) return

    let id: ReturnType<typeof setInterval> | undefined

    // `immediate` is only set when coming back from hidden: the numbers on
    // screen are stale by then. On first start the caller has usually just
    // fetched, so firing here would double the request.
    const start = (immediate = false) => {
      if (id !== undefined) return
      if (immediate) saved.current()
      id = setInterval(() => saved.current(), ms)
    }
    const stop = () => {
      if (id === undefined) return
      clearInterval(id)
      id = undefined
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else start(true)
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ms, enabled])
}
