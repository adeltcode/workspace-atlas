import { useState } from 'react'
import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react'
import clsx from 'clsx'

/** Clickable, sort-aware table header cell shared by the list tabs. */
export function SortHeader<K extends string>({ label, col, sortKey, sortDir, onSort }: {
  label: string; col: K; sortKey: K; sortDir: 'asc' | 'desc'
  onSort: (k: K) => void
}) {
  const active = col === sortKey
  return (
    <th className={clsx('img-th img-th-sort sortable', active && 'active')} onClick={() => onSort(col)}>
      <div className="th-sort-inner">
        {label}
        {active
          ? sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
          : <ChevronDown size={12} className="sort-idle" />}
      </div>
    </th>
  )
}

/** Two-click remove: first click arms (shows "?"), second confirms. Disarms on blur. */
export function ConfirmRemoveButton({ onConfirm, onArm, disabled, title }: {
  onConfirm: () => void
  onArm?: () => void
  disabled?: boolean
  title: string
}) {
  const [armed, setArmed] = useState(false)
  if (armed) {
    return (
      <button
        className="ctr-action-btn ctr-action-confirm"
        onClick={() => { setArmed(false); onConfirm() }}
        onBlur={() => setArmed(false)}
        title="Confirm removal"
        autoFocus
      >
        <Trash2 size={12} /><span>?</span>
      </button>
    )
  }
  return (
    <button
      className="ctr-action-btn ctr-action-remove"
      onClick={() => { setArmed(true); onArm?.() }}
      disabled={disabled}
      title={title}
    >
      <Trash2 size={12} />
    </button>
  )
}
