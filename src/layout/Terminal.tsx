import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { TerminalSquare, X, Trash2, ChevronDown, Square, ScrollText } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../store/appStore'
import ComposeLogPanel from '../features/docker/components/ComposeLogPanel'

type ShellOut  = { text: string; stderr: boolean }
type ShellDone = { exit_code: number }

const MAX_HISTORY = 100

export default function Terminal() {
  const { terminalLines, terminalOpen, clearTerminal, toggleTerminal, setTerminalOpen } =
    useAppStore()

  // ── Terminal tabs: shell vs. compose logs ───────────────────────────────────
  const terminalTab       = useAppStore(s => s.terminalTab)
  const setTerminalTab    = useAppStore(s => s.setTerminalTab)
  const composeLogContext = useAppStore(s => s.composeLogContext)
  const closeComposeLogs  = useAppStore(s => s.closeComposeLogs)

  // Fall back to the shell tab if the logs context has been cleared
  const activeTab: 'shell' | 'logs' =
    terminalTab === 'logs' && composeLogContext ? 'logs' : 'shell'

  const bodyRef  = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [input,   setInput]   = useState('')
  const [history, setHistory] = useState<string[]>([])

  // Use refs for values that must be read live inside async callbacks or
  // event handlers — avoids stale-closure double-submit and history bugs.
  const histIdxRef = useRef(-1)
  const runningRef = useRef(false)

  // Separate state just for rendering the busy UI
  const [running, setRunning] = useState(false)

  // ── Auto-scroll ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (terminalOpen && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [terminalLines, terminalOpen])

  // ── Focus input when terminal opens ─────────────────────────────────────────
  useEffect(() => {
    if (terminalOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 80)
      return () => clearTimeout(t)
    }
  }, [terminalOpen])

  // ── Stream shell stdout/stderr ───────────────────────────────────────────────
  // Lines are buffered for one frame (16 ms) and flushed in a single store
  // update so rapid output doesn't trigger a re-render per line.
  useEffect(() => {
    let cancelled   = false
    let unlistenFn: (() => void) | null = null
    const buffer: Array<{ text: string; type: 'stdout' | 'stderr' }> = []
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      if (!cancelled && buffer.length) {
        useAppStore.getState().addTerminalLines(buffer.splice(0))
      }
      timer = null
    }

    listen<ShellOut>('shell-out', (e) => {
      buffer.push({ text: e.payload.text, type: e.payload.stderr ? 'stderr' : 'stdout' })
      if (!timer) timer = setTimeout(flush, 16)
    }).then(fn => {
      if (cancelled) fn()
      else unlistenFn = fn
    })

    return () => {
      cancelled = true
      if (timer) { clearTimeout(timer); timer = null }
      unlistenFn?.()
    }
  }, [])

  // ── Handle process completion ────────────────────────────────────────────────
  // shell-done is emitted by Rust AFTER all stdout/stderr lines are flushed,
  // so appending the exit line here is always in the correct order.
  useEffect(() => {
    const addLine = useAppStore.getState().addTerminalLine
    let cancelled   = false
    let unlistenFn: (() => void) | null = null

    listen<ShellDone>('shell-done', (e) => {
      const { exit_code } = e.payload
      addLine(
        exit_code === 0 ? '  exited 0' : `  exited ${exit_code}`,
        exit_code === 0 ? 'success' : 'error',
      )
      runningRef.current = false
      setRunning(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }).then(fn => {
      if (cancelled) fn()
      else unlistenFn = fn
    })

    return () => {
      cancelled = true
      unlistenFn?.()
    }
  }, [])

  // ── Kill running command ─────────────────────────────────────────────────────
  const killCommand = useCallback(async () => {
    try { await invoke('shell_kill') }
    catch { /* ignore — process may have already exited */ }
  }, [])

  // ── Submit command ───────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    const cmd = input.trim()
    // Read from ref — not the closure-captured boolean — so rapid Enter presses
    // cannot bypass the guard before React re-renders with running=true.
    if (!cmd || runningRef.current) return

    const addLine = useAppStore.getState().addTerminalLine
    setHistory(prev => [cmd, ...prev.filter(h => h !== cmd)].slice(0, MAX_HISTORY))
    histIdxRef.current = -1
    setInput('')
    if (!terminalOpen) setTerminalOpen(true)

    addLine(`$ ${cmd}`, 'cmd')
    runningRef.current = true
    setRunning(true)

    try {
      // Await the invoke so errors on spawn (e.g. powershell not found) are caught.
      // The exit line and running=false are handled by the shell-done listener.
      await invoke('shell_run', { cmd })
    } catch (e) {
      // Process failed to start — no shell-done will fire, handle inline
      addLine(`  error: ${String(e)}`, 'error')
      runningRef.current = false
      setRunning(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [input, terminalOpen, setTerminalOpen])

  // ── Keyboard handling ────────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      submit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(histIdxRef.current + 1, history.length - 1)
      histIdxRef.current = next
      if (history[next] !== undefined) setInput(history[next])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.max(histIdxRef.current - 1, -1)
      histIdxRef.current = next
      setInput(next === -1 ? '' : (history[next] ?? ''))
    }
  }

  // Ctrl+C at the panel level — only fires kill when nothing is selected
  // (so Ctrl+C still works as "copy" when the user has text highlighted)
  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (running && e.ctrlKey && e.key === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault()
      killCommand()
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div
      className={clsx('terminal-panel', terminalOpen && 'open')}
      onKeyDown={handlePanelKeyDown}
    >
      {/* Header: tab bar + controls */}
      <div className="terminal-header">
        <div className="terminal-tabs" onClick={e => e.stopPropagation()}>
          <button
            className={clsx('terminal-tab', activeTab === 'shell' && 'active')}
            onClick={() => { setTerminalTab('shell'); if (!terminalOpen) setTerminalOpen(true) }}
          >
            <TerminalSquare size={12} />
            <span className="terminal-tab-label">Terminal</span>
            {terminalLines.length > 0 && (
              <span className="terminal-line-count">{terminalLines.length}</span>
            )}
            {running && <span className="terminal-running-badge">running</span>}
          </button>
          {composeLogContext && (
            <button
              className={clsx('terminal-tab', activeTab === 'logs' && 'active')}
              onClick={() => { setTerminalTab('logs'); if (!terminalOpen) setTerminalOpen(true) }}
              title={`Logs — ${composeLogContext.project.name}`}
            >
              <ScrollText size={12} />
              <span className="terminal-tab-label">Logs — {composeLogContext.project.name}</span>
              <span
                className="terminal-tab-close"
                onClick={e => { e.stopPropagation(); closeComposeLogs() }}
                title="Close logs"
              >
                <X size={11} />
              </span>
            </button>
          )}
        </div>

        {/* Empty strip — click to expand / collapse the panel */}
        <div className="terminal-header-grip" onClick={toggleTerminal} />

        <div className="terminal-header-right" onClick={e => e.stopPropagation()}>
          {activeTab === 'shell' && running && (
            <button
              className="terminal-btn terminal-kill-btn"
              onClick={killCommand}
              title="Kill running command (Ctrl+C)"
            >
              <Square size={10} />
            </button>
          )}
          {activeTab === 'shell' && terminalLines.length > 0 && (
            <button className="terminal-btn" onClick={clearTerminal} title="Clear terminal">
              <Trash2 size={12} />
            </button>
          )}
          <button
            className="terminal-btn"
            onClick={toggleTerminal}
            title={terminalOpen ? 'Collapse' : 'Expand'}
          >
            {terminalOpen ? <X size={12} /> : <ChevronDown size={12} className="rotate-180" />}
          </button>
        </div>
      </div>

      {terminalOpen && (
        <>
          {/* Shell tab — hidden (not unmounted) while the logs tab is active */}
          <div className="terminal-shell" style={{ display: activeTab === 'shell' ? 'flex' : 'none' }}>
            {/* Output — user-select: text so lines can be selected and copied */}
            <div className="terminal-body" ref={bodyRef} tabIndex={-1}>
              {terminalLines.length === 0
                ? (
                  <span className="terminal-empty">
                    Type a command below, or run a Docker operation to see output here.
                  </span>
                )
                : terminalLines.map(line => (
                  <div key={line.id} className={clsx('terminal-line', `tl-${line.type}`)}>
                    <span className="tl-text">{line.text}</span>
                  </div>
                ))
              }
            </div>

            <div className={clsx('terminal-input-row', running && 'terminal-input-row--busy')}>
              <span className="terminal-prompt">{running ? '⟳' : '❯'}</span>
              <input
                ref={inputRef}
                className="terminal-input"
                value={input}
                onChange={e => { setInput(e.target.value); histIdxRef.current = -1 }}
                onKeyDown={handleKeyDown}
                placeholder={running ? 'Running… (Ctrl+C or ■ to stop)' : 'Enter command  (↑↓ history)'}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
              />
            </div>
          </div>

          {/* Logs tab — kept mounted while a project's log context exists so the
              streamed buffer survives switching back to the shell tab. */}
          {composeLogContext && (
            <div className="terminal-logs-host" style={{ display: activeTab === 'logs' ? 'flex' : 'none' }}>
              <ComposeLogPanel
                project={composeLogContext.project}
                containers={composeLogContext.containers}
                configFile={composeLogContext.configFile}
                initialService={composeLogContext.initialService ?? undefined}
                onClose={closeComposeLogs}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
