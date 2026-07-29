import { useState, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Shield, Layers, Zap, Eye, Play, RotateCcw, AlertTriangle, Check } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import { dockerPrunePreview, dockerPruneRun, dockerSystemDf } from '../api'
import ModalShell from '../../../components/ModalShell'
import { ErrorBanner } from '../../../components/ui'
import { bytesToHuman, parseSizeBytes } from '../../../utils/format'
import type { PrunePreview, LogEntry } from '../types'

const LEVELS = [
  { level: 1 as const, icon: Shield, label: 'Safe',    sublabel: 'Dangling images only',  desc: 'Removes untagged images with no containers. Zero risk.',                                 color: 'success' },
  { level: 2 as const, icon: Layers, label: 'Deep',    sublabel: 'All unused images',      desc: 'Removes every unused image not in your keep-list.',                                     color: 'warning' },
  { level: 3 as const, icon: Zap,    label: 'Nuclear', sublabel: 'Full system cleanup',    desc: 'Containers, images, volumes, build cache - keep-list respected.',                       color: 'danger'  },
] as const

type PruneState = 'idle' | 'previewing' | 'confirming' | 'running' | 'done'

/** What the prune actually cost the disk, measured either side of the run. */
interface PruneResult {
  before: number | null
  after:  number | null
  freed:  number | null
  command: string
}

/** Total bytes Docker is holding, summed across its four object classes.
 *  Returns null when the engine will not answer, so the result panel can say
 *  it does not know rather than print a confident zero. */
async function measureDockerBytes(): Promise<number | null> {
  try {
    const df = await dockerSystemDf()
    return [df.images, df.containers, df.volumes, df.build_cache]
      .reduce((n, row) => n + parseSizeBytes(row.size), 0)
  } catch {
    return null
  }
}

export default function PruneTab({ onDone }: { onDone: () => void }) {
  const { dockerKeepList, addDockerLog, addTerminalLine, addActivity } = useAppStore()

  const [selectedLevel, setSelectedLevel] = useState<1 | 2 | 3>(1)
  const [pruneState, setPruneState]       = useState<PruneState>('idle')
  const [preview, setPreview]             = useState<PrunePreview | null>(null)
  const [previewError, setPreviewError]   = useState<unknown>(null)
  const [result, setResult]               = useState<PruneResult | null>(null)
  const [confirmText, setConfirmText]     = useState('')
  const confirmRef = useRef<HTMLInputElement>(null)

  const handlePreview = async () => {
    setPruneState('previewing')
    setPreview(null)
    setPreviewError(null)
    setResult(null)
    addTerminalLine(`$ docker prune --dry-run --level ${selectedLevel}`, 'cmd')
    try {
      const p = await dockerPrunePreview(selectedLevel, dockerKeepList)
      setPreview(p)
      addTerminalLine(`  ✓ preview: ${p.image_names.length} image(s) · ~${p.reclaim_size} reclaimable`, 'success')
      setPruneState('idle')
    } catch (e) {
      setPreviewError(e)
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      setPruneState('idle')
    }
  }

  const handleExecute = () => {
    if (selectedLevel === 3) { setPruneState('confirming'); setTimeout(() => confirmRef.current?.focus(), 50) }
    else runPrune()
  }

  const runPrune = async () => {
    if (!preview) return
    setPruneState('running')
    setResult(null)

    const lines: string[] = []
    const startTime = Date.now()
    const command   = preview.command
    addTerminalLine(`─── Prune Level ${selectedLevel} - executing ───`, 'info')

    // PRODUCT.md makes before/after numbers a hard constraint for anything that
    // changes disk usage. `docker system df` is the same source the Overview
    // reads, so the figure here and the figure there cannot disagree.
    const before = await measureDockerBytes()

    const unlistenLog = await listen<string>('docker-log', (e) => {
      lines.push(e.payload)
      const type = e.payload.startsWith('$') ? 'cmd' : e.payload.startsWith('[err]') ? 'stderr' : 'stdout'
      addTerminalLine(e.payload, type)
    })

    let success = false
    let runError: unknown = null
    try {
      await dockerPruneRun(selectedLevel, preview.image_ids)
      success = true
      addTerminalLine('─── Done ───', 'success')
    } catch (e) {
      runError = e
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlistenLog()
    }

    const after = success ? await measureDockerBytes() : before
    const freed = before !== null && after !== null ? Math.max(0, before - after) : null
    if (success) setResult({ before, after, freed, command })
    else setPreviewError(runError)

    addDockerLog({ id: `${startTime}`, timestamp: startTime, level: selectedLevel, dry_run: false, lines, success } satisfies LogEntry)
    addActivity({
      module: 'docker',
      action: `Prune - ${LEVELS[selectedLevel - 1].label}`,
      outcome: success ? 'success' : 'failure',
      detail: success && freed !== null ? `${bytesToHuman(freed)} reclaimed` : undefined,
    })
    setPruneState('done')
    setConfirmText('')
    onDone()
  }

  const reset = () => {
    setPruneState('idle'); setPreview(null); setPreviewError(null)
    setConfirmText(''); setResult(null)
  }

  const running    = pruneState === 'running'
  const canExecute = preview !== null && pruneState === 'idle' && preview.image_ids.length > 0

  return (
    <div className="prune-tab">
      <p className="section-label">Select prune level</p>
      <div className="prune-levels">
        {LEVELS.map(({ level, icon: Icon, label, sublabel, desc, color }) => (
          <button
            key={level}
            className={clsx('prune-level-card', `prune-level--${color}`, selectedLevel === level && 'selected')}
            onClick={() => { setSelectedLevel(level); setPreview(null); setPreviewError(null) }}
            disabled={running}
          >
            <div className={clsx('prune-level-badge', `prune-badge--${color}`, selectedLevel === level && 'active')}>
              <Icon size={14} /><span>{level}</span>
            </div>
            <div className="prune-level-text">
              <p className="prune-level-label">{label}<span className="prune-level-sublabel"> - {sublabel}</span></p>
              <p className="prune-level-desc">{desc}</p>
            </div>
            {selectedLevel === level && <div className={clsx('prune-selected-pip', `prune-pip--${color}`)} />}
          </button>
        ))}
      </div>

      {dockerKeepList.length > 0 && (
        <div className="prune-keeplist">
          <Shield size={12} />
          <span>{dockerKeepList.length} pinned image{dockerKeepList.length !== 1 ? 's' : ''} protected from pruning</span>
        </div>
      )}

      <div className="prune-actions">
        <button className="btn-secondary" onClick={handlePreview} disabled={pruneState === 'previewing' || running}>
          <Eye size={14} />{pruneState === 'previewing' ? 'Calculating…' : 'Preview changes'}
        </button>
        {canExecute && (
          <button className={clsx('btn-filled', `btn-filled--${LEVELS[selectedLevel - 1].color}`)} onClick={handleExecute}>
            <Play size={13} />Execute Level {selectedLevel}
          </button>
        )}
        {(preview || previewError != null || result) && (
          <button className="btn-ghost" onClick={reset} disabled={running}><RotateCcw size={12} />Reset</button>
        )}
        {running && <span className="prune-running-notice">Running - see Terminal panel below</span>}
      </div>

      {previewError != null && (
        <ErrorBanner
          title={pruneState === 'done' ? 'The prune did not finish' : 'Could not calculate the preview'}
          error={previewError}
        />
      )}

      {result && pruneState === 'done' && (
        <div className="prune-result">
          <div className="prune-result-head">
            <Check size={14} className="prune-result-icon" aria-hidden="true" />
            <p className="prune-result-title">
              {result.freed === null
                ? 'Prune finished'
                : result.freed > 0
                  ? `Reclaimed ${bytesToHuman(result.freed)}`
                  : 'Nothing left to reclaim'}
            </p>
          </div>
          {result.before !== null && result.after !== null ? (
            <p className="prune-result-delta num">
              Docker was holding {bytesToHuman(result.before)}, now {bytesToHuman(result.after)}.
            </p>
          ) : (
            <p className="prune-result-delta">
              The engine did not report its disk usage, so the exact figure is unknown.
              The Overview will show the current total once it refreshes.
            </p>
          )}
          <div className="cmd-block">
            <span className="cmd-block-label">What ran</span>
            <code className="cmd-block-code">{result.command}</code>
          </div>
        </div>
      )}

      {preview && pruneState !== 'running' && pruneState !== 'done' && (
        <div className="prune-preview">
          <div className="prune-preview-header">
            <span className="prune-preview-title">Dry-run Preview</span>
            {preview.reclaim_bytes > 0
              ? <span className="prune-reclaim">~{preview.reclaim_size} reclaimable</span>
              : <span className="prune-reclaim-zero">Nothing to remove</span>}
          </div>
          <div className="cmd-block">
            <span className="cmd-block-label">Exact command</span>
            <code className="cmd-block-code">{preview.command}</code>
          </div>
          {preview.image_names.length > 0 ? (
            <div className="prune-image-list">
              <p className="prune-image-list-heading">{preview.image_names.length} image{preview.image_names.length !== 1 ? 's' : ''} to remove</p>
              <ul>{preview.image_names.map(name => <li key={name} className="prune-image-item">{name}</li>)}</ul>
            </div>
          ) : <p className="prune-nothing">No images match this level - nothing to remove.</p>}
          {preview.level === 3 && (preview.container_count > 0 || preview.volume_count > 0) && (
            <div className="prune-extras">
              <AlertTriangle size={11} className="prune-extras-icon" />
              {preview.container_count > 0 && <span className="prune-extra-badge">{preview.container_count} stopped container{preview.container_count !== 1 ? 's' : ''}</span>}
              {preview.volume_count > 0 && <span className="prune-extra-badge">{preview.volume_count} unused volume{preview.volume_count !== 1 ? 's' : ''}</span>}
              <span className="prune-extra-badge">build cache</span>
            </div>
          )}
        </div>
      )}

      {pruneState === 'confirming' && (
        <ModalShell className="modal-overlay" onClose={() => { setPruneState('idle'); setConfirmText('') }}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap danger"><Zap size={16} /></div>
              <h2 className="modal-title">Nuclear Prune - Confirm</h2>
            </div>
            <p className="modal-body">
              This removes stopped containers, all unused images outside your keep-list,
              all unused volumes, and all build cache.
              Type <strong>I understand</strong> to proceed.
            </p>
            <input ref={confirmRef} className="modal-input" type="text" aria-label='Type "I understand" to confirm' placeholder='Type "I understand"' value={confirmText} onChange={e => setConfirmText(e.target.value)} />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setPruneState('idle'); setConfirmText('') }}>Cancel</button>
              <button className="btn-filled btn-filled--danger" disabled={confirmText !== 'I understand'} onClick={runPrune}>Execute Nuclear Prune</button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  )
}
