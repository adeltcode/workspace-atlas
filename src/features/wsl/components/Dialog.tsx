import { useId } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { ModalOverlay } from '../../../components/Modal'

/** Shared modal shell for the WSL dialogs (confirm + form flavours). */
export function Modal({ icon, iconWarning, title, onClose, closable, children }: {
  icon: React.ReactNode
  iconWarning?: boolean
  title: string
  onClose: () => void
  closable?: boolean
  children: React.ReactNode
}) {
  const titleId = useId()
  // A closable dialog is dismissable via Escape/backdrop; a non-closable one
  // (mid-operation) is not, matching the presence of the header close button.
  return (
    <ModalOverlay onClose={onClose} labelledBy={titleId} dismissable={!!closable}>
      <div className="modal">
        <div className="modal-header">
          <div className={clsx('modal-icon-wrap', iconWarning && 'warning')}>{icon}</div>
          <h2 className="modal-title" id={titleId}>{title}</h2>
          {closable && <button className="modal-close" onClick={onClose} title="Close"><X size={14} /></button>}
        </div>
        {children}
      </div>
    </ModalOverlay>
  )
}

/** Labelled form field row used inside the dialogs. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wsl-import-field">
      <label className="wsl-import-label">{label}</label>
      {children}
    </div>
  )
}
