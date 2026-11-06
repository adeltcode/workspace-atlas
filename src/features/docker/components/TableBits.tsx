import { useEffect, useState } from 'react'
import { ChevronUp, ChevronDown, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../../../components/ui'
import { ColumnsMenu, useTableColumns, type TableColumn } from '../../../components/TableColumns'
import { useAppStore, type DockerJump, type DockerTab, type DockerTableTab } from '../../../store/appStore'
import { DOCKER_COLUMNS } from '../rules'

export function SortHeader<K extends string>({ label, col, sortKey, sortDir, onSort, children }: {
  label: string; col: K; sortKey: K; sortDir: 'asc' | 'desc'
  onSort: (k: K) => void
  /** Extra header content, such as a column resize handle. */
  children?: React.ReactNode
}) {
  const active = col === sortKey
  return (
    <th
      className={clsx('img-th img-th-sort sortable', active && 'active')}
      onClick={() => onSort(col)}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {/* The header cell cannot take focus, so the control inside it does. */}
      <div
        className="th-sort-inner"
        role="button"
        tabIndex={0}
        aria-label={`Sort by ${label}`}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(col) } }}
      >
        {label}
        {active
          ? sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
          : <ChevronDown size={12} className="sort-idle" />}
      </div>
      {children}
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
  // Icon-only, and repeated once per row, so the label has to carry both the
  // verb and the row it belongs to. Callers put the object's name in `title`.
  if (armed) {
    return (
      <Button
        size="sm"
        variant="danger-outline"
        onClick={() => { setArmed(false); onConfirm() }}
        onBlur={() => setArmed(false)}
        title="Confirm removal"
        aria-label={`Confirm: ${title}`}
        autoFocus
      >
        <Trash2 size={12} />?
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      icon
      variant="ghost"
      onClick={() => { setArmed(true); onArm?.() }}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      <Trash2 size={13} />
    </Button>
  )
}

export function StatusCell({ dot, children }: { dot: 'running' | 'partial' | 'stopped'; children: React.ReactNode }) {
  return <><span className={clsx('rail-dot table-dot', dot)} aria-hidden="true" />{children}</>
}

export function useDockerTable<K extends string>(tab: DockerTableTab) {
  const prefs = useAppStore(s => s.dockerColumns[tab])
  const setDockerColumns = useAppStore(s => s.setDockerColumns)
  return useTableColumns<K>({
    columns: DOCKER_COLUMNS[tab] as TableColumn<K>[],
    fill: 'name',
    prefs,
    read: () => useAppStore.getState().dockerColumns[tab],
    save: next => setDockerColumns(tab, next),
  })
}

export function DockerColumnsMenu({ tab }: { tab: DockerTableTab }) {
  const table = useDockerTable(tab)
  const prefs = useAppStore(s => s.dockerColumns[tab])
  const setDockerColumns = useAppStore(s => s.setDockerColumns)
  return (
    <ColumnsMenu
      columns={DOCKER_COLUMNS[tab]}
      hidden={prefs.hidden}
      onToggle={table.toggle}
      onReset={() => setDockerColumns(tab, useAppStore.getInitialState().dockerColumns[tab])}
    />
  )
}

/** Runs once when another page sends the user to this tab. */
export function useDockerJump(tab: DockerTab, onJump: (jump: DockerJump) => void) {
  const jump = useAppStore(s => s.dockerJump)
  useEffect(() => {
    if (jump?.tab !== tab) return
    useAppStore.getState().clearDockerJump()
    onJump(jump)
  }, [jump]) // eslint-disable-line
}
