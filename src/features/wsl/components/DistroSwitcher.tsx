import { useEffect, useRef, useState } from 'react'
import { Disc3, ChevronDown, Check } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type { WslDistro } from '../types'

/** Custom active-distro dropdown for the view-header on per-distro tabs.
 *  Replaces a native <select> so it can carry status dots, a default tag, and a
 *  selected checkmark in the app's visual language. Writes the global selection. */
export default function DistroSwitcher({ distros }: { distros: WslDistro[] }) {
  const selected    = useAppStore(s => s.wslSelectedDistro)
  const setSelected = useAppStore(s => s.setWslSelectedDistro)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (distros.length === 0) return null
  const current = distros.find(d => d.name === selected)

  const pick = (name: string) => { setSelected(name); setOpen(false) }

  return (
    <div className="wsl-switcher" ref={ref}>
      <button
        className={clsx('wsl-switcher-trigger', open && 'wsl-switcher-trigger--open')}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Active distribution"
      >
        <Disc3 size={13} className="wsl-switcher-disc" />
        <span className={clsx('wsl-switcher-dot', current?.running ? 'running' : 'stopped')} />
        <span className="wsl-switcher-name">{current?.name ?? 'Select distro'}</span>
        {current?.is_default && <span className="wsl-switcher-tag">default</span>}
        <ChevronDown size={13} className={clsx('wsl-switcher-caret', open && 'wsl-switcher-caret--open')} />
      </button>

      {open && (
        <div className="wsl-switcher-menu" role="listbox">
          <div className="wsl-switcher-menu-head">Distributions</div>
          {distros.map(d => (
            <button
              key={d.name}
              role="option"
              aria-selected={d.name === selected}
              className={clsx('wsl-switcher-item', d.name === selected && 'wsl-switcher-item--active')}
              onClick={() => pick(d.name)}
            >
              <span className={clsx('wsl-switcher-dot', d.running ? 'running' : 'stopped')} />
              <span className="wsl-switcher-item-name">{d.name}</span>
              {d.is_default && <span className="wsl-switcher-tag">default</span>}
              <span className="wsl-switcher-item-state">{d.running ? 'running' : 'stopped'}</span>
              {d.name === selected && <Check size={14} className="wsl-switcher-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
