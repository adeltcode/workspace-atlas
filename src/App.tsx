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

export default function App() {
  const theme          = useAppStore(s => s.theme)
  const terminalOpen   = useAppStore(s => s.terminalOpen)
  const terminalHeight = useAppStore(s => s.terminalHeight)
  const sidebarWidth   = useAppStore(s => s.sidebarWidth)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // ── Global keys. These are the only app-wide bindings; per-module keys (Ctrl+R)
  // stay with the module that owns the data they refresh.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const s = useAppStore.getState()
        s.setIndexOpen(!s.indexOpen)
      } else if (mod && e.key === '`') {
        e.preventDefault()
        useAppStore.getState().toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Sidebar resize - direct DOM write during drag, store only on release ──
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

  // ── Terminal resize - drive the --terminal-height var during drag, store on release ─
  // The terminal (absolute) and its resize handle both read --terminal-height,
  // so updating that one variable moves them together.
  const onTerminalResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY  = e.clientY
    const startH  = useAppStore.getState().terminalHeight
    const content = e.currentTarget.parentElement as HTMLElement   // .app-content
    let current   = startH

    content.classList.add('resizing-terminal')                     // disable height transition

    const onMove = (mv: MouseEvent) => {
      current = Math.max(TERMINAL_MIN, Math.min(TERMINAL_MAX, startH + startY - mv.clientY))
      content.style.setProperty('--terminal-height', `${current}px`)
    }
    const onUp = () => {
      useAppStore.getState().setTerminalHeight(current)            // persist on release
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
        {/* The open class is what reserves the terminal's height in the content
            column, so a page's last row is never buried under the panel. */}
        <div
          className={clsx('app-content', terminalOpen && 'app-content--terminal-open')}
          style={{ '--terminal-height': `${terminalHeight}px` } as React.CSSProperties}
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
