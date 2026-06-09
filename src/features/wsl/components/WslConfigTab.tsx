import { useCallback, useEffect, useState } from 'react'
import { Save, RotateCcw, FolderOpen, Power, FilePlus, AlertTriangle } from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'

const TEMPLATE = `# Global WSL2 configuration. Applies to all WSL2 distributions.
# Changes take effect after a WSL restart (wsl --shutdown).

[wsl2]
# Memory WSL2 may use (e.g. 8GB, 4096MB)
memory=8GB

# Number of logical processors
processors=4

# Swap file size (0 to disable)
swap=2GB

# Forward localhost ports from the distro to Windows
localhostForwarding=true
`

type Status = { type: 'success' | 'error'; text: string } | null

export default function WslConfigTab({ runningNames, onAfterShutdown }: {
  runningNames: string[]
  onAfterShutdown: () => void
}) {
  const addActivity     = useAppStore(s => s.addActivity)
  const addTerminalLine = useAppStore(s => s.addTerminalLine)

  const [path, setPath]         = useState('')
  const [content, setContent]   = useState('')
  const [original, setOriginal] = useState('')
  const [exists, setExists]     = useState(true)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [status, setStatus]     = useState<Status>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const cfg = await api.readWslConfig()
      setPath(cfg.path)
      setContent(cfg.content)
      setOriginal(cfg.content)
      setExists(cfg.exists)
    } catch (e) {
      setStatus({ type: 'error', text: String(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const dirty = content !== original

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      await api.writeWslConfig(content)
      setOriginal(content)
      setExists(true)
      addTerminalLine(`  ✓ saved ${path}`, 'success')
      addActivity({ module: 'wsl', action: 'Edited .wslconfig', outcome: 'success' })
      setStatus({ type: 'success', text: 'Saved. Restart WSL to apply changes.' })
    } catch (e) {
      addActivity({ module: 'wsl', action: 'Edited .wslconfig', outcome: 'failure', detail: String(e) })
      setStatus({ type: 'error', text: String(e) })
    } finally {
      setSaving(false)
    }
  }

  const restart = async () => {
    setConfirmRestart(false)
    setRestarting(true)
    setStatus(null)
    addTerminalLine('$ wsl --shutdown', 'cmd')
    try {
      await api.wslShutdown()
      addTerminalLine('  ✓ all distributions stopped', 'success')
      addActivity({ module: 'wsl', action: 'WSL shutdown', outcome: 'success' })
      setStatus({ type: 'success', text: 'WSL restarted — changes are now applied.' })
      onAfterShutdown()
    } catch (e) {
      addTerminalLine(`  ✗ ${String(e)}`, 'error')
      addActivity({ module: 'wsl', action: 'WSL shutdown', outcome: 'failure', detail: String(e) })
      setStatus({ type: 'error', text: String(e) })
    } finally {
      setRestarting(false)
    }
  }

  if (loading) return <div className="empty-state" style={{ marginTop: 24 }}>Loading .wslconfig…</div>

  return (
    <div className="wslcfg">
      <div className="wslcfg-bar">
        <button className="wsl-distro-path wslcfg-path" onClick={() => api.revealPath(path).catch(() => {})} title="Reveal in Explorer">
          <FolderOpen size={12} />
          <span className="wsl-distro-path-text">{path}</span>
        </button>
        {!exists && <span className="wslcfg-missing">File does not exist yet</span>}
      </div>

      {!exists && !content && (
        <button className="btn-secondary wslcfg-template-btn" onClick={() => setContent(TEMPLATE)}>
          <FilePlus size={13} /> Insert template
        </button>
      )}

      <textarea
        className="wslcfg-editor"
        value={content}
        onChange={e => { setContent(e.target.value); setStatus(null) }}
        spellCheck={false}
        placeholder="# .wslconfig is empty. Click 'Insert template' or type settings under [wsl2]."
      />

      {status && <div className={`settings-status settings-status--${status.type}`}>{status.text}</div>}

      <div className="wslcfg-actions">
        <button className="btn-filled btn-filled--accent" onClick={save} disabled={!dirty || saving}>
          <Save size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-ghost" onClick={() => setContent(original)} disabled={!dirty || saving}>
          <RotateCcw size={12} /> Reset
        </button>
        <button className="btn-secondary wslcfg-restart-btn" onClick={() => setConfirmRestart(true)} disabled={restarting}>
          <Power size={13} /> {restarting ? 'Restarting…' : 'Restart WSL to apply'}
        </button>
      </div>

      <p className="wslcfg-note">
        Changes are written to <code>.wslconfig</code> immediately, but only take effect after WSL restarts.
      </p>

      {confirmRestart && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className="modal-icon-wrap danger"><AlertTriangle size={16} /></div>
              <h2 className="modal-title">Restart WSL?</h2>
            </div>
            <p className="modal-body">
              <code>wsl --shutdown</code> stops every running distribution immediately.
              {runningNames.length > 0
                ? <> Currently running: <strong>{runningNames.join(', ')}</strong>. Unsaved work inside them will be lost.</>
                : ' No distributions appear to be running.'}
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmRestart(false)}>Cancel</button>
              <button className="btn-filled btn-filled--danger" onClick={restart}>Shut down WSL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
