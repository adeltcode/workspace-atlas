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

  useEffect(() => { reload() }, [reload])

  return { status, distros, loading, error, reload }
}
