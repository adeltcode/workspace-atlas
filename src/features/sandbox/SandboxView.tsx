import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { AppWindow, File, FolderOpen, RefreshCw } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useVisiblePoll } from '../../hooks/useVisiblePoll'
import { Button, ConfirmDestructive, ErrorBanner, Panel, Prerequisite, SectionHead, SheetHead, StatCard, StatRow, Tag } from '../../components/ui'
import { FileDropPrompt, FileDropZone } from '../../components/FileDropZone'
import { pickAnyFile } from '../holders/api'
import { pickDirectory } from '../wsl/api'
import * as api from './api'
import type { SandboxStatus, SandboxSwitches } from './api'

const POLL_MS = 10_000
const WINDOW_APPEARS_MS = 1_500
const MEMORY_GB = [8, 16]

const SWITCHES: { key: keyof SandboxSwitches; label: string; help: string }[] = [
  { key: 'networking', label: 'Network', help: 'The internet and your local network.' },
  { key: 'clipboard', label: 'Clipboard', help: 'Copy and paste. Programs can read what you copy.' },
  { key: 'microphone', label: 'Microphone', help: 'Programs can listen through it.' },
  { key: 'camera', label: 'Camera', help: 'Programs can see through it.' },
  { key: 'printers', label: 'Printers', help: 'Programs can print to them.' },
  { key: 'graphics', label: 'Graphics card', help: 'May run faster, but is less isolated.' },
]

const ALL_OFF: SandboxSwitches = { networking: false, microphone: false, camera: false, clipboard: false, printers: false, graphics: false }

// Outside the component so leaving the page and coming back does not read everything again.
const detailsAsked = new Set<string>()

const gigabytes = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`

function RunningSandbox({ id, status, onOpenWindow, onStop }: {
  id: string
  status: SandboxStatus
  onOpenWindow: (id: string) => void
  onStop: (id: string) => void
}) {
  const details = useAppStore(s => s.sandboxDetails[id])
  const shared = useAppStore(s => s.sandboxShared[id])

  const fact = <T,>(value: T | null | undefined, show: (value: T) => string) =>
    !details ? '…' : value == null ? 'Unknown' : show(value)

  const used = status.memory_used_bytes
  const limitMb = details?.memory_mb
  const alsoShared = [...(shared ?? []), ...(details?.graphics ? ['Graphics card'] : [])]

  return (
    <div>
      <SectionHead
        title="Running sandbox"
        meta={!details && 'Reading details…'}
        actions={
          <>
            {!status.window_open && <Button size="sm" onClick={() => onOpenWindow(id)}><AppWindow size={12} /> Open window</Button>}
            <Button size="sm" variant="danger-outline" onClick={() => onStop(id)}>Stop</Button>
          </>
        }
      />
      <StatRow>
        <StatCard
          label="CPU"
          value={fact(details?.cpu_threads, String)}
          unit={details?.cpu_threads != null ? 'threads' : undefined}
          sub={details?.cpu_name && <span className="sandbox-cpu-name">{details.cpu_name.replace(/\s*\((R|TM)\)/g, '')}</span>}
        />
        <StatCard
          label="Memory in use"
          value={used == null ? 'Unknown' : gigabytes(used)}
          unit={limitMb != null ? `of ${Math.round(limitMb / 1024)} GB` : undefined}
          pct={used != null && limitMb != null ? (used / 2 ** 20 / limitMb) * 100 : null}
        />
        <StatCard
          label="Disk"
          value={fact(details?.disk_free_gb, gb => `${gb} GB`)}
          unit={details?.disk_free_gb != null ? 'free' : undefined}
          sub={details?.disk_total_gb != null && `of ${details.disk_total_gb} GB`}
        />
        <StatCard
          label="Network"
          value={!details ? '…' : details.ip_address ? 'On' : 'Off'}
          sub={details && (details.ip_address ?? 'No internet or local network')}
        />
        <StatCard
          label="Windows build"
          value={fact(details?.windows_build, String)}
          sub="Inside the sandbox"
        />
      </StatRow>
      <div className="sandbox-running-foot">
        <span className="ident" title="Sandbox ID">{id}</span>
        {alsoShared.length > 0 && <span className="sandbox-help">Also shared:</span>}
        {alsoShared.map(item => <Tag key={item}>{item}</Tag>)}
      </div>
    </div>
  )
}

export default function SandboxView() {
  const starting = useAppStore(s => s.sandboxStarting)
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const loading = useRef(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [switches, setSwitches] = useState(ALL_OFF)
  const [memoryGb, setMemoryGb] = useState<number | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [writable, setWritable] = useState(false)
  const [stopTarget, setStopTarget] = useState<string | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const [replaceRunning, setReplaceRunning] = useState(false)
  const [openedFile, setOpenedFile] = useState<string | null>(null)

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

  useEffect(() => {
    const { setSandboxDetails } = useAppStore.getState()
    for (const id of status?.running ?? []) {
      if (detailsAsked.has(id)) continue
      detailsAsked.add(id)
      api.sandboxDetails(id).then(details => setSandboxDetails(id, details)).catch(setActionError)
    }
  }, [status])

  const refresh = () => {
    detailsAsked.clear()
    return load()
  }

  // Permission to change a folder must not carry over to a different folder.
  const chooseFolder = async () => {
    const picked = await pickDirectory()
    if (picked) {
      setFolder(picked)
      setWritable(false)
    }
  }

  const openWindow = async (id: string) => {
    setActionError(null)
    try {
      await api.sandboxOpenWindow(id)
      window.setTimeout(load, WINDOW_APPEARS_MS)
    } catch (e) {
      setActionError(e)
    }
  }

  const start = async (openFile: string | null = null) => {
    const { setSandboxStarting, setSandboxShared, addActivity } = useAppStore.getState()
    const on = SWITCHES.filter(s => switches[s.key])
    const sharing = folder ? `${writable ? 'Can change' : 'Read-only'}: ${folder}` : 'No shared folder'
    const memory = memoryGb ? `${memoryGb} GB` : 'Windows default'
    const detail = `${openFile ? `Opened: ${openFile}. ` : ''}Shared: ${on.map(s => s.label).join(', ') || 'nothing'}. ${sharing}. Memory: ${memory}`
    setActionError(null)
    setOpenedFile(null)
    setSandboxStarting(true)
    try {
      const id = await api.sandboxStart({ ...switches, folder, writable, memory_mb: memoryGb && memoryGb * 1024, open_file: openFile })
      // Network and graphics are read from the sandbox itself, the others can only be remembered.
      setSandboxShared(id, [
        ...on.filter(s => s.key !== 'networking' && s.key !== 'graphics').map(s => s.label),
        ...(folder ? [`${folder} (${writable ? 'can change' : 'read-only'})`] : []),
      ])
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

  const stopLogged = async (id: string) => {
    const { addActivity } = useAppStore.getState()
    try {
      await api.sandboxStop(id)
      addActivity({ module: 'system', action: 'Stop sandbox', outcome: 'success', detail: id })
      return true
    } catch (e) {
      setActionError(e)
      addActivity({ module: 'system', action: 'Stop sandbox', outcome: 'failure', detail: `${id}: ${String(e)}` })
      return false
    }
  }

  const openInRunning = async (id: string, file: string) => {
    const { addActivity } = useAppStore.getState()
    try {
      await api.sandboxOpenFile(id, file)
      setOpenedFile(file)
      addActivity({ module: 'system', action: 'Open file in sandbox', outcome: 'success', detail: `${file} in ${id}` })
    } catch (e) {
      setActionError(e)
      addActivity({ module: 'system', action: 'Open file in sandbox', outcome: 'failure', detail: `${file} in ${id}: ${String(e)}` })
    }
  }

  const openFile = async (file: string) => {
    const { setSandboxStarting } = useAppStore.getState()
    setActionError(null)
    setOpenedFile(null)
    setSandboxStarting(true)
    let startNew = false
    try {
      // Asked again here because the list on the page can be up to 10 seconds old.
      const { running: [current] } = await api.sandboxStatus()
      if (current && !replaceRunning) await openInRunning(current, file)
      else startNew = !current || await stopLogged(current)
    } catch (e) {
      setActionError(e)
    }
    if (startNew) return start(file)
    setSandboxStarting(false)
    load()
  }

  const chooseFile = async () => {
    const picked = await pickAnyFile()
    if (picked) openFile(picked)
  }

  const dropFile = (paths: string[]) => {
    if (paths.length === 1) openFile(paths[0])
    else setActionError('Drop one file at a time.')
  }

  const stop = async (id: string) => {
    setActionError(null)
    setOpenedFile(null)
    setStopBusy(true)
    await stopLogged(id)
    setStopBusy(false)
    setStopTarget(null)
    load()
  }

  const running = status?.running ?? []
  const dropLabel = running.length === 0
    ? 'Drop to open it in a new sandbox'
    : replaceRunning ? 'Drop to replace the running sandbox' : 'Drop to open it in the running sandbox'
  const openHelp = running.length > 0 && !replaceRunning
    ? 'A read-only copy opens in the running sandbox. Programs already inside can reach it.'
    : 'A read-only copy opens in a new sandbox with these settings. Programs start by themselves, and other files appear in a folder.'

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
          status={status?.available && (
            <span className="pill">
              <span className={clsx('rail-dot', running.length > 0 ? 'running' : 'stopped')} />
              {running.length === 0 ? 'Not running' : status.window_open ? 'Running' : 'Running, window closed'}
            </span>
          )}
          actions={<Button onClick={refresh}><RefreshCw size={12} /> Refresh</Button>}
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
          <FileDropZone className="sandbox-page" label={dropLabel} disabled={starting} onDrop={dropFile}>
            {running.map(id => (
              <RunningSandbox
                key={id}
                id={id}
                status={status}
                onOpenWindow={openWindow}
                onStop={target => { setActionError(null); setStopTarget(target) }}
              />
            ))}

            <div className="sandbox-columns">
              <Panel title="New sandbox" className="sandbox-panel">
                <div className="panel-body sandbox-panel-body">
                  <div>
                    <p className="section-label">Share with the sandbox</p>
                    <div className="sandbox-switches">
                      {SWITCHES.map(({ key, label, help }) => (
                        <label key={key} className="sandbox-option">
                          <input type="checkbox" checked={switches[key]} onChange={e => setSwitches({ ...switches, [key]: e.target.checked })} />
                          <span>
                            {label}
                            <span className="sandbox-help">{help}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="sandbox-field">
                    <span className="sandbox-field-label">Memory</span>
                    <select className="wslcfg-field-control" value={memoryGb ?? ''} onChange={e => setMemoryGb(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">4 GB (Windows default)</option>
                      {MEMORY_GB.map(gb => <option key={gb} value={gb}>{gb} GB</option>)}
                    </select>
                  </label>

                  <div className="sandbox-field">
                    <span className="sandbox-field-label">Folder</span>
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
                        Let programs change this folder
                        <span className="sandbox-help">It appears on the sandbox desktop. With this on, programs can edit or delete your real files.</span>
                      </span>
                    </label>
                  )}

                  <div className="sandbox-start">
                    <Button variant="primary" disabled={starting || running.length > 0} onClick={() => start()}>
                      {starting && running.length === 0 ? 'Starting…' : 'Start sandbox'}
                    </Button>
                    {running.length > 0 && <span className="sandbox-help">Stop the running sandbox to start another.</span>}
                  </div>
                </div>
              </Panel>

              <Panel title="Open a file" className="sandbox-panel">
                <div className="panel-body sandbox-panel-body">
                  <FileDropPrompt
                    title="Drop a file here"
                    description={openHelp}
                    actions={
                      <Button disabled={starting} onClick={chooseFile}>
                        <File size={12} /> {starting && running.length > 0 ? 'Opening…' : 'Choose a file…'}
                      </Button>
                    }
                  />
                  {openedFile && running.length > 0 && <span className="sandbox-help" role="status">Opened {openedFile.split(/[\\/]/).pop()} in the running sandbox.</span>}
                  <label className="sandbox-option">
                    <input type="checkbox" checked={replaceRunning} onChange={e => setReplaceRunning(e.target.checked)} />
                    <span>
                      Open in a new sandbox
                      <span className="sandbox-help">Stops a running sandbox first and deletes everything inside.</span>
                    </span>
                  </label>
                </div>
              </Panel>
            </div>
          </FileDropZone>
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
