import { useEffect, useState } from 'react'
import type { WslDistro } from './types'

/** Track a selected distro name, defaulting to the default distro (or the first)
 *  once the list loads, and re-selecting if the current choice disappears. */
export function useDistroSelection(distros: WslDistro[]) {
  const [selected, setSelected] = useState('')
  useEffect(() => {
    if (distros.length === 0) return
    if (!selected || !distros.some(d => d.name === selected)) {
      setSelected((distros.find(d => d.is_default) ?? distros[0]).name)
    }
  }, [distros, selected])
  return [selected, setSelected] as const
}
