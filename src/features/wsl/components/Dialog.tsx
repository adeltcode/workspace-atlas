import clsx from 'clsx'
import { X } from 'lucide-react'

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
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <div className={clsx('modal-icon-wrap', iconWarning && 'warning')}>{icon}</div>
          <h2 className="modal-title">{title}</h2>
          {closable && <button className="modal-close" onClick={onClose} title="Close"><X size={14} /></button>}
        </div>
        {children}
      </div>
    </div>
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
