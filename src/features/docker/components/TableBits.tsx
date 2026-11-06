import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../../../components/ui'
import { ColumnsMenu, useTableColumns, type TableColumn } from '../../../components/TableColumns'
import { useAppStore, type DockerJump, type DockerTab, type DockerTableTab } from '../../../store/appStore'
import { DOCKER_COLUMNS } from '../rules'

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
  return useTableColumns<K>({
    columns: DOCKER_COLUMNS[tab] as TableColumn<K>[],
    fill: 'name',
    select: s => s.dockerColumns[tab],
    save: next => useAppStore.getState().setDockerColumns(tab, next),
  })
}

export function DockerColumnsMenu({ tab }: { tab: DockerTableTab }) {
  return <ColumnsMenu table={useDockerTable(tab)} />
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
