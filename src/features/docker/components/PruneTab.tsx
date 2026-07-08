import { useState, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Shield, Layers, Zap, Eye, Play, RotateCcw, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import { ModalOverlay } from '../../../components/Modal'
import { dockerPrunePreview, dockerPruneRun } from '../api'
import type { PrunePreview, LogEntry } from '../types'

const LEVELS = [
  { level: 1 as const, icon: Shield, label: 'Safe',    sublabel: 'Dangling images only',  desc: 'Removes untagged images with no containers. Zero risk.',                                 color: 'success' },
  { level: 2 as const, icon: Layers, label: 'Deep',    sublabel: 'All unused images',      desc: 'Removes every unused image not in your keep-list.',                                     color: 'warning' },
  { level: 3 as const, icon: Zap,    label: 'Nuclear', sublabel: 'Full system cleanup',    desc: 'Containers, images, volumes, build cache — keep-list respected.',                       color: 'danger'  },
] as const

type PruneState = 'idle' | 'previewing' | 'confirming' | 'running' | 'done'

export default function PruneTab({ onDone }: { onDone: () => void }) {
  const { dockerKeepList, addDockerLog, addTerminalLine, addActivity } = useAppStore()

  const [selectedLevel, setSelectedLevel] = useState<1 | 2 | 3>(1)
  const [pruneState, setPruneState]       = useState<PruneState>('idle')
  const [preview, setPreview]             = useState<PrunePreview | null>(null)
  const [previewError, setPreviewError]   = useState<string | null>(null)
  const [confirmText, setConfirmText]     = useState('')
  const confirmRef = useRef<HTMLInputElement>(null)

  const handlePreview = async () => {
    setPruneState('previewing')
    setPreview(null)
    setPreviewError(null)
    addTerminalLine(`$ docker prune --dry-run --level ${selectedLevel}`, 'cmd')
    try {
      const p = await dockerPrunePreview(selectedLevel, dockerKeepList)
      setPreview(p)
      addTerminalLine(`  ✓ preview: ${p.image_names.length} image(s) · ~${p.reclaim_size} reclaimable`, 'success')
      setPruneState('idle')
    } catch (e) {
      setPreviewError(String(e))
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

    const lines: string[] = []
    const startTime = Date.now()
    addTerminalLine(`─── Prune Level ${selectedLevel} — executing ───`, 'info')

    const unlistenLog = await listen<string>('docker-log', (e) => {
      lines.push(e.payload)
      const type = e.payload.startsWith('$') ? 'cmd' : e.payload.startsWith('[err]') ? 'stderr' : 'stdout'
      addTerminalLine(e.payload, type)
    })

    let success = false
    try {
      await dockerPruneRun(selectedLevel, preview.image_ids)
      success = true
      addTerminalLine('─── Done ───', 'success')
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
    } finally {
      unlistenLog()
    }

    addDockerLog({ id: `${startTime}`, timestamp: startTime, level: selectedLevel, lines, success } satisfies LogEntry)
    addActivity({
      module: 'docker',
      action: `Prune — ${LEVELS[selectedLevel - 1].label}`,
      outcome: success ? 'success' : 'failure',
      detail: success && preview.reclaim_bytes > 0 ? `~${preview.reclaim_size} reclaimable` : undefined,
    })
    setPruneState('done')
    setConfirmText('')
    onDone()
  }

  const reset = () => { setPruneState('idle'); setPreview(null); setPreviewError(null); setConfirmText('') }

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
              <p className="prune-level-label">{label}<span className="prune-level-sublabel"> — {sublabel}</span></p>
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
        {(preview || previewError) && (
          <button className="btn-ghost" onClick={reset} disabled={running}><RotateCcw size={12} />Reset</button>
        )}
        {running && <span className="prune-running-notice">Running — see Terminal panel below</span>}
      </div>

      {previewError && (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <span className="error-title">Error</span><span className="error-msg">{previewError}</span>
        </div>
      )}

      {preview && pruneState !== 'running' && (
        <div className="prune-preview">
          <div className="prune-preview-header">
            <span className="prune-preview-title">Dry-run Preview</span>
            {preview.reclaim_bytes > 0
              ? <span className="prune-reclaim">~{preview.reclaim_size} reclaimable</span>
              : <span className="prune-reclaim-zero">Nothing to remove</span>}
          </div>
          <div className="prune-command">
            <span className="prune-command-label">Exact command</span>
            <code className="prune-command-code">{preview.command}</code>
          </div>
          {preview.image_names.length > 0 ? (
            <div className="prune-image-list">
              <p className="prune-image-list-heading">{preview.image_names.length} image{preview.image_names.length !== 1 ? 's' : ''} to remove</p>
              <ul>{preview.image_names.map(name => <li key={name} className="prune-image-item">{name}</li>)}</ul>
            </div>
          ) : <p className="prune-nothing">No images match this level — nothing to remove.</p>}
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
        <ModalOverlay onClose={() => { setPruneState('idle'); setConfirmText('') }} labelledBy="prune-confirm-title">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap danger"><Zap size={16} /></div>
              <h2 className="modal-title" id="prune-confirm-title">Nuclear Prune — Confirm</h2>
            </div>
            <p className="modal-body">
              This removes stopped containers, all unused images outside your keep-list,
              all unused volumes, and all build cache.
              Type <strong>I understand</strong> to proceed.
            </p>
            <input ref={confirmRef} className="modal-input" type="text" placeholder='Type "I understand"' value={confirmText} onChange={e => setConfirmText(e.target.value)} />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setPruneState('idle'); setConfirmText('') }}>Cancel</button>
              <button className="btn-filled btn-filled--danger" disabled={confirmText !== 'I understand'} onClick={runPrune}>Execute Nuclear Prune</button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
