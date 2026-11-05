import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import clsx from 'clsx'
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview'
import type { PhysicalPosition } from '@tauri-apps/api/dpi'
import { EmptyState } from './ui'

const HINT_GAP_X = 14
const HINT_GAP_Y = 18

/** The text beside the cursor during a drag. `blocked` means a drop does nothing. */
export interface DropHint {
  title: string
  note?: string
  tone?: 'danger' | 'blocked'
  icon?: React.ElementType
}

/** What one drag event means for one drop area. `inside` says whether a point is over the area. */
export function readDrag(event: DragDropEvent, inside: (position: PhysicalPosition) => boolean) {
  if (event.type === 'leave') return { over: false, dropped: null }
  const hit = inside(event.position)
  if (event.type !== 'drop') return { over: hit, dropped: null }
  return { over: false, dropped: hit && event.paths.length > 0 ? event.paths : null }
}

/** Flips to the other side of the cursor rather than running off the window. */
function placeHint(box: HTMLElement, { x, y }: { x: number; y: number }) {
  const left = x + HINT_GAP_X + box.offsetWidth > window.innerWidth ? x - HINT_GAP_X - box.offsetWidth : x + HINT_GAP_X
  const top = y + HINT_GAP_Y + box.offsetHeight > window.innerHeight ? y - HINT_GAP_Y - box.offsetHeight : y + HINT_GAP_Y
  box.style.transform = `translate(${left}px, ${top}px)`
}

/** An area that takes files and folders dragged in from outside the app. Always offer another way to
 *  choose a path as well: Windows blocks these drags when the app runs as administrator. */
export function FileDropZone({ label, disabled = false, onDrop, className, children }: {
  /** What a drop will do, shown beside the cursor. Use a function to answer from the dragged paths. */
  label: string | ((paths: string[]) => DropHint | Promise<DropHint>)
  /** Ignores drags, for example while a dialog is open or a check is running. */
  disabled?: boolean
  /** Gets every dropped path, and always at least one. */
  onDrop: (paths: string[]) => void
  className?: string
  children: React.ReactNode
}) {
  const zone = useRef<HTMLDivElement>(null)
  const hintBox = useRef<HTMLDivElement>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const dragNumber = useRef(0)
  const [over, setOver] = useState(false)
  const [hint, setHint] = useState<DropHint | null>(null)
  // The subscription outlives renders, so it reads the current props from here.
  const latest = useRef({ disabled, onDrop, label })
  latest.current = { disabled, onDrop, label }

  useLayoutEffect(() => {
    if (hintBox.current) placeHint(hintBox.current, pointer.current)
  })

  useEffect(() => {
    const inside = (position: PhysicalPosition) => {
      if (latest.current.disabled) return false
      const { x, y } = position.toLogical(window.devicePixelRatio)
      // By element, not by rectangle, so a dialog or panel on top of the area does not count.
      return !!zone.current?.contains(document.elementFromPoint(x, y))
    }
    const describe = (paths: string[]) => {
      const { label } = latest.current
      const thisDrag = ++dragNumber.current
      setHint(null)
      Promise.resolve(typeof label === 'string' ? { title: label } : label(paths)).then(next => {
        if (thisDrag === dragNumber.current) setHint(next)
      })
    }
    let cancelled = false
    let stop: (() => void) | undefined
    // Tauri takes file drags before the page sees them, so HTML drop events never fire.
    getCurrentWebview().onDragDropEvent(({ payload }) => {
      const { over, dropped } = readDrag(payload, inside)
      if (payload.type === 'enter') describe(payload.paths)
      if (payload.type !== 'leave') pointer.current = payload.position.toLogical(window.devicePixelRatio)
      // Written directly so a drag does not render the page on every mouse move.
      if (hintBox.current) placeHint(hintBox.current, pointer.current)
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

  const showing = over && !disabled
  const HintIcon = hint?.icon ?? ArrowDownToLine

  return (
    <div
      ref={zone}
      className={clsx(
        'file-drop',
        showing && hint?.tone !== 'blocked' && 'file-drop--over',
        showing && hint?.tone === 'danger' && 'file-drop--danger',
        className,
      )}
    >
      {children}
      {showing && hint && (
        <div ref={hintBox} className={clsx('file-drop-hint', hint.tone && `file-drop-hint--${hint.tone}`)} aria-hidden="true">
          <HintIcon size={13} />
          <span>
            <span className="file-drop-hint-title">{hint.title}</span>
            {hint.note && <span className="file-drop-hint-note">{hint.note}</span>}
          </span>
        </div>
      )}
    </div>
  )
}

/** The visible target for a drop area. Goes inside a `FileDropZone`. `row` lays it out flat for tight spaces. */
export function FileDropPrompt({ title, description, actions, row = false }: {
  title: string
  description: string
  actions?: React.ReactNode
  row?: boolean
}) {
  if (row) {
    return (
      <div className="file-drop-prompt file-drop-prompt--row">
        <ArrowDownToLine size={18} className="empty-icon" aria-hidden="true" />
        <div className="file-drop-prompt-text">
          <p className="empty-title">{title}</p>
          <p className="empty-desc">{description}</p>
        </div>
        {actions}
      </div>
    )
  }
  return (
    <div className="file-drop-prompt">
      <EmptyState icon={ArrowDownToLine} title={title} description={description} actions={actions} />
    </div>
  )
}
