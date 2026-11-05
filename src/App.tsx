import { useEffect } from 'react'
import clsx from 'clsx'
import { useAppStore } from './store/appStore'
import Titlebar  from './layout/Titlebar'
import Sidebar   from './layout/Sidebar'
import MainPanel from './layout/MainPanel'
import Terminal  from './layout/Terminal'
import CommandIndex    from './components/CommandIndex'
import ShortcutsDialog from './components/ShortcutsDialog'

const SIDEBAR_MIN  = 160
const SIDEBAR_MAX  = 360
const TERMINAL_MIN = 100
const TERMINAL_MAX = 600
const MAIN_PANEL_MIN = 240

export default function App() {
  const theme          = useAppStore(s => s.theme)
  const terminalOpen   = useAppStore(s => s.terminalOpen)
  const terminalHeight = useAppStore(s => s.terminalHeight)
  const sidebarWidth   = useAppStore(s => s.sidebarWidth)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Only app-wide bindings go here. Per-module keys like Ctrl+R stay with the module that owns the data.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const s = useAppStore.getState()
        if (s.wslBusyDistro) return
        s.setIndexOpen(!s.indexOpen)
      } else if (mod && e.key === '`') {
        e.preventDefault()
        useAppStore.getState().toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Writes to the DOM during the drag and to the store only on release.
  const onSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX    = e.clientX
    const body      = e.currentTarget.parentElement as HTMLElement   // .app-body
    // Read the rendered width, because sidebarWidth is 0 until the first drag.
    const sidebarEl = body.querySelector<HTMLElement>('.sidebar')
    const startW    = sidebarEl?.offsetWidth ?? (useAppStore.getState().sidebarWidth || 200)
    let current     = startW

    const onMove = (mv: MouseEvent) => {
      current = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + mv.clientX - startX))
      body.style.setProperty('--sidebar-w', `${current}px`)
    }
    const onUp = () => {
      useAppStore.getState().setSidebarWidth(current)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // --terminal-height clamps the value written here. The terminal and its handle both read it, so
  // one write moves both. Stored on release.
  const onTerminalResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY  = e.clientY
    const content = e.currentTarget.parentElement as HTMLElement   // .app-content
    const startH  = content.querySelector<HTMLElement>('.terminal-panel')?.offsetHeight ?? TERMINAL_MIN
    let current   = startH

    content.classList.add('resizing-terminal')                     // turns off the panel's transition during the drag

    const onMove = (mv: MouseEvent) => {
      const maxHeight = Math.max(TERMINAL_MIN, Math.min(TERMINAL_MAX, content.clientHeight - MAIN_PANEL_MIN))
      current = Math.max(TERMINAL_MIN, Math.min(maxHeight, startH + startY - mv.clientY))
      content.style.setProperty('--terminal-preferred-height', `${current}px`)
    }
    const onUp = () => {
      useAppStore.getState().setTerminalHeight(current)
      content.classList.remove('resizing-terminal')
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
        {/* The open class reserves the terminal's height, so the panel never covers a page's last row. */}
        <div
          className={clsx('app-content', terminalOpen && 'app-content--terminal-open')}
          style={{ '--terminal-preferred-height': `${terminalHeight}px`, '--main-panel-min-height': `${MAIN_PANEL_MIN}px` } as React.CSSProperties}
        >
          <MainPanel />
          {terminalOpen && (
            <div className="terminal-resize-handle" onMouseDown={onTerminalResize} />
          )}
          <Terminal />
        </div>
      </div>
      <CommandIndex />
      <ShortcutsDialog />
    </div>
  )
}
