import { useState, useEffect, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { useAppStore } from '../store/appStore'
import { bytesToHuman } from '../utils/format'

// Shared live CPU% / memory chart pair with hover tooltips and a legend that
// toggles series. Extracted from the Docker overview so the WSL dashboard can
// render the identical visualization for distros.

export interface LiveSeriesInput {
  name: string
  cpu: number[]
  mem: number[]
  /** Optional stable colour; falls back to the theme chart palette by index. */
  color?: string
}

interface LiveSeries extends LiveSeriesInput {
  color: string
}

export function getChartColors(): string[] {
  const style = getComputedStyle(document.documentElement)
  return Array.from({ length: 8 }, (_, i) =>
    style.getPropertyValue(`--chart-${i + 1}`).trim()
  )
}

function padLeft(arr: number[], n: number): number[] {
  if (arr.length >= n) return arr.slice(-n)
  return [...Array(n - arr.length).fill(0), ...arr]
}

const CH = 148
const YT = 8
const YB = 22
const XL = 44
const XR = 8

function ChartPanel({
  type, series, numPoints, realDataStart, hidden, hoverIdx, maxCpu, maxMem, stepSecs, onHover, onLeave,
}: {
  type:          'cpu' | 'mem'
  series:        LiveSeries[]
  numPoints:     number
  realDataStart: number
  hidden:        Set<string>
  hoverIdx:      number | null
  maxCpu:        number
  maxMem:        number
  stepSecs:      number
  onHover:       (idx: number) => void
  onLeave:       () => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [svgW, setSvgW] = useState(300)

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSvgW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const innerW = svgW - XL - XR
  const innerH = CH - YT - YB

  const xAt = (i: number) =>
    XL + (numPoints <= 1 ? innerW / 2 : (i / (numPoints - 1)) * innerW)

  const yFor = (v: number) => {
    const scale = type === 'cpu' ? maxCpu : maxMem
    return YT + (1 - Math.min(v, scale) / (scale || 1)) * innerH
  }

  const ticks = (() => {
    if (type === 'mem') {
      const step = maxMem / 4
      return [0, step, step * 2, step * 3, maxMem]
    }
    // CPU: find the smallest "nice" step that produces integer grid lines
    const niceSteps = [1, 2, 5, 10, 20, 25, 50, 100]
    const rawStep   = maxCpu / 4
    const step      = niceSteps.find(s => s >= rawStep) ?? rawStep
    const result: number[] = []
    for (let v = 0; v <= maxCpu; v += step) result.push(v)
    if (result[result.length - 1] < maxCpu) result.push(maxCpu)
    return result
  })()

  const tickLabel = (v: number) =>
    type === 'cpu' ? `${Math.round(v)}%` : bytesToHuman(v)

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = Math.round((e.clientX - rect.left - XL) / innerW * (numPoints - 1))
    onHover(Math.max(0, Math.min(numPoints - 1, raw)))
  }

  const visible    = series.filter(s => !hidden.has(s.name))
  const timeLabels = Array.from(new Set([0, Math.floor((numPoints - 1) / 2), numPoints - 1]))

  return (
    <div className="live-chart-wrap">
      <div className="live-chart-title">{type === 'cpu' ? 'CPU %' : 'Memory'}</div>
      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          className="live-chart-svg"
          height={CH}
          width="100%"
          onMouseMove={handleMove}
          onMouseLeave={onLeave}
        >
          {ticks.map(v => {
            const y = yFor(v)
            return (
              <g key={v}>
                <line x1={XL} y1={y} x2={svgW - XR} y2={y}
                  stroke="var(--color-border-light)"
                  strokeWidth={v === 0 ? 1 : 0.5} />
                <text x={XL - 5} y={y} fontSize={9}
                  fill="var(--color-text-tertiary)" textAnchor="end"
                  dominantBaseline="middle" fontFamily="inherit">
                  {tickLabel(v)}
                </text>
              </g>
            )
          })}

          {visible.map(s => {
            const vals = padLeft(type === 'cpu' ? s.cpu : s.mem, numPoints)
            const pts  = vals.map((v, i) => ({ x: xAt(i), y: yFor(v) }))
            const line = pts.map(p => `${p.x},${p.y}`).join(' ')
            const area = [
              ...pts,
              { x: xAt(numPoints - 1), y: YT + innerH },
              { x: xAt(0), y: YT + innerH },
            ].map(p => `${p.x},${p.y}`).join(' ')
            const gid  = `lcg-${type}-${s.name.replace(/\W/g, '_')}`
            const last = pts[pts.length - 1]
            return (
              <g key={s.name}>
                <defs>
                  <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={s.color} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <polygon points={area} fill={`url(#${gid})`} />
                <polyline points={line} fill="none" stroke={s.color}
                  strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                {hoverIdx === null && (
                  <circle cx={last.x} cy={last.y} r={3} fill={s.color} />
                )}
              </g>
            )
          })}

          {hoverIdx !== null && (
            <>
              <line
                x1={xAt(hoverIdx)} y1={YT}
                x2={xAt(hoverIdx)} y2={YT + innerH}
                stroke="var(--color-text-secondary)"
                strokeWidth={1} strokeDasharray="3 3"
              />
              {visible.map(s => {
                const vals = padLeft(type === 'cpu' ? s.cpu : s.mem, numPoints)
                return (
                  <circle key={s.name}
                    cx={xAt(hoverIdx)} cy={yFor(vals[hoverIdx])}
                    r={4} fill={s.color}
                    stroke="var(--color-bg-secondary)" strokeWidth={1.5}
                  />
                )
              })}
            </>
          )}

          {timeLabels.map(i => {
            const sAgo = (numPoints - 1 - i) * stepSecs
            return (
              <text key={i} x={xAt(i)} y={CH - 5} fontSize={9}
                fill="var(--color-text-tertiary)" textAnchor="middle"
                fontFamily="inherit">
                {sAgo === 0 ? 'now' : `-${sAgo}s`}
              </text>
            )
          })}
        </svg>

        {hoverIdx !== null && (() => {
          const x     = xAt(hoverIdx)
          const left  = x > svgW / 2 ? x - 144 : x + 12
          const sAgo  = (numPoints - 1 - hoverIdx) * stepSecs
          const items = visible
            .map(s => {
              const vals = padLeft(type === 'cpu' ? s.cpu : s.mem, numPoints)
              return { name: s.name, color: s.color, v: vals[hoverIdx] }
            })
            .sort((a, b) => b.v - a.v)
          return (
            <div className="live-chart-tooltip" style={{ left, top: YT + 4 }}>
              {items.map(it => (
                <div key={it.name} className="live-chart-tooltip-row">
                  <span className="live-chart-tooltip-dot" style={{ background: it.color }} />
                  <span className="live-chart-tooltip-name" title={it.name}>{it.name}</span>
                  <span className="live-chart-tooltip-val">
                    {type === 'cpu' ? `${it.v.toFixed(1)}%` : bytesToHuman(it.v)}
                  </span>
                </div>
              ))}
              <div className="live-chart-tooltip-time">
                {hoverIdx < realDataStart ? 'no data' : sAgo === 0 ? 'current' : `${sAgo}s ago`}
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

export default function LiveMetricsCharts({ items, stepSecs = 5 }: {
  items: LiveSeriesInput[]
  stepSecs?: number
}) {
  const theme = useAppStore(s => s.theme)
  const [hidden,   setHidden]   = useState<Set<string>>(() => new Set())
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const chartColors = useMemo(() => getChartColors(), [theme])

  const series: LiveSeries[] = useMemo(
    () => items.map((s, i) => ({ ...s, color: s.color ?? chartColors[i % chartColors.length] })),
    [items, chartColors],
  )

  const maxRealPoints = useMemo(
    () => Math.max(1, ...series.map(s => Math.max(s.cpu.length, s.mem.length))),
    [series],
  )

  const numPoints = Math.max(30, maxRealPoints)
  const realDataStart = numPoints - maxRealPoints

  const maxMem = useMemo(() => {
    let m = 1024 * 1024
    series.forEach(s => { if (!hidden.has(s.name)) m = Math.max(m, ...s.mem) })
    return m * 1.15
  }, [series, hidden])

  const maxCpu = useMemo(() => {
    let m = 0
    series.forEach(s => { if (!hidden.has(s.name)) m = Math.max(m, ...s.cpu) })
    const padded = Math.max(m * 1.15, 1)
    return Math.ceil(padded / 5) * 5
  }, [series, hidden])

  function toggleHide(name: string) {
    setHidden(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const shared = { series, numPoints, realDataStart, hidden, hoverIdx, maxCpu, maxMem, stepSecs,
    onHover: setHoverIdx, onLeave: () => setHoverIdx(null) }

  return (
    <div className="live-charts">
      <div className="live-charts-grid">
        <ChartPanel type="cpu" {...shared} />
        <ChartPanel type="mem" {...shared} />
      </div>
      <div className="live-chart-legend">
        {series.map(s => (
          <button
            key={s.name}
            className={clsx('live-chart-legend-btn', hidden.has(s.name) && 'live-chart-legend-btn--off')}
            onClick={() => toggleHide(s.name)}
          >
            <span className="live-chart-legend-dot"
              style={{ background: hidden.has(s.name) ? 'transparent' : s.color, borderColor: s.color }} />
            <span className="live-chart-legend-name">{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
