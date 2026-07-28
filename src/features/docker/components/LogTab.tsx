import { Shield, Layers, Zap, CheckCircle, XCircle, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type { LogEntry } from '../types'

const LEVEL_META = {
  1: { icon: Shield, label: 'Safe',    color: 'success' },
  2: { icon: Layers, label: 'Deep',    color: 'warning' },
  3: { icon: Zap,    label: 'Nuclear', color: 'danger'  },
} as const

function formatTime(ts: number) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts))
}

function LogCard({ entry }: { entry: LogEntry }) {
  const meta = LEVEL_META[entry.level as keyof typeof LEVEL_META]
  if (!meta) return null
  const { icon: Icon, label, color } = meta

  return (
    <div className={clsx('log-card', entry.success ? 'log-card-ok' : 'log-card-err')}>
      <div className="log-card-header">
        <div className="log-card-left">
          <span className={clsx('log-level-badge', `log-badge--${color}`)}>
            <Icon size={11} />Level {entry.level} - {label}
          </span>
          <span className="log-ts">{formatTime(entry.timestamp)}</span>
        </div>
        {entry.success
          ? <CheckCircle size={15} className="log-status-ok" />
          : <XCircle    size={15} className="log-status-err" />}
      </div>
      <div className="log-card-output">
        {entry.lines.map((line, i) => (
          <div key={i} className={clsx('log-line', line.startsWith('$') && 'log-cmd', line.startsWith('[err]') && 'log-err')}>
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function LogTab() {
  const { dockerLogs, clearDockerLogs } = useAppStore()

  if (!dockerLogs.length) {
    return (
      <div className="log-empty">
        <p className="empty-state">No prune runs yet.</p>
        <p className="empty-sub">Run a prune from the Prune tab - history appears here.</p>
      </div>
    )
  }

  return (
    <div className="log-tab">
      <div className="log-tab-header">
        <p className="section-label" style={{ margin: 0 }}>Run History ({dockerLogs.length} / 10)</p>
        <button className="btn-clear-log" onClick={clearDockerLogs} title="Clear history">
          <Trash2 size={13} />Clear
        </button>
      </div>
      <div className="log-list">
        {dockerLogs.map(entry => <LogCard key={entry.id} entry={entry} />)}
      </div>
    </div>
  )
}
