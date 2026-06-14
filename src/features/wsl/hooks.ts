import { useCallback, useEffect, useState } from 'react'
import * as api from './api'
import type { WslStatus, WslDistro } from './types'

/** Hoisted WSL data source (status + distro list), mirroring Docker's
 *  useDockerData: fetched once at the view level and shared across tabs so
 *  switching tabs never refetches. `reload` re-runs the probe. */
export function useWslData() {
  const [status, setStatus]   = useState<WslStatus | null>(null)
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const st = await api.wslCheck()
      setStatus(st)
      setDistros(st.available ? await api.wslListDistros() : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Silent full refresh: re-reads the whole list (sizes, added/removed distros)
  // without the loading flicker or terminal output. Used on navigation/focus.
  // Keeps the last-known data on a transient failure rather than blanking the view.
  const refresh = useCallback(async () => {
    try {
      setDistros(await api.wslListDistros(true))
    } catch { /* keep last-known data */ }
  }, [])

  // Cheap running-state poll: only updates each distro's `running` flag (no heavy
  // registry/VHD scan), and no-ops the state update when nothing changed so it
  // doesn't churn re-renders. Used for the frequent background tick.
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

  useEffect(() => { reload() }, [reload])

  return { status, distros, loading, error, reload, refresh, refreshRunning }
}
