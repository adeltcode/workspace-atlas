import { useEffect, useRef } from 'react'

/** Run `fn` every `ms`, only while the window is visible: every poll here shells out, so a minimized
 *  window must not keep spawning processes. `fn` is held in a ref, so inline closures are fine. */
export function useVisiblePoll(fn: () => void, ms: number, enabled = true) {
  const saved = useRef(fn)
  saved.current = fn

  useEffect(() => {
    if (!enabled) return

    let id: ReturnType<typeof setInterval> | undefined

    // `immediate` is only set when coming back from hidden, when the numbers on screen are stale. On
    // first start the caller has usually just fetched, so firing would double the request.
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
