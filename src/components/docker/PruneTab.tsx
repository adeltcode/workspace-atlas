import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Shield, Layers, Zap, Eye, Play, X } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import type { DockerImage, PrunePreview, LogEntry } from '../../types/docker'

const LEVELS = [
  {
    level: 1,
    icon: Shield,
    label: 'Level 1 — Safe',
    desc: 'Removes only dangling (untagged) images. Zero risk to running containers.',
    color: 'success',
  },
  {
    level: 2,
    icon: Layers,
    label: 'Level 2 — Deep',
    desc: 'Removes all unused images not referenced by any container, respecting your keep-list.',
    color: 'warning',
  },
  {
    level: 3,
    icon: Zap,
    label: 'Level 3 — Nuclear',
    desc: 'Removes stopped containers, unused images (keep-list respected), volumes, and build cache.',
    color: 'danger',
  },
] as const

type PruneState = 'idle' | 'previewing' | 'confirming' | 'running' | 'done'

export default function PruneTab({
  images: _images,
  onDone,
}: {
  images: DockerImage[]
  onDone: () => void
}) {
  const { dockerKeepList, addDockerLog } = useAppStore()

  const [selectedLevel, setSelectedLevel] = useState<1 | 2 | 3>(1)
  const [pruneState, setPruneState] = useState<PruneState>('idle')
  const [preview, setPreview] = useState<PrunePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logLines])

  const handlePreview = async () => {
    setPruneState('previewing')
    setPreview(null)
    setPreviewError(null)
    try {
      const p = await invoke<PrunePreview>('docker_prune_preview', {
        level: selectedLevel,
        keepList: dockerKeepList,
      })
      setPreview(p)
      setPruneState('idle')
    } catch (e) {
      setPreviewError(String(e))
      setPruneState('idle')
    }
  }

  const handleExecute = () => {
    if (selectedLevel === 3) {
      setPruneState('confirming')
    } else {
      runPrune()
    }
  }

  const runPrune = async () => {
    if (!preview) return
    setPruneState('running')
    setLogLines([])

    const lines: string[] = []
    const startTime = Date.now()

    // Listen for streamed log lines
    const unlistenLog = await listen<string>('docker-log', (e) => {
      lines.push(e.payload)
      setLogLines((prev) => [...prev, e.payload])
    })

    let success = false
    try {
      await invoke('docker_prune_run', {
        level: selectedLevel,
        imageIds: preview.image_ids,
      })
      success = true
    } catch (e) {
      lines.push(`[error] ${String(e)}`)
      setLogLines((prev) => [...prev, `[error] ${String(e)}`])
    } finally {
      unlistenLog()
    }

    // Save to run history
    const entry: LogEntry = {
      id: `${startTime}`,
      timestamp: startTime,
      level: selectedLevel,
      dry_run: false,
      lines,
      success,
    }
    addDockerLog(entry)

    setPruneState('done')
    setConfirmText('')
    onDone()
  }

  const reset = () => {
    setPruneState('idle')
    setPreview(null)
    setPreviewError(null)
    setLogLines([])
    setConfirmText('')
  }

  const running = pruneState === 'running'
  const canExecute = preview !== null && pruneState === 'idle'

  return (
    <div className="prune-tab">
      {/* Level selector */}
      <p className="section-label">Prune Level</p>
      <div className="prune-levels">
        {LEVELS.map(({ level, icon: Icon, label, desc, color }) => (
          <button
            key={level}
            className={clsx('prune-level-card', `prune-level--${color}`, selectedLevel === level && 'selected')}
            onClick={() => { setSelectedLevel(level); setPreview(null); setPreviewError(null) }}
            disabled={running}
          >
            <div className={clsx('prune-level-icon', `prune-icon--${color}`)}>
              <Icon size={18} />
            </div>
            <div>
              <p className="prune-level-label">{label}</p>
              <p className="prune-level-desc">{desc}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Keep-list summary */}
      {dockerKeepList.length > 0 && (
        <div className="prune-keeplist">
          <Shield size={13} />
          <span>{dockerKeepList.length} pinned image{dockerKeepList.length !== 1 ? 's' : ''} protected from pruning</span>
        </div>
      )}

      {/* Action row */}
      <div className="prune-actions">
        <button
          className="btn-preview"
          onClick={handlePreview}
          disabled={pruneState === 'previewing' || running}
        >
          <Eye size={14} />
          {pruneState === 'previewing' ? 'Calculating…' : 'Preview'}
        </button>

        {canExecute && (
          <button
            className={clsx('btn-execute', `btn-execute--${LEVELS[selectedLevel - 1].color}`)}
            onClick={handleExecute}
          >
            <Play size={14} />
            Execute Level {selectedLevel}
          </button>
        )}

        {(preview || previewError || logLines.length > 0) && (
          <button className="btn-reset" onClick={reset} disabled={running}>
            <X size={13} />
            Reset
          </button>
        )}
      </div>

      {/* Preview error */}
      {previewError && (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{previewError}</span>
        </div>
      )}

      {/* Dry-run preview */}
      {preview && pruneState !== 'running' && (
        <div className="prune-preview">
          <div className="prune-preview-header">
            <span className="prune-preview-title">Dry-run Preview</span>
            <span className="prune-reclaim">
              ~{preview.reclaim_size} reclaimable
            </span>
          </div>

          {/* Exact command */}
          <div className="prune-command">
            <span className="prune-command-label">Command</span>
            <code className="prune-command-code">{preview.command}</code>
          </div>

          {/* What gets removed */}
          {preview.image_names.length > 0 ? (
            <div className="prune-image-list">
              <p className="prune-image-list-heading">
                {preview.image_names.length} image{preview.image_names.length !== 1 ? 's' : ''} to remove:
              </p>
              <ul>
                {preview.image_names.map((name) => (
                  <li key={name} className="prune-image-item">{name}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="prune-nothing">Nothing to remove at this level.</p>
          )}

          {preview.level === 3 && (preview.container_count > 0 || preview.volume_count > 0) && (
            <div className="prune-extras">
              {preview.container_count > 0 && (
                <span className="prune-extra-badge">
                  {preview.container_count} stopped container{preview.container_count !== 1 ? 's' : ''}
                </span>
              )}
              {preview.volume_count > 0 && (
                <span className="prune-extra-badge">
                  {preview.volume_count} unused volume{preview.volume_count !== 1 ? 's' : ''}
                </span>
              )}
              <span className="prune-extra-badge">build cache</span>
            </div>
          )}
        </div>
      )}

      {/* Level 3 confirmation modal */}
      {pruneState === 'confirming' && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <Zap size={18} className="modal-icon danger" />
              <h2 className="modal-title">Nuclear Prune — Confirm</h2>
            </div>
            <p className="modal-body">
              This will remove all stopped containers, unused images (keep-list excluded),
              all unused volumes, and all build cache. Type <strong>I understand</strong> to proceed.
            </p>
            <input
              className="modal-input"
              type="text"
              placeholder='Type "I understand"'
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
            />
            <div className="modal-actions">
              <button
                className="btn-modal-cancel"
                onClick={() => { setPruneState('idle'); setConfirmText('') }}
              >
                Cancel
              </button>
              <button
                className="btn-modal-confirm"
                disabled={confirmText !== 'I understand'}
                onClick={runPrune}
              >
                Execute Nuclear Prune
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live log panel */}
      {(running || pruneState === 'done') && logLines.length > 0 && (
        <div className="prune-log-panel">
          <p className="prune-log-heading">
            {running ? 'Running…' : pruneState === 'done' ? 'Done' : ''}
          </p>
          <div className="prune-log-output" ref={logRef}>
            {logLines.map((line, i) => (
              <div
                key={i}
                className={clsx(
                  'log-line',
                  line.startsWith('$') && 'log-cmd',
                  line.startsWith('[err]') && 'log-err',
                )}
              >
                {line}
              </div>
            ))}
            {running && <div className="log-cursor" />}
          </div>
        </div>
      )}
    </div>
  )
}
