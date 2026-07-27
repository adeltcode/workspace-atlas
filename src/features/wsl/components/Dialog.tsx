import { useId } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import ModalShell from '../../../components/ModalShell'

/** Shared modal shell for the WSL dialogs (confirm + form flavours). */
export function Modal({ icon, iconWarning, title, onClose, closable, children }: {
  icon: React.ReactNode
  iconWarning?: boolean
  title: string
  onClose: () => void
  closable?: boolean
  children: React.ReactNode
}) {
  return (
    // Only a dialog the user is allowed to dismiss closes on Escape or backdrop.
    // A non-closable one is mid-operation, and losing it would strand the run.
    <ModalShell
      className="modal-overlay"
      onClose={closable ? onClose : undefined}
      closeOnBackdrop={!!closable}
    >
      <div className="modal">
        <div className="modal-header">
          <div className={clsx('modal-icon-wrap', iconWarning && 'warning')}>{icon}</div>
          <h2 className="modal-title">{title}</h2>
          {closable && <button className="modal-close" onClick={onClose} title="Close" aria-label="Close"><X size={14} /></button>}
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
