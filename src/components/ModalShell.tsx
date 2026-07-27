import { useEffect, useRef } from 'react'

/**
 * Native `<dialog>` wrapper used by every modal in the app.
 *
 * `showModal()` gives us four things that a `position: fixed` div does not:
 * focus moves into the dialog, focus is trapped while it is open, focus returns
 * to the trigger on close, and Escape works. The alternative is hand-rolling all
 * four, which is how they end up subtly wrong.
 *
 * The dialog element itself plays the part of the full-screen overlay, so the
 * existing overlay classes (background dim, flex centering, z-index) keep
 * working unchanged and only the UA dialog defaults need resetting in CSS.
 * Render it conditionally: it opens on mount and closes by unmounting.
 */
export default function ModalShell({ className, onClose, closeOnBackdrop = true, children }: {
  className: string
  /** Called for Escape and, unless disabled, for a click on the backdrop. */
  onClose?: () => void
  closeOnBackdrop?: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className={className}
      // Escape fires `cancel`. Prevent the browser's own close so React state
      // stays the single source of truth for whether the dialog is mounted.
      onCancel={e => { e.preventDefault(); onClose?.() }}
      onClick={e => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose?.()
      }}
    >
      {children}
    </dialog>
  )
}
