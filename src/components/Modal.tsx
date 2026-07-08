import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Accessible modal backdrop: `role="dialog"` + `aria-modal`, Escape to close,
 * backdrop click to close, a Tab focus trap, and focus restore on unmount.
 *
 * Callers supply the inner box markup and (optionally) the backdrop `className`,
 * so each feature's existing modal CSS family keeps working — this only adds the
 * keyboard/focus behaviour that was missing everywhere. Set `dismissable={false}`
 * to keep Escape/backdrop from closing a modal mid-operation.
 */
export function ModalOverlay({
  onClose,
  label,
  labelledBy,
  className = 'modal-overlay',
  dismissable = true,
  children,
}: {
  onClose: () => void
  label?: string
  labelledBy?: string
  className?: string
  dismissable?: boolean
  children: React.ReactNode
}) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const node = overlayRef.current
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    // Focus the first focusable control, else the dialog container itself.
    ;(focusables()[0] ?? node)?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) { e.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    node?.addEventListener('keydown', onKeyDown)
    return () => {
      node?.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [onClose, dismissable])

  return (
    <div
      ref={overlayRef}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onClick={e => { if (dismissable && e.target === e.currentTarget) onClose() }}
    >
      {children}
    </div>
  )
}
