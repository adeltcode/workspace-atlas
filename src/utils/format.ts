/**
 * Parse and classify a Docker Compose status string like "running(2), exited(1)".
 * Returns a human-readable label and a dot colour for status indicators.
 */
export function composeStatusLabel(raw: string): { text: string; dot: 'running' | 'partial' | 'stopped' } {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(\w+)\((\d+)\)$/)
    return m ? { state: m[1], count: parseInt(m[2], 10) } : { state: part, count: 1 }
  })
  if (!parts.length) return { text: raw || 'unknown', dot: 'stopped' }
  const total   = parts.reduce((s, p) => s + p.count, 0)
  const running = parts.find(p => p.state === 'running')?.count ?? 0
  const text    = parts.map(p => `${p.count} ${p.state}`).join(', ')
  const dot     = running === 0 ? 'stopped' : running === total ? 'running' : 'partial'
  return { text, dot }
}

export function bytesToHuman(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`
  return `${b} B`
}

/** Like bytesToHuman but returns '—' for zero / falsy values. */
export function fmtBytes(b: number): string {
  return b ? bytesToHuman(b) : '—'
}

export function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${t}`
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${t}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}
