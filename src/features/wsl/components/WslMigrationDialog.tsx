import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowRightLeft, Check, CircleCheck, FolderOpen, LoaderCircle, TriangleAlert } from 'lucide-react'
import * as api from '../api'
import type { WslDistro, MigrationPlan, MigrationProgress, MigrateResult } from '../types'
import { useAppStore } from '../../../store/appStore'
import { useAsyncAction } from '../../../hooks/useAsyncAction'
import { bytesToHuman } from '../../../utils/format'
import { toAppError, type AppError } from '../../../utils/errors'
import { ErrorBanner } from '../../../components/ui'
import { Modal, Field } from './Dialog'

const PHASES: { id: MigrationProgress['phase']; label: string }[] = [
  { id: 'stopping', label: 'Stop WSL' },
  { id: 'backing-up', label: 'Back up disk' },
  { id: 'verifying-backup', label: 'Verify backup' },
  { id: 'moving', label: 'Move disk' },
  { id: 'checking', label: 'Check distribution' },
]

export default function WslMigrationDialog({ distro, onClose, onReload, onComplete, returnFocusRef }: {
  distro: WslDistro
  onClose: () => void
  onReload: () => Promise<void> | void
  onComplete: (result: MigrateResult) => void
  returnFocusRef: React.RefObject<HTMLElement | null>
}) {
  const [directory, setDirectory] = useState('')
  const [plan, setPlan] = useState<MigrationPlan | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [result, setResult] = useState<MigrateResult | null>(null)
  const [phase, setPhase] = useState<MigrationProgress['phase']>('stopping')
  const directoryRef = useRef<HTMLInputElement>(null)
  const reviewRef = useRef<HTMLParagraphElement>(null)
  const check = useAsyncAction()
  const move = useAsyncAction()
  const browse = useAsyncAction()
  const reveal = useAsyncAction()
  const busyDistro = useAppStore(s => s.wslBusyDistro)
  const setBusyDistro = useAppStore(s => s.setWslBusyDistro)
  const addActivity = useAppStore(s => s.addActivity)
  const busy = check.pending || move.pending || browse.pending

  useEffect(() => {
    if (plan) reviewRef.current?.focus()
    else directoryRef.current?.focus()
  }, [plan])

  const review = () => check.run(async () => {
    if (!directory.trim() || useAppStore.getState().wslBusyDistro) return
    setError(null)
    try {
      const next = await api.wslPlanMigration(distro.name, directory.trim())
      setDirectory(next.destination)
      setPlan(next)
    } catch (e) { setError(toAppError(e)) }
  })

  const runMigrate = () => move.run(async () => {
    if (!plan || useAppStore.getState().wslBusyDistro) return
    setBusyDistro(distro.name)
    setError(null)
    setPhase('stopping')
    let unlisten: (() => void) | undefined
    try {
      unlisten = await listen<MigrationProgress>('wsl-migration-progress', ({ payload }) => {
        if (payload.distro === distro.name) setPhase(payload.phase)
      })
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
      if (picked) { setDirectory(picked); setError(null); setPlan(null) }
    } catch (e) { setError(toAppError(e)) }
  })

  const activePhase = PHASES.findIndex(item => item.id === phase)

  return (
    <Modal icon={result ? <CircleCheck size={16} /> : <ArrowRightLeft size={16} />}
      title={result ? `${distro.name} moved` : `Move ${distro.name}`}
      onClose={onClose} blocking={busy} returnFocusRef={returnFocusRef}>
      <div className="wsl-migration">
        {result ? (
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
          <ErrorBanner error={error} className="error-banner--flush" action={
            <button className="btn-secondary" disabled={reveal.pending} onClick={() => revealPath(error.recoveryPath!)}><FolderOpen size={13} /> Show recovery guide</button>
          } />
        ) : plan ? (
          <>
            <p className="modal-body" ref={reviewRef} tabIndex={-1}>Review the move, then confirm when your work is saved.</p>
            <div className="wsl-migration-location"><span>Move to</span><code>{plan.destination}</code>
              {plan.create_directory && <small>This folder will be created when you confirm.</small>}
            </div>
            <div className="wsl-migration-space"><Check size={14} aria-hidden="true" /><span>{bytesToHuman(plan.available_bytes)} free · {bytesToHuman(plan.required_bytes)} needed, including backup</span></div>
            <div className="wsl-migration-notice">
              <TriangleAlert size={16} aria-hidden="true" />
              <div><strong>All WSL sessions will stop</strong>
                <p>Save your work and close WSL terminals and editors before continuing.</p>
                {plan.running_distros.length > 0 && <p className="wsl-migration-running">Running: {plan.running_distros.join(', ')}</p>}
              </div>
            </div>
            <details className="wsl-migration-details"><summary>What happens to my files?</summary>
              <p>Atlas backs up and checks the disk before moving it. Your Linux files, settings, and distribution name stay the same.</p>
              <p>The backup and recovery guide are kept beside the new folder. Windows-mounted files and Docker Desktop data are stored separately.</p>
              <p>{distro.running ? 'This distribution restarts for a final check. Other distributions remain stopped.' : 'This distribution is stopped again after a final check. Other distributions remain stopped.'}</p>
            </details>
          </>
        ) : (
          <>
            <p className="modal-body">Choose where to store the distribution. Atlas keeps a backup before moving it.</p>
            <form id="wsl-migration-location" onSubmit={event => { event.preventDefault(); review() }}>
              <Field label="Destination folder">
                <div className="wsl-import-row">
                  <input ref={directoryRef} className="settings-dir-input" aria-label="Destination folder" value={directory}
                    onChange={event => { setDirectory(event.target.value); setError(null) }}
                    autoFocus placeholder="e.g. F:\ or F:\WSL\Ubuntu" spellCheck={false} disabled={busy} />
                  <button type="button" className="settings-dir-btn" disabled={busy} onClick={pickFolder}>Browse…</button>
                </div>
              </Field>
            </form>
            <p className="wsl-migration-note">Pick a drive to get a suggested folder, or enter a new folder path.</p>
            {error && <ErrorBanner error={error} className="error-banner--flush" />}
          </>
        )}
        <div className="modal-actions">
          {plan && !result && !move.pending && <button className="btn-secondary modal-actions-escape" onClick={() => { setPlan(null); setError(null) }}>Back</button>}
          <button className="btn-secondary" onClick={onClose} disabled={busy}>{result || error?.recoveryPath ? 'Close' : 'Cancel'}</button>
          {!result && !error?.recoveryPath && !move.pending && (plan ? (
            <button key="confirm-move" className="btn-filled btn-filled--accent" onClick={runMigrate} disabled={busy || busyDistro !== null}><ArrowRightLeft size={13} /> {plan.create_directory ? 'Create folder and move' : 'Move distribution'}</button>
          ) : (
            <button key="review-location" type="submit" form="wsl-migration-location" className="btn-filled btn-filled--accent" disabled={busy || busyDistro !== null || !directory.trim()}>{check.pending ? 'Checking…' : error ? 'Check again' : 'Continue'}</button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
