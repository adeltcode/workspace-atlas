import { useEffect, useRef } from 'react'
import { TerminalSquare, X, Trash2, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../store/appStore'

export default function Terminal() {
  const { terminalLines, terminalOpen, clearTerminal, toggleTerminal } = useAppStore()
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (terminalOpen && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [terminalLines, terminalOpen])

  return (
    <div className={clsx('terminal-panel', terminalOpen && 'open')}>
      {/* Header */}
      <div className="terminal-header" onClick={toggleTerminal}>
        <div className="terminal-header-left">
          <TerminalSquare size={13} className="terminal-header-icon" />
          <span className="terminal-title">Terminal</span>
          {terminalLines.length > 0 && (
            <span className="terminal-line-count">{terminalLines.length}</span>
          )}
        </div>
        <div className="terminal-header-right" onClick={(e) => e.stopPropagation()}>
          {terminalLines.length > 0 && (
            <button
              className="terminal-btn"
              onClick={clearTerminal}
              title="Clear terminal"
            >
              <Trash2 size={12} />
            </button>
          )}
          <button
            className="terminal-btn"
            onClick={toggleTerminal}
            title={terminalOpen ? 'Collapse' : 'Expand'}
          >
            {terminalOpen
              ? <X size={12} />
              : <ChevronDown size={12} className="rotate-180" />}
          </button>
        </div>
      </div>

      {/* Body */}
      {terminalOpen && (
        <div className="terminal-body" ref={bodyRef}>
          {terminalLines.length === 0 ? (
            <span className="terminal-empty">No output yet — run an operation to see commands here.</span>
          ) : (
            terminalLines.map((line) => (
              <div key={line.id} className={clsx('terminal-line', `tl-${line.type}`)}>
                <span className="tl-ts">
                  {new Date(line.ts).toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                  })}
                </span>
                <span className="tl-text">{line.text}</span>
              </div>
            ))
          )}
          <div className="terminal-cursor" />
        </div>
      )}
    </div>
  )
}
