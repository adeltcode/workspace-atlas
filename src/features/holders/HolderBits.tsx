import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { Button, ConfirmDestructive } from '../../components/ui'
import * as api from './api'
import type { ProcessInfo } from './api'
import { canClose, closeCommand, NOT_CLOSABLE } from './rules'

export function ProgramCell({ process }: { process: ProcessInfo }) {
  return (
    <>
      <span className="img-repo">{process.name}</span>
      {process.path && <span className="holder-path" title={process.path}>{process.path}</span>}
    </>
  )
}

export function HolderAction({ process, holds, onClose }: {
  process: ProcessInfo
  /** Finishes the button's accessible name: "using port 3000". */
  holds: string
  onClose: () => void
}) {
  const setActiveView = useAppStore(s => s.setActiveView)
  if (canClose(process)) {
    return (
      <Button size="sm" variant="danger-outline" aria-label={`Close ${process.name}, PID ${process.pid}, ${holds}`} onClick={onClose}>
        Close
      </Button>
    )
  }
  if (process.owner === 'docker') return <Button size="sm" variant="ghost" onClick={() => setActiveView('docker')}>Open Docker</Button>
  if (process.owner === 'wsl') return <Button size="sm" variant="ghost" onClick={() => setActiveView('wsl')}>Open WSL</Button>
  return <span className="holder-note">{NOT_CLOSABLE[process.owner]}</span>
}

export function CloseProgramDialog({ process, holds, onClosed, onFailed, onCancel }: {
  process: ProcessInfo
  /** What closing it frees: "Using port 3000". */
  holds: string
  onClosed: () => void
  onFailed: (error: unknown) => void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const command = closeCommand(process)

  const run = async () => {
    const { addTerminalLine, addActivity } = useAppStore.getState()
    const detail = `${process.name} (PID ${process.pid}). ${holds}`
    setBusy(true)
    addTerminalLine(`$ ${command}`, 'cmd')
    try {
      await api.processClose(process)
      addTerminalLine(`  ✓ Closed ${process.name}`, 'success')
      addActivity({ module: 'system', action: 'Close program', outcome: 'success', detail })
      onClosed()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      addActivity({ module: 'system', action: 'Close program', outcome: 'failure', detail: `${detail}: ${String(e)}` })
      onFailed(e)
    }
  }

  return (
    <ConfirmDestructive
      title={`Close ${process.name}?`}
      consequence={process.distro
        ? `Linux asks this program in ${process.distro} to stop. Anything it has not saved may be lost.`
        : 'Windows ends this program right away, without letting it save. Anything it has not saved is lost.'}
      command={command}
      items={[{ name: process.path ?? process.name, meta: `PID ${process.pid}` }]}
      summary={holds}
      confirmLabel="Close program"
      busyLabel="Closing…"
      onConfirm={run}
      onCancel={onCancel}
      busy={busy}
    />
  )
}
