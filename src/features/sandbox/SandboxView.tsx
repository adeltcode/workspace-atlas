import { useCallback, useEffect, useRef, useState } from 'react'
import { AppWindow, FolderOpen, RefreshCw } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useVisiblePoll } from '../../hooks/useVisiblePoll'
import { Button, ConfirmDestructive, EmptyState, ErrorBanner, Panel, Prerequisite, SheetHead } from '../../components/ui'
import { pickDirectory } from '../wsl/api'
import * as api from './api'
import type { SandboxStatus, SandboxSwitches } from './api'

const POLL_MS = 10_000
const MEMORY_GB = [4, 8, 16]

const SWITCHES: { key: keyof SandboxSwitches; label: string; help: string }[] = [
  { key: 'microphone', label: 'Share your microphone', help: 'Programs inside can listen through it.' },
  { key: 'camera', label: 'Share your camera', help: 'Programs inside can see through it.' },
  { key: 'clipboard', label: 'Share your clipboard', help: 'Copy and paste work both ways, so programs inside can read what you copy.' },
  { key: 'printers', label: 'Share your printers', help: 'Programs inside can print to them.' },
  { key: 'graphics', label: 'Use your graphics card', help: 'The sandbox may run faster, but this can give programs inside more ways to attack your PC.' },
]

const ALL_OFF: SandboxSwitches = { microphone: false, camera: false, clipboard: false, printers: false, graphics: false }

export default function SandboxView() {
  const starting = useAppStore(s => s.sandboxStarting)
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const loading = useRef(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [networking, setNetworking] = useState(false)
  const [switches, setSwitches] = useState(ALL_OFF)
  const [memoryGb, setMemoryGb] = useState<number | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [writable, setWritable] = useState(false)
  const [stopTarget, setStopTarget] = useState<string | null>(null)
  const [stopBusy, setStopBusy] = useState(false)

  const load = useCallback(async () => {
    loading.current = true
    try {
      setStatus(await api.sandboxStatus())
      setLoadError(null)
    } catch (e) {
      setLoadError(e)
    } finally {
      loading.current = false
    }
  }, [])

  useEffect(() => { load() }, [load])
  useVisiblePoll(() => { if (!loading.current) load() }, POLL_MS, !stopTarget)

  // Permission to change a folder must not carry over to a different folder.
  const chooseFolder = async () => {
    const picked = await pickDirectory()
    if (picked) {
      setFolder(picked)
      setWritable(false)
    }
  }

  const openWindow = (id: string) => {
    setActionError(null)
    return api.sandboxOpenWindow(id).catch(setActionError)
  }

  const start = async () => {
    const { setSandboxStarting, addActivity } = useAppStore.getState()
    const sharing = folder ? `${writable ? 'Can change' : 'Read-only'}: ${folder}` : 'No shared folder'
    const alsoOn = SWITCHES.filter(s => switches[s.key]).map(s => s.key).join(', ') || 'nothing'
    const detail = `Network ${networking ? 'on' : 'off'}. ${sharing}. Also on: ${alsoOn}. Memory: ${memoryGb ? `${memoryGb} GB` : 'Windows default'}`
    setActionError(null)
    setSandboxStarting(true)
    try {
      const id = await api.sandboxStart({ networking, folder, writable, ...switches, memory_mb: memoryGb && memoryGb * 1024 })
      addActivity({ module: 'system', action: 'Start sandbox', outcome: 'success', detail })
      await openWindow(id)
    } catch (e) {
      setActionError(e)
      addActivity({ module: 'system', action: 'Start sandbox', outcome: 'failure', detail: `${detail}. ${String(e)}` })
    } finally {
      setSandboxStarting(false)
      load()
    }
  }

  const stop = async (id: string) => {
    const { addActivity } = useAppStore.getState()
    setActionError(null)
    setStopBusy(true)
    try {
      await api.sandboxStop(id)
      addActivity({ module: 'system', action: 'Stop sandbox', outcome: 'success', detail: id })
    } catch (e) {
      setActionError(e)
      addActivity({ module: 'system', action: 'Stop sandbox', outcome: 'failure', detail: `${id}: ${String(e)}` })
    } finally {
      setStopBusy(false)
      setStopTarget(null)
      load()
    }
  }

  const running = status?.running ?? []

  return (
    <div className="view-container">
      <div className="page-head">
        <SheetHead
          crumbs={[
            { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
            { label: 'Windows Sandbox' },
          ]}
          title="Windows Sandbox"
          subtitle="A clean, throwaway copy of Windows for trying programs. Everything inside is deleted when it stops."
          actions={<Button onClick={load}><RefreshCw size={12} /> Refresh</Button>}
        />
      </div>

      <div className="page-scroll">
        {loadError != null && <ErrorBanner title="Could not check Windows Sandbox" error={loadError} />}
        {actionError != null && <ErrorBanner error={actionError} />}
        {status === null && loadError == null && <div className="img-loading">Checking Windows Sandbox…</div>}

        {status?.available === false && (
          <Prerequisite
            title="Windows Sandbox is not ready on this PC"
            description="This page uses the wsb command. It needs Windows Pro, Enterprise, or Education with Windows Sandbox turned on."
            steps={[
              'Open PowerShell as administrator and run the command below.',
              'Restart your PC.',
              'If Windows Sandbox is already on, update Windows. Older versions do not include wsb.',
            ]}
            command="Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All"
            actions={<Button onClick={load}>Check again</Button>}
          />
        )}

        {status?.available && (
          <>
            <Panel title="New sandbox">
              <div className="panel-body sandbox-form">
                <label className="sandbox-option">
                  <input type="checkbox" checked={networking} onChange={e => setNetworking(e.target.checked)} />
                  <span>
                    Allow network access
                    <span className="sandbox-help">Programs inside can reach the internet and your local network.</span>
                  </span>
                </label>

                {SWITCHES.map(({ key, label, help }) => (
                  <label key={key} className="sandbox-option">
                    <input type="checkbox" checked={switches[key]} onChange={e => setSwitches({ ...switches, [key]: e.target.checked })} />
                    <span>
                      {label}
                      <span className="sandbox-help">{help}</span>
                    </span>
                  </label>
                ))}

                <label className="sandbox-memory">
                  Memory
                  <select className="wslcfg-field-control" value={memoryGb ?? ''} onChange={e => setMemoryGb(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Windows default</option>
                    {MEMORY_GB.map(gb => <option key={gb} value={gb}>{gb} GB</option>)}
                  </select>
                </label>

                <div className="sandbox-folder">
                  <Button onClick={chooseFolder}><FolderOpen size={12} /> {folder ? 'Change folder' : 'Share a folder'}</Button>
                  {folder && (
                    <>
                      <span className="holder-path" title={folder}>{folder}</span>
                      <Button size="sm" variant="ghost" onClick={() => { setFolder(null); setWritable(false) }}>Remove</Button>
                    </>
                  )}
                </div>

                {folder && (
                  <label className="sandbox-option">
                    <input type="checkbox" checked={writable} onChange={e => setWritable(e.target.checked)} />
                    <span>
                      Let programs inside change this folder
                      <span className="sandbox-help">The folder appears on the sandbox desktop. When this is on, programs inside can edit or delete your real files.</span>
                    </span>
                  </label>
                )}

                <Button variant="primary" disabled={starting || running.length > 0} onClick={start}>
                  {starting ? 'Starting…' : 'Start sandbox'}
                </Button>
                {running.length > 0 && <span className="sandbox-help">Windows runs one sandbox at a time. Stop this one to start another.</span>}
              </div>
            </Panel>

            <Panel title="Running" meta={running.length > 0 ? String(running.length) : undefined}>
              {running.length === 0 ? (
                <EmptyState title="No sandbox is running" description="Start one above. A window opens when it is ready." />
              ) : (
                <table className="img-table">
                  <thead>
                    <tr>
                      <th className="img-th">Sandbox ID</th>
                      <th className="img-th holder-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {running.map(id => (
                      <tr key={id} className="img-row">
                        <td className="img-td img-id">{id}</td>
                        <td className="img-td">
                          <div className="sandbox-actions">
                            <Button size="sm" onClick={() => openWindow(id)} aria-label={`Open window for sandbox ${id}`}>
                              <AppWindow size={12} /> Open window
                            </Button>
                            <Button size="sm" variant="danger-outline" onClick={() => { setActionError(null); setStopTarget(id) }} aria-label={`Stop sandbox ${id}`}>
                              Stop
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </>
        )}
      </div>

      {stopTarget && (
        <ConfirmDestructive
          title="Stop this sandbox?"
          consequence="Windows shuts it down and deletes everything inside it, including anything you installed or saved there. Changes already made to a shared folder stay on your PC."
          command={`wsb stop --id ${stopTarget}`}
          items={[{ name: stopTarget }]}
          summary="1 sandbox"
          confirmLabel="Stop sandbox"
          busyLabel="Stopping…"
          busy={stopBusy}
          onConfirm={() => stop(stopTarget)}
          onCancel={() => setStopTarget(null)}
        />
      )}
    </div>
  )
}
