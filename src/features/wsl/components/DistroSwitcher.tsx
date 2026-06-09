import { Disc3, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type { WslDistro } from '../types'

/** Compact active-distro selector for the view-header on per-distro tabs.
 *  Writes the global selection; a styled wrapper over a native <select>. */
export default function DistroSwitcher({ distros }: { distros: WslDistro[] }) {
  const selected    = useAppStore(s => s.wslSelectedDistro)
  const setSelected = useAppStore(s => s.setWslSelectedDistro)

  if (distros.length === 0) return null
  const current = distros.find(d => d.name === selected)

  return (
    <div className="wsl-distro-switcher" title="Active distribution">
      <Disc3 size={13} className="wsl-switcher-icon" />
      <span className={clsx('wsl-switcher-dot', current?.running ? 'running' : 'stopped')} />
      <select
        className="wsl-switcher-select"
        value={selected ?? ''}
        onChange={e => setSelected(e.target.value)}
        aria-label="Active distribution"
      >
        {distros.map(d => (
          <option key={d.name} value={d.name}>{d.name}{d.is_default ? ' (default)' : ''}</option>
        ))}
      </select>
      <ChevronDown size={12} className="wsl-switcher-caret" />
    </div>
  )
}
