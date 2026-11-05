import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import clsx from 'clsx'
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview'
import type { PhysicalPosition } from '@tauri-apps/api/dpi'
import { EmptyState } from './ui'

/** What one drag event means for one drop area. `inside` says whether a point is over the area. */
export function readDrag(event: DragDropEvent, inside: (position: PhysicalPosition) => boolean) {
  if (event.type === 'leave') return { over: false, dropped: null }
  const hit = inside(event.position)
  if (event.type !== 'drop') return { over: hit, dropped: null }
  return { over: false, dropped: hit && event.paths.length > 0 ? event.paths : null }
}

/** An area that takes files and folders dragged in from outside the app. Always offer another way to
 *  choose a path as well: Windows blocks these drags when the app runs as administrator. */
export function FileDropZone({ label, disabled = false, onDrop, className, children }: {
  /** Shown while a file is over the area, such as "Drop to check it". */
  label: string
  /** Ignores drags, for example while a dialog is open or a check is running. */
  disabled?: boolean
  /** Gets every dropped path, and always at least one. */
  onDrop: (paths: string[]) => void
  className?: string
  children: React.ReactNode
}) {
  const zone = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  // The subscription outlives renders, so it reads the current props from here.
  const latest = useRef({ disabled, onDrop })
  latest.current = { disabled, onDrop }

  useEffect(() => {
    const inside = (position: PhysicalPosition) => {
      if (latest.current.disabled) return false
      const { x, y } = position.toLogical(window.devicePixelRatio)
      // By element, not by rectangle, so a dialog or panel on top of the area does not count.
      return !!zone.current?.contains(document.elementFromPoint(x, y))
    }
    let cancelled = false
    let stop: (() => void) | undefined
    // Tauri takes file drags before the page sees them, so HTML drop events never fire.
    getCurrentWebview().onDragDropEvent(({ payload }) => {
      const { over, dropped } = readDrag(payload, inside)
      setOver(over)
      if (dropped) latest.current.onDrop(dropped)
    }).then(unlisten => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  return (
    <div ref={zone} className={clsx('file-drop', className)}>
      {children}
      {over && !disabled && (
        <div className="file-drop-cover" aria-hidden="true">
          <ArrowDownToLine size={22} />
          {label}
        </div>
      )}
    </div>
  )
}

/** The visible target for a drop area with nothing in it yet. Goes inside a `FileDropZone`. */
export function FileDropPrompt({ title, description }: { title: string; description: string }) {
  return (
    <div className="file-drop-prompt">
      <EmptyState icon={ArrowDownToLine} title={title} description={description} />
    </div>
  )
}
