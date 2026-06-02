import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { TerminalSquare, X, Trash2, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../store/appStore'

type ShellOut = { text: string; stderr: boolean }

const MAX_HISTORY = 100

export default function Terminal() {
  const { terminalLines, terminalOpen, clearTerminal, toggleTerminal, setTerminalOpen } =
    useAppStore()

  const bodyRef  = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [input,   setInput]   = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [, setHistIdx]        = useState(-1)
  const [running, setRunning] = useState(false)

  // Auto-scroll on new lines
  useEffect(() => {
    if (terminalOpen && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [terminalLines, terminalOpen])

  // Focus input when terminal opens
  useEffect(() => {
    if (terminalOpen) {
      // Small delay so the expand animation doesn't steal focus
      const t = setTimeout(() => inputRef.current?.focus(), 80)
      return () => clearTimeout(t)
    }
  }, [terminalOpen])

  // Stream shell output into the terminal log
  useEffect(() => {
    const addLine = useAppStore.getState().addTerminalLine
    const unlisten = listen<ShellOut>('shell-out', (e) => {
      addLine(e.payload.text, e.payload.stderr ? 'stderr' : 'stdout')
    })
    return () => { unlisten.then(fn => fn()) }
  }, [])

  const submit = useCallback(async () => {
    const cmd = input.trim()
    if (!cmd || running) return

    const addLine = useAppStore.getState().addTerminalLine

    // Deduplicated history (most recent first)
    setHistory(prev => [cmd, ...prev.filter(h => h !== cmd)].slice(0, MAX_HISTORY))
    setHistIdx(-1)
    setInput('')

    // Make sure terminal is visible
    if (!terminalOpen) setTerminalOpen(true)

    addLine(`$ ${cmd}`, 'cmd')
    setRunning(true)

    try {
      const exitCode = await invoke<number>('shell_run', { cmd })
      if (exitCode === 0) {
        addLine('  exited 0', 'success')
      } else {
        addLine(`  exited ${exitCode}`, 'error')
      }
    } catch (e) {
      addLine(`  error: ${String(e)}`, 'error')
    } finally {
      setRunning(false)
      // Re-focus after command completes
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [input, running, terminalOpen, setTerminalOpen])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      submit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHistIdx(prev => {
        const next = Math.min(prev + 1, history.length - 1)
        if (history[next] !== undefined) setInput(history[next])
        return next
      })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHistIdx(prev => {
        const next = Math.max(prev - 1, -1)
        setInput(next === -1 ? '' : (history[next] ?? ''))
        return next
      })
    }
  }

  return (
    <div className={clsx('terminal-panel', terminalOpen && 'open')}>
      {/* ── Header (click to toggle) ── */}
      <div className="terminal-header" onClick={toggleTerminal}>
        <div className="terminal-header-left">
          <TerminalSquare size={13} className="terminal-header-icon" />
          <span className="terminal-title">Terminal</span>
          {terminalLines.length > 0 && (
            <span className="terminal-line-count">{terminalLines.length}</span>
          )}
          {running && <span className="terminal-running-badge">running</span>}
        </div>
        <div className="terminal-header-right" onClick={(e) => e.stopPropagation()}>
          {terminalLines.length > 0 && (
            <button className="terminal-btn" onClick={clearTerminal} title="Clear terminal">
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

      {/* ── Output body ── */}
      {terminalOpen && (
        <>
          <div className="terminal-body" ref={bodyRef}>
            {terminalLines.length === 0 ? (
              <span className="terminal-empty">
                Type a command below, or run a Docker operation to see output here.
              </span>
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
          </div>

          {/* ── Input row ── */}
          <div className={clsx('terminal-input-row', running && 'terminal-input-row--busy')}>
            <span className="terminal-prompt">{running ? '⟳' : '❯'}</span>
            <input
              ref={inputRef}
              className="terminal-input"
              value={input}
              onChange={(e) => { setInput(e.target.value); setHistIdx(-1) }}
              onKeyDown={handleKeyDown}
              placeholder={running ? 'Command running…' : 'Enter command (↑↓ for history)'}
              disabled={running}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>
        </>
      )}
    </div>
  )
}
