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
