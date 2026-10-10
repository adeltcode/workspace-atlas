import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ArrowRightLeft, Check, CircleCheck, FolderOpen, LoaderCircle, TriangleAlert } from 'lucide-react'
import * as api from '../api'
import type { WslDistro, MigrationPlan, MigrationProgress, MigrationOutput, MigrationRepair, MigrateResult } from '../types'
import { launchDockerDesktop } from '../../docker/api'
import { useAppStore } from '../../../store/appStore'
import { useAsyncAction } from '../../../hooks/useAsyncAction'
import { bytesToHuman } from '../../../utils/format'
import { toAppError, AppError, type RecoveryAction } from '../../../utils/errors'
import { ErrorBanner } from '../../../components/ui'
import CommandOutput from '../../../components/CommandOutput'
import { Modal, Field } from './Dialog'

const PHASES: { id: MigrationProgress['phase']; label: string }[] = [
  { id: 'preparing', label: 'Check requirements' },
  { id: 'stopping', label: 'Stop WSL' },
  { id: 'backing-up', label: 'Back up disk' },
  { id: 'verifying-backup', label: 'Verify backup' },
  { id: 'moving', label: 'Move disk' },
  { id: 'checking', label: 'Check distribution' },
]

const REPAIR_LABELS: Record<MigrationRepair, string> = {
  'update-wsl': 'Update WSL', 'update-wsl-web': 'Update using web download',
  'stop-docker': 'Quit Docker Desktop', 'stop-wsl': 'Stop all WSL sessions',
}

const REPAIR_NOTICES: Record<MigrationRepair, string> = {
  'update-wsl': 'Save your WSL work first. Windows may ask for administrator approval to update WSL.',
  'update-wsl-web': 'Save your WSL work first. This downloads the WSL update directly when Microsoft Store access is unavailable.',
  'stop-docker': 'This stops Docker Desktop and its running containers. Save container work before continuing.',
  'stop-wsl': 'This stops every WSL session immediately. Save work in all distributions and close WSL terminals and editors first.',
}

const REPAIR_COMMANDS: Record<MigrationRepair, string> = {
  'update-wsl': 'wsl --update', 'update-wsl-web': 'wsl --update --web-download',
  'stop-docker': 'docker desktop stop --timeout 60', 'stop-wsl': 'wsl --shutdown',
}

export default function WslMigrationDialog({ distro, onClose, onReload, onComplete, returnFocusRef }: {
  distro: WslDistro
  onClose: () => void
  onReload: () => Promise<void> | void
  onComplete: (result: MigrateResult) => void
  returnFocusRef: React.RefObject<HTMLElement | null>
}) {
  const [directory, setDirectory] = useState('')
  const [plan, setPlan] = useState<MigrationPlan | null>(null)
  const [blockers, setBlockers] = useState<AppError[]>([])
  const [error, setError] = useState<AppError | null>(null)
  const [commandOutput, setCommandOutput] = useState('')
  const [repairConfirmation, setRepairConfirmation] = useState<MigrationRepair | null>(null)
  const [result, setResult] = useState<MigrateResult | null>(null)
  const [phase, setPhase] = useState<MigrationProgress['phase']>('preparing')
  const directoryRef = useRef<HTMLInputElement>(null)
  const reviewRef = useRef<HTMLParagraphElement>(null)
  const check = useAsyncAction()
  const move = useAsyncAction()
  const browse = useAsyncAction()
  const reveal = useAsyncAction()
  const repair = useAsyncAction()
  const assist = useAsyncAction()
  const busyDistro = useAppStore(s => s.wslBusyDistro)
  const setBusyDistro = useAppStore(s => s.setWslBusyDistro)
  const addActivity = useAppStore(s => s.addActivity)
  const busy = check.pending || move.pending || browse.pending || repair.pending || assist.pending

  useEffect(() => {
    if (plan) reviewRef.current?.focus()
    else directoryRef.current?.focus()
  }, [plan])

  const appendOutput = (text: string) => setCommandOutput(previous => {
    const combined = `${previous}${text}\n`
    return combined.length > 128000 ? `[Earlier output trimmed. Latest responses shown.]\n${combined.slice(-128000)}` : combined
  })
  const listenForOutput = () => listen<MigrationOutput>('wsl-migration-output', ({ payload }) => {
    if (payload.distro === distro.name) appendOutput(payload.text)
  })

  const review = () => check.run(async () => {
    if (!directory.trim() || useAppStore.getState().wslBusyDistro) return
    setError(null)
    try {
      const suggested = await api.wslSuggestMigrationDir(distro.name, directory.trim())
      setDirectory(suggested)
      const next = await api.wslPlanMigration(distro.name, suggested)
      if (next.plan) setDirectory(next.plan.destination)
      setPlan(next.plan)
      setBlockers(next.blockers)
      appendOutput(next.command_output)
    } catch (e) { setError(toAppError(e)) }
  })

  const runMigrate = () => move.run(async () => {
    if (!plan || blockers.length > 0 || useAppStore.getState().wslBusyDistro) return
    setBusyDistro(distro.name)
    setError(null)
    setPhase('preparing')
    let unlisten: (() => void) | undefined
    let outputUnlisten: (() => void) | undefined
    try {
      unlisten = await listen<MigrationProgress>('wsl-migration-progress', ({ payload }) => {
        if (payload.distro === distro.name) setPhase(payload.phase)
      })
      outputUnlisten = await listenForOutput()
      const migrated = await api.wslMigrateDistro(distro.name, plan.destination)
      setResult(migrated)
      onComplete(migrated)
      addActivity({ module: 'wsl', action: `Moved ${distro.name}`, outcome: 'success', detail: `${migrated.destination}\nBackup: ${migrated.backup_path}\nRecovery: ${migrated.recovery_path}` })
    } catch (e) {
      const failure = toAppError(e)
      setError(failure)
      setPlan(null)
      addActivity({ module: 'wsl', action: `Moved ${distro.name}`, outcome: 'failure', detail: `${failure.message}\n${failure.hint ?? ''}\n${failure.detail ?? ''}\n${failure.recoveryPath ?? ''}` })
    } finally {
      unlisten?.()
      outputUnlisten?.()
      try { await onReload() }
      finally { setBusyDistro(null) }
    }
  })

  const revealPath = (path: string) => reveal.run(async () => {
    try { await api.revealPath(path) }
    catch (e) { useAppStore.getState().addTerminalLine(String(e), 'error') }
  })

  const pickFolder = () => browse.run(async () => {
    try {
      const picked = await api.pickDirectory()
      if (picked) {
        const suggested = await api.wslSuggestMigrationDir(distro.name, picked)
        setDirectory(suggested); setError(null); setPlan(null); setBlockers([])
        directoryRef.current?.focus()
      }
    } catch (e) { setError(toAppError(e)) }
  })

  const runRepair = () => repair.run(async () => {
    if (!repairConfirmation || useAppStore.getState().wslBusyDistro) return
    setBusyDistro(distro.name)
    setError(null)
    let unlisten: (() => void) | undefined
    let succeeded = false
    try {
      unlisten = await listenForOutput()
      await api.wslRepairMigration(distro.name, repairConfirmation)
      succeeded = true
    } catch (e) {
      const failure = toAppError(e)
      setError(new AppError(failure.kind, failure.message, failure.hint, failure.detail, error?.recoveryPath ?? failure.recoveryPath, failure.action))
      setPlan(null); setBlockers([])
    } finally {
      unlisten?.()
      try { await onReload() }
      finally { setBusyDistro(null); setRepairConfirmation(null) }
    }
    if (succeeded) await review()
  })

  const helpAction = (action: RecoveryAction) => assist.run(async () => {
    try {
      if (action === 'open-docker') await launchDockerDesktop()
      else if (action === 'refresh-distros') { await onReload(); onClose() }
      else if (action === 'show-terminal') {
        const store = useAppStore.getState()
        store.setTerminalOpen(true)
        onClose()
      } else {
        await openUrl(action === 'conversion-guide'
          ? 'https://learn.microsoft.com/en-us/windows/wsl/basic-commands#set-wsl-version-to-1-or-2'
          : 'https://learn.microsoft.com/en-us/windows/wsl/troubleshooting')
      }
    } catch (e) { setError(toAppError(e)) }
  })

  const recoveryButton = (failure: AppError) => {
    const action = failure.action ?? (failure.kind === 'disk-full' || failure.kind === 'permission' || failure.kind === 'invalid' ? 'choose-folder' : 'wsl-help')
    if (action === 'choose-folder') return <button className="btn-secondary" disabled={busy} onClick={pickFolder}><FolderOpen size={13} /> Choose another folder</button>
    if (action === 'update-wsl' || action === 'update-wsl-web' || action === 'stop-docker' || action === 'stop-wsl') {
      return <button className="btn-secondary" disabled={busy} onClick={() => setRepairConfirmation(action)}>{REPAIR_LABELS[action]}</button>
    }
    const label = action === 'open-docker' ? 'Open Docker Desktop' : action === 'show-terminal' ? 'Show active terminal' : action === 'refresh-distros' ? 'Refresh distributions' : action === 'conversion-guide' ? 'WSL 2 conversion guide' : 'Open WSL troubleshooting'
    return <button className="btn-secondary" disabled={busy} onClick={() => helpAction(action)}>{label}</button>
  }

  const activePhase = PHASES.findIndex(item => item.id === phase)

  return (
    <Modal icon={result ? <CircleCheck size={16} /> : <ArrowRightLeft size={16} />}
      title={result ? `${distro.name} moved` : `Move ${distro.name}`}
      onClose={onClose} blocking={busy} returnFocusRef={returnFocusRef}>
      <div className="wsl-migration">
        {repairConfirmation ? (
          <div className="wsl-migration-notice">
            <TriangleAlert size={16} aria-hidden="true" />
            <div><strong>{repair.pending ? (repairConfirmation.startsWith('update-') ? 'Updating WSL…' : repairConfirmation === 'stop-docker' ? 'Quitting Docker Desktop…' : 'Stopping WSL…') : `${REPAIR_LABELS[repairConfirmation]}?`}</strong>
              <p>{REPAIR_NOTICES[repairConfirmation]}</p>
              <code className="wsl-migration-command">{REPAIR_COMMANDS[repairConfirmation]}</code>
              <div className="modal-actions">
                <button className="btn-secondary" disabled={busy} onClick={() => setRepairConfirmation(null)}>Back</button>
                <button className="btn-filled btn-filled--accent" disabled={busy || busyDistro !== null} onClick={runRepair}>{repair.pending ? 'Working…' : REPAIR_LABELS[repairConfirmation]}</button>
              </div>
            </div>
          </div>
        ) : result ? (
          <>
            <p className="modal-body">The disk was moved and checked. Your backup is ready if you need it.</p>
            <div className="wsl-migration-location"><span>New location</span><code>{result.destination}</code></div>
            <p className="wsl-migration-note">Check your files and apps before deleting the backup. Other WSL distributions remain stopped.</p>
            <details className="wsl-migration-details">
              <summary>Backup and recovery</summary>
              <code>{result.backup_path}</code>
              <button className="btn-secondary" disabled={reveal.pending} onClick={() => revealPath(result.recovery_path)}><FolderOpen size={13} /> Show recovery guide</button>
            </details>
          </>
        ) : move.pending ? (
          <div role="status" aria-live="polite" aria-busy="true">
            <p className="modal-body">Keep Atlas open until the move finishes.</p>
            <ol className="wsl-migration-progress" aria-label="Migration progress">
              {PHASES.map((item, index) => (
                <li key={item.id} className={index === activePhase ? 'is-current' : index < activePhase ? 'is-complete' : ''}
                  aria-current={index === activePhase ? 'step' : undefined}>
                  {index < activePhase ? <Check size={15} aria-hidden="true" /> : index === activePhase ? <LoaderCircle size={15} className="wsl-migration-spinner" aria-hidden="true" /> : <span className="wsl-migration-step">{index + 1}</span>}
                  {item.label}
                </li>
              ))}
            </ol>
          </div>
        ) : error?.recoveryPath ? (
          <ErrorBanner error={error} className="error-banner--flush" detailLabel="Command and Windows response" action={
            <><button className="btn-secondary" disabled={reveal.pending} onClick={() => revealPath(error.recoveryPath!)}><FolderOpen size={13} /> Show recovery guide</button>
              {error.action && recoveryButton(error)}</>
          } />
        ) : plan ? (
          <>
            <p className="modal-body" ref={reviewRef} tabIndex={-1}>{blockers.length > 0 ? 'Finish the checks below before moving.' : 'Review the move, then confirm when your work is saved.'}</p>
            <div className="wsl-migration-location"><span>Move to</span><code>{plan.destination}</code>
              {plan.create_directory && <small>This folder will be created when you confirm.</small>}
            </div>
            <div className="wsl-migration-space"><Check size={14} aria-hidden="true" /><span>{bytesToHuman(plan.available_bytes)} free · {bytesToHuman(plan.required_bytes)} needed, including backup</span></div>
            {blockers.length === 0 && <div className="wsl-migration-notice">
              <TriangleAlert size={16} aria-hidden="true" />
              <div><strong>All WSL sessions will stop</strong>
                <p>Save your work and close WSL terminals and editors before continuing.</p>
                {plan.running_distros.length > 0 && <p className="wsl-migration-running">Running: {plan.running_distros.join(', ')}</p>}
              </div>
            </div>}
            {blockers.length === 0 && <details className="wsl-migration-details"><summary>What happens to my files?</summary>
              <p>Atlas backs up and checks the disk before moving it. Your Linux files, settings, and distribution name stay the same.</p>
              <p>The backup and recovery guide are kept beside the new folder. Windows-mounted files and Docker Desktop data are stored separately.</p>
              <p>{distro.running ? 'This distribution restarts for a final check. Other distributions remain stopped.' : 'This distribution is stopped again after a final check. Other distributions remain stopped.'}</p>
            </details>}
          </>
        ) : (
          <>
            <p className="modal-body">Choose where to store the distribution. Atlas keeps a backup before moving it.</p>
            <form id="wsl-migration-location" onSubmit={event => { event.preventDefault(); review() }}>
              <Field label="Destination folder">
                <div className="wsl-import-row">
                  <input ref={directoryRef} className="settings-dir-input" aria-label="Destination folder" value={directory}
                    onChange={event => { setDirectory(event.target.value); setError(null); setBlockers([]) }}
                    autoFocus placeholder="e.g. F:\ or F:\WSL\Ubuntu" spellCheck={false} disabled={busy} />
                  <button type="button" className="settings-dir-btn" disabled={busy} onClick={pickFolder}>Browse…</button>
                </div>
              </Field>
            </form>
            <p className="wsl-migration-note">Selecting a drive fills in a recommended folder. It is created only after you confirm the move.</p>
          </>
        )}
        {!repairConfirmation && !result && !move.pending && blockers.map((failure, index) => (
          <ErrorBanner key={`${failure.message}-${index}`} error={failure} className="error-banner--flush" detailLabel="Command and Windows response" action={recoveryButton(failure)} />
        ))}
        {error && !error.recoveryPath && !repairConfirmation && !result && !move.pending && <ErrorBanner error={error} className="error-banner--flush" detailLabel="Command and Windows response" action={recoveryButton(error)} />}
        {commandOutput && !error?.detail && <details className="wsl-migration-details">
          <summary>Commands and Windows responses</summary>
          <CommandOutput text={commandOutput} title="Commands and Windows responses" />
        </details>}
        <div className="modal-actions">
          {plan && !result && !move.pending && !repairConfirmation && <button className="btn-secondary modal-actions-escape" onClick={() => { setPlan(null); setError(null); setBlockers([]) }}>Back</button>}
          <button className="btn-secondary" onClick={onClose} disabled={busy}>{result || error?.recoveryPath ? 'Close' : 'Cancel'}</button>
          {!result && !error?.recoveryPath && !move.pending && !repairConfirmation && (plan && blockers.length === 0 ? (
            <button key="confirm-move" className="btn-filled btn-filled--accent" onClick={runMigrate} disabled={busy || busyDistro !== null}><ArrowRightLeft size={13} /> {plan.create_directory ? 'Create folder and move' : 'Move distribution'}</button>
          ) : (
            <button key="review-location" type={plan ? 'button' : 'submit'} form={plan ? undefined : 'wsl-migration-location'} onClick={plan ? review : undefined} className="btn-filled btn-filled--accent" disabled={busy || busyDistro !== null || !directory.trim()}>{check.pending ? 'Checking…' : error || blockers.length > 0 ? 'Check again' : 'Continue'}</button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
