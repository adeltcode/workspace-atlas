/**
 * Parse and classify a Docker Compose status string like "running(2), exited(1)".
 * Returns a human-readable label and a dot colour for status indicators.
 */
export function composeStatusLabel(raw: string): { text: string; dot: 'running' | 'partial' | 'stopped'; running: number; total: number } {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(\w+)\((\d+)\)$/)
    return m ? { state: m[1], count: parseInt(m[2], 10) } : { state: part, count: 1 }
  })
  if (!parts.length) return { text: raw.trim() || 'stopped', dot: 'stopped', running: 0, total: 0 }
  const total   = parts.reduce((s, p) => s + p.count, 0)
  const running = parts.find(p => p.state === 'running')?.count ?? 0
  const text    = parts.map(p => `${p.count} ${p.state}`).join(', ')
  const dot     = running === 0 ? 'stopped' : running === total ? 'running' : 'partial'
  return { text, dot, running, total }
}

/** Docker port string "0.0.0.0:3000->3000/tcp, :::3000->3000/tcp" → unique published host ports. */
export function hostPorts(portStr: string): string[] {
  return [...new Set([...portStr.matchAll(/:(\d+)->/g)].map(m => m[1]).filter(p => p !== '0'))]
}

export function bytesToHuman(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`
  return `${b} B`
}

/** Like bytesToHuman but returns '-' for zero / falsy values. */
export function fmtBytes(b: number): string {
  return b ? bytesToHuman(b) : '-'
}

/**
 * Parse a size the Docker CLI printed ("1.83GB", "412MB", "0B") into bytes.
 *
 * Docker reports decimal units here, not binary, so the multipliers are powers
 * of 1000 and match `bytesToHuman` above. Anything unrecognised falls through
 * to the leading number, which is what `docker system df` prints for a plain
 * count.
 */
export function parseSizeBytes(s: string): number {
  const n = parseFloat(s)
  if (Number.isNaN(n)) return 0
  if (s.endsWith('GB')) return n * 1e9
  if (s.endsWith('MB')) return n * 1e6
  if (s.endsWith('kB')) return n * 1e3
  return n
}

/** Compact relative time from a millisecond timestamp: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Compact duration from a second count: "5m", "3h 12m", "2d 4h". For uptimes. */
export function formatDuration(secs: number): string {
  if (secs <= 0) return '-'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${secs}s`
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
