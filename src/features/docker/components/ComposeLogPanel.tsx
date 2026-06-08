import { useState, useEffect, useRef, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Pause, Play, Trash2, Copy, Search, X } from 'lucide-react'
import clsx from 'clsx'
import * as api from '../api'
import type { ComposeProject, DockerContainer } from '../types'

interface Props {
  project:         ComposeProject
  containers:      DockerContainer[]
  configFile:      string
  initialService?: string
  onClose:         () => void
}

export default function ComposeLogPanel({ project, containers, configFile, initialService, onClose }: Props) {
  // Services available for this project
  const services = [...new Set(
    containers
      .filter(c => c.compose_project === project.name && c.compose_service)
      .map(c => c.compose_service!)
  )]

  const [enabled,  setEnabled]  = useState<Set<string>>(() =>
    initialService ? new Set([initialService]) : new Set(services)
  )
  const [lines,    setLines]    = useState<string[]>([])
  const [paused,   setPaused]   = useState(false)
  const [search,   setSearch]   = useState('')
  const [watching, setWatching] = useState(false)

  const pausedRef    = useRef(false)
  const bufferRef    = useRef<string[]>([])
  const bottomRef    = useRef<HTMLDivElement>(null)

  pausedRef.current = paused

  // Start/restart watch whenever enabled set changes
  const startWatch = useCallback(async () => {
    if (enabled.size === 0) return
    setWatching(true)
    setLines([])
    bufferRef.current = []
    const svcList = [...enabled]
    await api.composeLogsWatch(configFile, svcList).catch(() => {})
    setWatching(false)
  }, [configFile, enabled]) // eslint-disable-line

  useEffect(() => {
    startWatch()
    return () => { api.composeLogsStop().catch(() => {}) }
  }, [enabled]) // eslint-disable-line

  // Listen to batched log events
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<string[]>('compose-log-batch', e => {
      if (pausedRef.current) {
        bufferRef.current.push(...e.payload)
        return
      }
      setLines(prev => [...prev, ...e.payload].slice(-5000))
    }).then(fn => { unlisten = fn })
    return () => { unlisten?.() }
  }, [])

  // Auto-scroll to bottom when not searching
  useEffect(() => {
    if (!search && !paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines, search, paused])

  const handlePause = () => {
    if (paused) {
      // Resume: flush buffer
      setLines(prev => [...prev, ...bufferRef.current].slice(-5000))
      bufferRef.current = []
    }
    setPaused(p => !p)
  }

  const handleClear = () => { setLines([]); bufferRef.current = [] }

  const handleCopy = () => {
    const text = visibleLines.join('\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }

  const toggleService = (svc: string) => {
    setEnabled(prev => {
      const next = new Set(prev)
      if (next.has(svc)) { if (next.size > 1) next.delete(svc) }
      else next.add(svc)
      return next
    })
  }

  const visibleLines = search
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines

  return (
    <div className="log-panel">
      {/* Header */}
      <div className="log-panel-header">
        <span className="log-panel-title">Logs — {project.name}</span>

        {/* Service filter chips */}
        <div className="log-panel-chips">
          {services.map(svc => (
            <button
              key={svc}
              className={clsx('log-chip', enabled.has(svc) && 'active')}
              onClick={() => toggleService(svc)}
            >
              {svc}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Controls */}
        <div className="log-panel-controls">
          <button className={clsx('log-ctrl-btn', paused && 'active')} onClick={handlePause} title={paused ? 'Resume' : 'Pause'}>
            {paused ? <Play size={11} /> : <Pause size={11} />}
          </button>
          <button className="log-ctrl-btn" onClick={handleClear} title="Clear">
            <Trash2 size={11} />
          </button>
          <button className="log-ctrl-btn" onClick={handleCopy} title="Copy visible lines">
            <Copy size={11} />
          </button>
          <button className="log-ctrl-btn" onClick={onClose} title="Close">
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="log-panel-search">
        <Search size={11} className="log-search-icon" />
        <input
          className="log-search-input"
          placeholder="Filter lines…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button className="log-search-clear" onClick={() => setSearch('')}><X size={10} /></button>
        )}
      </div>

      {/* Log output */}
      <div className="log-panel-body">
        {visibleLines.length === 0 && !watching && (
          <span className="log-empty">No log lines yet.</span>
        )}
        {visibleLines.map((line, i) => {
          const isErr = line.includes('Error') || line.includes('error') || line.startsWith('[err]')
          const isWarn = line.includes('warn') || line.includes('Warn')
          return (
            <div key={i} className={clsx('log-line',
              isErr && 'log-line--error',
              isWarn && 'log-line--warn',
              search && line.toLowerCase().includes(search.toLowerCase()) && 'log-line--match'
            )}>
              {search ? highlightMatch(line, search) : line}
            </div>
          )
        })}
        {paused && bufferRef.current.length > 0 && (
          <div className="log-paused-badge">
            {bufferRef.current.length} lines buffered — click Resume to show
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function highlightMatch(line: string, search: string): React.ReactNode {
  const idx = line.toLowerCase().indexOf(search.toLowerCase())
  if (idx === -1) return line
  return (
    <>
      {line.slice(0, idx)}
      <mark className="log-highlight">{line.slice(idx, idx + search.length)}</mark>
      {line.slice(idx + search.length)}
    </>
  )
}
