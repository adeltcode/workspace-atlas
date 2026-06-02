import { useEffect } from 'react'
import { useAppStore } from './store/appStore'
import Titlebar  from './layout/Titlebar'
import Sidebar   from './layout/Sidebar'
import MainPanel from './layout/MainPanel'
import Terminal  from './layout/Terminal'

const SIDEBAR_MIN  = 160
const SIDEBAR_MAX  = 360
const TERMINAL_MIN = 100
const TERMINAL_MAX = 600

export default function App() {
  const theme        = useAppStore(s => s.theme)
  const terminalOpen = useAppStore(s => s.terminalOpen)
  const sidebarWidth = useAppStore(s => s.sidebarWidth)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // ── Sidebar resize — direct DOM write during drag, store only on release ──
  const onSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX    = e.clientX
    const body      = e.currentTarget.parentElement as HTMLElement   // .app-body
    // Capture the actual rendered width (works even when sidebar is fit-content)
    const sidebarEl = body.querySelector<HTMLElement>('.sidebar')
    const startW    = sidebarEl?.offsetWidth ?? (useAppStore.getState().sidebarWidth || 200)
    let current     = startW

    const onMove = (mv: MouseEvent) => {
      current = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + mv.clientX - startX))
      body.style.setProperty('--sidebar-w', `${current}px`)
    }
    const onUp = () => {
      useAppStore.getState().setSidebarWidth(current)             // persist on release
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Terminal resize — direct DOM write during drag, store only on release ─
  const onTerminalResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY     = e.clientY
    const startH     = useAppStore.getState().terminalHeight
    const terminalEl = document.querySelector<HTMLElement>('.terminal-panel')
    if (!terminalEl) return
    let current = startH

    // Kill the CSS height transition for the duration of the drag —
    // without this, every pixel move triggers a 0.3s animation causing lag.
    terminalEl.style.transition = 'none'

    const onMove = (mv: MouseEvent) => {
      current = Math.max(TERMINAL_MIN, Math.min(TERMINAL_MAX, startH + startY - mv.clientY))
      terminalEl.style.height = `${current}px`
    }
    const onUp = () => {
      useAppStore.getState().setTerminalHeight(current)           // persist on release
      terminalEl.style.transition = ''                           // restore transition
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="app-shell">
      <Titlebar />
      <div
        className="app-body"
        style={sidebarWidth > 0
          ? { '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties
          : {}}
      >
        <Sidebar />
        <div className="sidebar-resize-handle" onMouseDown={onSidebarResize} />
        <div className="app-content">
          <MainPanel />
          {terminalOpen && (
            <div className="terminal-resize-handle" onMouseDown={onTerminalResize} />
          )}
          <Terminal />
        </div>
      </div>
    </div>
  )
}
