import { useEffect, useState } from 'react'
import { Sun, Moon, Minus, Square, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAppStore } from '../store/appStore'

const win = getCurrentWindow()

export default function Titlebar() {
  const { theme, toggleTheme } = useAppStore()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    win.isMaximized().then(setIsMaximized)
    let cleanup: (() => void) | undefined
    win.onResized(async () => { setIsMaximized(await win.isMaximized()) })
      .then(fn => { cleanup = fn })
    return () => cleanup?.()
  }, [])

  return (
    <div className="titlebar">
      {/* Brand + spacer share the drag region so the whole non-button area is draggable */}
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="titlebar-logo">WA</span>
        <span className="titlebar-title">Workspace Atlas</span>
      </div>
      <div className="titlebar-spacer" data-tauri-drag-region />

      <div className="titlebar-controls">
        <button className="titlebar-btn theme-btn" onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button className="titlebar-btn" onClick={() => win.minimize()} title="Minimize">
          <Minus size={12} />
        </button>
        <button className="titlebar-btn" onClick={() => win.toggleMaximize()} title={isMaximized ? 'Restore' : 'Maximize'}>
          <Square size={11} />
        </button>
        <button className="titlebar-btn close-btn" onClick={() => win.close()} title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
