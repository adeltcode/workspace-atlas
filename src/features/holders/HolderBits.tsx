import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { Button, ConfirmDestructive } from '../../components/ui'
import { dockerContainerAction, dockerDesktopStop } from '../docker/api'
import { wslShutdown } from '../wsl/api'
import * as api from './api'
import type { ProcessInfo } from './api'
import { closeCommand, FIX_BUTTON, fixDialog, fixDone, fixFor, isContainer, NOT_CLOSABLE, type HolderFix } from './rules'

const RUN_FIX: Record<HolderFix, (process: ProcessInfo) => Promise<void>> = {
  close: api.processClose,
  'stop-container': process => dockerContainerAction(process.name, 'stop'),
  'stop-docker': dockerDesktopStop,
  'stop-wsl': wslShutdown,
}

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
  const jumpToDocker = useAppStore(s => s.jumpToDocker)
  const fix = fixFor(process)
  if (!fix) return <span className="holder-note">{NOT_CLOSABLE[process.owner]}</span>
  const pid = process.pid ? `, PID ${process.pid}` : ''
  return (
    <>
      {isContainer(process) && (
        <Button size="sm" variant="ghost" aria-label={`Show logs for ${process.name}`} onClick={() => jumpToDocker('containers', process.name, true)}>
          Logs
        </Button>
      )}
      <Button size="sm" variant="danger-outline" aria-label={`${FIX_BUTTON[fix]} ${process.name}${pid}, ${holds}`} onClick={onClose}>
        {FIX_BUTTON[fix]}
      </Button>
    </>
  )
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
  const dialog = fixDialog(process)
  const fix = fixFor(process) ?? 'close'

  const run = async () => {
    const { addTerminalLine, addActivity, clearDockerCache } = useAppStore.getState()
    const pid = process.pid ? ` (PID ${process.pid})` : ''
    const detail = `${process.name}${pid}. ${holds}`
    setBusy(true)
    addTerminalLine(`$ ${command}`, 'cmd')
    try {
      await RUN_FIX[fix](process)
      // The Docker page would otherwise show its cached list, with this still running.
      if (fix === 'stop-container' || fix === 'stop-docker') clearDockerCache()
      addTerminalLine(`  ✓ ${fixDone(process)}`, 'success')
      addActivity({ module: 'system', action: dialog.confirmLabel, outcome: 'success', detail })
      onClosed()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      addActivity({ module: 'system', action: dialog.confirmLabel, outcome: 'failure', detail: `${detail}: ${String(e)}` })
      onFailed(e)
    }
  }

  return (
    <ConfirmDestructive
      title={dialog.title}
      consequence={dialog.consequence}
      command={command}
      items={[{ name: process.path ?? process.name, meta: process.pid ? `PID ${process.pid}` : undefined }]}
      summary={holds}
      confirmLabel={dialog.confirmLabel}
      busyLabel={dialog.busyLabel}
      onConfirm={run}
      onCancel={onCancel}
      busy={busy}
    />
  )
}
