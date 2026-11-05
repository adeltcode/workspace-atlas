import { useId } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import ModalShell from '../../../components/ModalShell'

/** Shared modal shell for the WSL dialogs. Dismissible by default. `blocking` means an operation
 *  is already running behind the dialog and closing it would strand the run. */
export function Modal({ icon, iconWarning, iconDanger, title, onClose, blocking, returnFocusRef, children }: {
  icon: React.ReactNode
  iconWarning?: boolean
  iconDanger?: boolean
  title: string
  onClose: () => void
  /** Set only while the dialog's own operation is in flight. */
  blocking?: boolean
  returnFocusRef?: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}) {
  return (
    <ModalShell
      className="modal-overlay"
      label={title}
      returnFocusRef={returnFocusRef}
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

/** Labelled form row. A field can hold a path input and a Browse button, so the label cannot wrap
 *  its control: clicking it would activate the button. Each control has its own `aria-label`. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <div className="wsl-import-field" role="group" aria-labelledby={id}>
      <span className="wsl-import-label" id={id}>{label}</span>
      {children}
    </div>
  )
}
