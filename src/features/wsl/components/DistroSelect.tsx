import type { ReactNode } from 'react'
import { Disc3 } from 'lucide-react'
import type { WslDistro } from '../types'

/** Labelled distro picker, shared by the Dashboard, Performance, Startup, and
 *  wsl.conf tabs. Dumb: the parent owns the selected value. */
export default function DistroSelect({ distros, value, onChange, note }: {
  distros: WslDistro[]
  value: string
  onChange: (name: string) => void
  note?: ReactNode
}) {
  return (
    <div className="wslconf-distro-bar">
      <Disc3 size={14} className="wslconf-distro-icon" />
      <label className="wslconf-distro-label">Distribution</label>
      <select className="wslconf-distro-select" value={value} onChange={e => onChange(e.target.value)}>
        {distros.map(d => (
          <option key={d.name} value={d.name}>{d.name}{d.is_default ? ' (default)' : ''}</option>
        ))}
      </select>
      {note && <span className="wslconf-distro-note">{note}</span>}
    </div>
  )
}
