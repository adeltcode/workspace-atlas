import { useId } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import ModalShell from '../../../components/ModalShell'

/**
 * Shared modal shell for the WSL dialogs (confirm + form flavours).
 *
 * Dismissible by default. This used to be opt-in via a `closable` prop, and six
 * of the ten call sites did not pass it - so Escape on "Restart WSL?" reached
 * `ModalShell`'s `cancel` handler, which called `preventDefault()` and then an
 * undefined callback. The keypress was swallowed and the dialog sat there,
 * which reads as a frozen app to anyone navigating by keyboard.
 *
 * `blocking` is the exception, and it means one specific thing: an operation is
 * already running behind this dialog and closing it would strand the run. Every
 * pre-flight confirmation is dismissible, because nothing has happened yet.
 */
export function Modal({ icon, iconWarning, iconDanger, title, onClose, blocking, children }: {
  icon: React.ReactNode
  iconWarning?: boolean
  iconDanger?: boolean
  title: string
  onClose: () => void
  /** Set only while the dialog's own operation is in flight. */
  blocking?: boolean
  children: React.ReactNode
}) {
  return (
    <ModalShell
      className="modal-overlay"
      onClose={blocking ? undefined : onClose}
      closeOnBackdrop={!blocking}
    >
      <div className="modal">
        <div className="modal-header">
          <div className={clsx('modal-icon-wrap', iconWarning && 'warning', iconDanger && 'danger')}>{icon}</div>
          <h2 className="modal-title">{title}</h2>
          {!blocking && <button className="modal-close" onClick={onClose} aria-label="Close"><X size={14} /></button>}
        </div>
        {children}
      </div>
    </ModalShell>
  )
}

/**
 * Labelled form row used inside the dialogs.
 *
 * Several fields hold a path input *and* a Browse button, so the label cannot
 * wrap its control the way a single-input field would: clicking the label would
 * then activate the button. The row is a named group instead, and each control
 * carries its own `aria-label` at the call site.
 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <div className="wsl-import-field" role="group" aria-labelledby={id}>
      <span className="wsl-import-label" id={id}>{label}</span>
      {children}
    </div>
  )
}
