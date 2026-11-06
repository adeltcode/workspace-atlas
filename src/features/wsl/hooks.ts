import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import type { WslStatus, WslDistro } from './types'

/** Fetched once at the view level and shared across tabs, so switching tabs never refetches. */
export function useWslData() {
  const [status, setStatus]   = useState<WslStatus | null>(null)
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [reloading, setReloading] = useState(true)
  const [runningChecked, setRunningChecked] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const reload = useCallback(async () => {
    setReloading(true)
    setError(null)
    try {
      const st = await api.wslCheck()
      setStatus(st)
      setDistros(st.available ? await api.wslListDistros() : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setReloading(false)
    }
  }, [])

  // Re-reads the whole list without the loading flicker or terminal output. Keeps the last-known data
  // on a transient failure rather than blanking the view.
  const refresh = useCallback(async () => {
    try {
      setDistros(await api.wslListDistros(true))
    } catch { /* keep last-known data */ }
  }, [])

  // Only updates each distro's `running` flag, with no registry or VHD scan, and skips the state
  // update when nothing changed so it does not churn re-renders.
  const refreshRunning = useCallback(async () => {
    try {
      const names = new Set(await api.wslRunningNames())
      setDistros(prev => {
        let changed = false
        const next = prev.map(d => {
          const running = names.has(d.name)
          if (running === d.running) return d
          changed = true
          return { ...d, running }
        })
        return changed ? next : prev
      })
    } catch { /* keep last-known data */ }
  }, [])

  // Nothing watches the running flags while the page is hidden, so they stay untrusted from then
  // until this check answers. WslView holds back everything that probes a distro until then.
  const loaded = useRef(false)
  useEffect(() => {
    if (loaded.current) refreshRunning().finally(() => setRunningChecked(true))
    else { loaded.current = true; reload() }
    return () => setRunningChecked(false)
  }, [reload, refreshRunning])

  return { status, distros, loading: reloading && distros.length === 0, reloading, runningChecked, error, reload, refresh, refreshRunning }
}
