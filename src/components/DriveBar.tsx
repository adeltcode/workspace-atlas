import clsx from 'clsx'
import { bytesToHuman } from '../utils/format'

export interface DriveSegment {
  key: string
  label: string
  bytes: number
  /** A fixed color class, or `color` for one worked out at run time. */
  className?: string
  color?: string
}

/** One drive's name, size, and a bar split by what is using it. Without `stats` the bar shares itself out. */
export default function DriveBar({ title, stats, segments }: {
  title: string
  stats: { total_bytes: number; free_bytes: number } | null | undefined
  segments: DriveSegment[]
}) {
  // A tiny segment still gets a sliver, so it can be seen and hovered.
  const percent = (bytes: number, total: number) => (total > 0 ? Math.max((bytes / total) * 100, bytes > 0 ? 0.3 : 0) : 0)
  return (
    <div className="drive-bar-group">
      <div className="drive-bar-header">
        <span className="drive-bar-title">{title}</span>
        {stats && (
          <span className="drive-bar-meta">
            {bytesToHuman(stats.total_bytes)} disk size · {bytesToHuman(stats.free_bytes)} free
          </span>
        )}
      </div>
      <div className="disk-stacked-bar">
        {segments.map(s => (
          <div
            key={s.key}
            className={clsx('disk-seg', s.className)}
            style={{
              width: stats ? `${percent(s.bytes, stats.total_bytes)}%` : undefined,
              flex: stats ? undefined : s.bytes,
              background: s.color,
            }}
            title={`${s.label}: ${bytesToHuman(s.bytes)}`}
          />
        ))}
      </div>
    </div>
  )
}
