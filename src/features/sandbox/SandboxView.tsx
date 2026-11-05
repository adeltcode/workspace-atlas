import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  AlertTriangle, AppWindow, Ban, Camera, CircleCheck, Clipboard, Cpu, File, FolderOpen, Globe, Gpu, HardDrive,
  LoaderCircle, Lock, MemoryStick, Mic, Monitor, Pencil, Play, Printer, RefreshCw, Square,
} from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useVisiblePoll } from '../../hooks/useVisiblePoll'
import { Button, ConfirmDestructive, DisclosurePanel, ErrorBanner, Panel, Prerequisite, SectionHead, SheetHead, StatCard, StatRow, Tag } from '../../components/ui'
import { FileDropPrompt, FileDropZone, type DropHint } from '../../components/FileDropZone'
import { pickAnyFile } from '../holders/api'
import { pickDirectory } from '../wsl/api'
import * as api from './api'
import type { SandboxSharedItem, SandboxStatus, SandboxSwitches } from './api'

const POLL_MS = 10_000
const WINDOW_APPEARS_MS = 1_500
const MEMORY_GB = [8, 16]
const DEFAULT_MEMORY_GB = 4
const NOTHING_HOVERED = 'Nothing is shared unless you tick it.'
const WHAT_OPENS = '.exe, .msi, .bat, and .cmd files start straight away. Other files appear in a folder.'

const SWITCHES: { key: keyof SandboxSwitches; label: string; help: string; icon: React.ElementType }[] = [
  { key: 'networking', label: 'Network', help: 'Lets programs reach the internet and your local network.', icon: Globe },
  { key: 'clipboard', label: 'Clipboard', help: 'Lets you copy and paste with your PC. Programs can read what you copy.', icon: Clipboard },
  { key: 'microphone', label: 'Microphone', help: 'Lets programs listen through your microphone.', icon: Mic },
  { key: 'camera', label: 'Camera', help: 'Lets programs see through your camera.', icon: Camera },
  { key: 'printers', label: 'Printers', help: 'Lets programs print to your printers.', icon: Printer },
  { key: 'graphics', label: 'Graphics card', help: 'Programs may run faster, but the sandbox is less isolated.', icon: Gpu },
]

const ALL_OFF: SandboxSwitches = { networking: false, microphone: false, camera: false, clipboard: false, printers: false, graphics: false }

// Outside the component so leaving the page and coming back does not read everything again.
const detailsAsked = new Set<string>()

const gigabytes = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`
const lastPart = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
// Cut in the middle, so the extension still shows.
const shortName = (path: string) => {
  const name = lastPart(path)
  return name.length > 36 ? `${name.slice(0, 22)}…${name.slice(-12)}` : name
}

function ShareOptions({ switches, onChange }: {
  switches: SandboxSwitches
  onChange: (switches: SandboxSwitches) => void
}) {
  const [hovered, setHovered] = useState<keyof SandboxSwitches | null>(null)
  const [focused, setFocused] = useState<keyof SandboxSwitches | null>(null)
  const active = hovered ?? focused

  return (
    <div
      role="group"
      aria-labelledby="sandbox-share-heading"
      onMouseLeave={() => setHovered(null)}
      onKeyDown={e => { if (e.key === 'Escape') { setHovered(null); setFocused(null) } }}
    >
      <p id="sandbox-share-heading" className="sandbox-heading">Share with the sandbox</p>
      <div className="sandbox-switches">
        {SWITCHES.map(({ key, label, icon: Icon }) => (
          <label key={key} className="sandbox-option" onMouseEnter={() => setHovered(key)}>
            <input
              type="checkbox"
              checked={switches[key]}
              aria-describedby={`sandbox-help-${key}`}
              onFocus={() => setFocused(key)}
              onBlur={() => setFocused(null)}
              onChange={e => onChange({ ...switches, [key]: e.target.checked })}
            />
            <Icon size={13} aria-hidden="true" />
            {label}
          </label>
        ))}
      </div>
      <div className="sandbox-help-line">
        <span className={clsx(!active && 'is-shown')}>{NOTHING_HOVERED}</span>
        {SWITCHES.map(({ key, help }) => (
          <span key={key} id={`sandbox-help-${key}`} className={clsx(active === key && 'is-shown')}>{help}</span>
        ))}
      </div>
    </div>
  )
}

function SharedTag({ item }: { item: SandboxSharedItem }) {
  if (item.key === 'folder') {
    const Icon = item.writable ? Pencil : Lock
    return (
      <span title={item.path}>
        <Tag tone={item.writable ? 'warn' : 'neutral'}>
          <Icon size={11} aria-hidden="true" /> {item.label}, {item.writable ? 'can change' : 'read-only'}
        </Tag>
      </span>
    )
  }
  const Icon = SWITCHES.find(s => s.key === item.key)?.icon
  return <Tag>{Icon && <Icon size={11} aria-hidden="true" />} {item.label}</Tag>
}

function RunningSandbox({ id, status }: { id: string; status: SandboxStatus }) {
  const details = useAppStore(s => s.sandboxDetails[id])
  const shared = useAppStore(s => s.sandboxShared[id])

  const used = status.memory_used_bytes
  const limitMb = details?.memory_mb
  const total = details?.disk_total_gb
  const free = details?.disk_free_gb
  const items: SandboxSharedItem[] = [
    ...(shared ?? []),
    ...(details?.graphics ? [{ key: 'graphics' as const, label: 'Graphics card' }] : []),
  ]

  return (
    <div>
      <SectionHead title="Running sandbox" meta={!details && <span role="status">Reading details…</span>} />
      <StatRow>
        <StatCard
          icon={MemoryStick}
          label="Memory"
          value={used == null ? 'Unknown' : gigabytes(used)}
          unit={used == null ? undefined : limitMb != null ? `used of ${Math.round(limitMb / 1024)} GB` : 'used'}
          pct={used != null && limitMb != null ? (used / 2 ** 20 / limitMb) * 100 : undefined}
        />
        <StatCard
          icon={HardDrive}
          label="Disk"
          loading={!details}
          value={free == null ? 'Unknown' : `${free} GB`}
          unit={free != null && total != null ? `free of ${total} GB` : undefined}
          pct={free != null && total ? ((total - free) / total) * 100 : undefined}
        />
        <StatCard
          icon={Globe}
          label="Network"
          loading={!details}
          value={!details?.network_known ? 'Unknown' : details.ip_address ? 'On' : 'Off'}
          sub={details?.network_known ? details.ip_address ?? 'No internet or local network' : undefined}
        />
      </StatRow>

      <div className="sandbox-facts">
        {!shared && items.length === 0
          ? <span>Not known what else is shared. It was not started from this window.</span>
          : (
            <>
              <span>Also shared:</span>
              {items.length === 0 ? <span>Nothing else</span> : items.map(item => <SharedTag key={item.label} item={item} />)}
            </>
          )}
      </div>

      <div className="sandbox-facts">
        {details && (
          <>
            <span className="sandbox-fact">
              <Cpu size={11} aria-hidden="true" />
              {details.cpu_threads != null && `${details.cpu_threads} threads, `}
              {details.cpu_name?.replace(/\s*\((R|TM)\)/g, '') ?? 'CPU not known'}
            </span>
            <span className="sandbox-fact">
              <Monitor size={11} aria-hidden="true" />
              Windows build {details.windows_build ?? 'not known'}
            </span>
          </>
        )}
        <span className="ident" title="Sandbox ID">{id}</span>
      </div>
    </div>
  )
}

export default function SandboxView() {
  const starting = useAppStore(s => s.sandboxStarting)
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const loading = useRef(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<{ title: string; error: unknown } | null>(null)
  const [switches, setSwitches] = useState(ALL_OFF)
  const [memoryGb, setMemoryGb] = useState<number | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [writable, setWritable] = useState(false)
  const [stopTarget, setStopTarget] = useState<string | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const [replaceRunning, setReplaceRunning] = useState(false)
  const [replaceTarget, setReplaceTarget] = useState<{ id: string; file: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const fail = (title: string, error: unknown) => setActionError({ title, error })

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
  useVisiblePoll(() => { if (!loading.current) load() }, POLL_MS, !stopTarget && !replaceTarget)

  const running = status?.running ?? []
  const current = running[0]

  useEffect(() => {
    const { setSandboxDetails } = useAppStore.getState()
    for (const id of status?.running ?? []) {
      if (detailsAsked.has(id)) continue
      detailsAsked.add(id)
      api.sandboxDetails(id).then(details => setSandboxDetails(id, details)).catch(e => fail('Could not read the sandbox details', e))
    }
  }, [status])

  useEffect(() => {
    if (!current) setNotice(null)
  }, [current])

  const refresh = async () => {
    setActionError(null)
    detailsAsked.clear()
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  // Permission to change a folder must not carry over to a different folder.
  const shareFolder = (path: string | null) => {
    setFolder(path)
    setWritable(false)
  }

  const chooseFolder = async () => {
    const picked = await pickDirectory()
    if (picked) {
      shareFolder(picked)
      setNotice(null)
    }
  }

  const openWindow = async (id: string) => {
    setActionError(null)
    try {
      await api.sandboxOpenWindow(id)
      window.setTimeout(load, WINDOW_APPEARS_MS)
    } catch (e) {
      fail('Could not open the sandbox window', e)
    }
  }

  const start = async (openFile: string | null = null) => {
    const { setSandboxStarting, setSandboxShared, addActivity } = useAppStore.getState()
    const on = SWITCHES.filter(s => switches[s.key])
    const sharing = folder ? `${writable ? 'Can change' : 'Read-only'}: ${folder}` : 'No shared folder'
    const memory = memoryGb ? `${memoryGb} GB` : 'Windows default'
    const detail = `${openFile ? `Opened: ${openFile}. ` : ''}Shared: ${on.map(s => s.label).join(', ') || 'nothing'}. ${sharing}. Memory: ${memory}`
    setActionError(null)
    setNotice(null)
    setSandboxStarting(true)
    try {
      const id = await api.sandboxStart({ ...switches, folder, writable, memory_mb: memoryGb && memoryGb * 1024, open_file: openFile })
      // Network and graphics are read from the sandbox itself, the others can only be remembered.
      setSandboxShared(id, [
        ...on.filter(s => s.key !== 'networking' && s.key !== 'graphics').map(s => ({ key: s.key, label: s.label })),
        ...(folder ? [{ key: 'folder' as const, label: lastPart(folder), path: folder, writable }] : []),
      ])
      addActivity({ module: 'system', action: 'Start sandbox', outcome: 'success', detail })
      await openWindow(id)
    } catch (e) {
      fail('Could not start the sandbox', e)
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
      fail('Could not stop the sandbox', e)
      addActivity({ module: 'system', action: 'Stop sandbox', outcome: 'failure', detail: `${id}: ${String(e)}` })
      return false
    }
  }

  const openInRunning = async (id: string, file: string) => {
    const { addActivity } = useAppStore.getState()
    try {
      await api.sandboxOpenFile(id, file)
      setNotice(`Sent ${shortName(file)} to the sandbox`)
      addActivity({ module: 'system', action: 'Open file in sandbox', outcome: 'success', detail: `${file} in ${id}` })
    } catch (e) {
      fail('Could not open the file in the sandbox', e)
      addActivity({ module: 'system', action: 'Open file in sandbox', outcome: 'failure', detail: `${file} in ${id}: ${String(e)}` })
    }
  }

  const openFile = async (file: string) => {
    const { setSandboxStarting } = useAppStore.getState()
    setActionError(null)
    setNotice(null)
    setSandboxStarting(true)
    let startNew = false
    try {
      // Asked again here because the list on the page can be up to 10 seconds old.
      const { running: [latest] } = await api.sandboxStatus()
      if (!latest) startNew = true
      else if (replaceRunning) setReplaceTarget({ id: latest, file })
      else await openInRunning(latest, file)
    } catch (e) {
      fail('Could not check Windows Sandbox', e)
    }
    if (startNew) return start(file)
    setSandboxStarting(false)
    load()
  }

  const confirmReplace = async ({ id, file }: { id: string; file: string }) => {
    setStopBusy(true)
    const stopped = await stopLogged(id)
    setStopBusy(false)
    setReplaceTarget(null)
    await load()
    if (stopped) await start(file)
  }

  const chooseFile = async () => {
    const picked = await pickAnyFile()
    if (picked) openFile(picked)
  }

  const kindsOf = (paths: string[]) => api.sandboxPathKinds(paths).catch(() => paths.map(() => 'file' as const))

  const describeDrop = async (paths: string[]): Promise<DropHint> => {
    if (starting) return { icon: LoaderCircle, tone: 'blocked', title: 'The sandbox is busy', note: 'Nothing happens if you drop now.' }
    if (paths.length !== 1) return { icon: Ban, tone: 'blocked', title: 'Drop one item at a time', note: `${paths.length} items are selected. Nothing happens if you drop them.` }

    const name = shortName(paths[0])
    const [kind] = await kindsOf(paths)
    if (kind === 'missing') return { icon: Ban, tone: 'blocked', title: `Cannot find ${name}`, note: 'Nothing happens if you drop it.' }
    if (kind === 'folder') {
      return current
        ? { icon: FolderOpen, title: `Share ${name} with the next sandbox`, note: 'Read-only. The running sandbox does not get it.' }
        : { icon: FolderOpen, title: `Share ${name} with the new sandbox`, note: 'Read-only. Programs can read every file in it. Nothing starts yet.' }
    }

    const how = kind === 'program' ? 'A read-only copy. It starts straight away.' : 'A read-only copy. It appears in a folder.'
    if (current && replaceRunning) return { icon: AlertTriangle, tone: 'danger', title: `Stop this sandbox and open ${name} in a new one`, note: 'You confirm first. Everything inside is deleted.' }
    if (current) return { icon: AppWindow, title: `Open ${name} in the running sandbox`, note: how }
    if (folder && writable) return { icon: AlertTriangle, tone: 'danger', title: `Start a sandbox and open ${name}`, note: `Programs can change your real files in ${shortName(folder)}.` }
    return { icon: Play, title: `Start a sandbox and open ${name}`, note: how }
  }

  // Blocked drops do nothing here, because the text beside the cursor already said so.
  const dropItems = async (paths: string[]) => {
    if (useAppStore.getState().sandboxStarting || paths.length !== 1) return
    const [kind] = await kindsOf(paths)
    if (kind === 'missing') return
    if (kind === 'folder') {
      shareFolder(paths[0])
      setNotice(`${shortName(paths[0])} will be shared with the next sandbox`)
      return
    }
    openFile(paths[0])
  }

  const stop = async (id: string) => {
    setActionError(null)
    setNotice(null)
    setStopBusy(true)
    await stopLogged(id)
    setStopBusy(false)
    setStopTarget(null)
    load()
  }

  const opensInNew = !current || replaceRunning
  const openHelp = !current
    ? `A read-only copy opens in a new sandbox with the settings on this page. ${WHAT_OPENS}`
    : replaceRunning
      ? `A read-only copy opens in a new sandbox with the settings on this page, after you confirm. ${WHAT_OPENS}`
      : `A read-only copy opens in the running sandbox. Programs already inside can read it. ${WHAT_OPENS}`

  const on = SWITCHES.filter(s => switches[s.key]).map(s => s.label)
  const sharedNames = [...on, ...(folder ? [shortName(folder)] : [])]
  const nextSandbox = `Settings for the next sandbox. ${sharedNames.length > 0 ? `Shared: ${sharedNames.join(', ')}` : 'Nothing shared'}, ${memoryGb ?? DEFAULT_MEMORY_GB} GB`

  const pill = loadError != null ? { dot: 'stopped', text: 'Not known' }
    : starting && !current ? { dot: 'partial', text: 'Starting…' }
    : stopBusy ? { dot: 'partial', text: 'Stopping…' }
    : !current ? { dot: 'stopped', text: 'Not running' }
    : status?.window_open ? { dot: 'running', text: 'Running' }
    : { dot: 'running', text: 'Running, window closed' }

  const headActions = status?.available === false ? undefined : (
    <>
      {status?.available && !current && (
        <Button variant="primary" disabled={starting} onClick={() => start()}>
          {starting ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
          {' '}{starting ? 'Starting…' : 'Start sandbox'}
        </Button>
      )}
      {current && !status?.window_open && (
        <Button variant="primary" disabled={starting} onClick={() => openWindow(current)}>
          <AppWindow size={12} aria-hidden="true" /> Open window
        </Button>
      )}
      {current && (
        <Button variant="danger-outline" disabled={starting} onClick={() => { setActionError(null); setStopTarget(current) }}>
          <Square size={12} aria-hidden="true" /> Stop sandbox
        </Button>
      )}
      <Button disabled={refreshing} onClick={refresh}>
        <RefreshCw size={12} className={clsx(refreshing && 'spin')} aria-hidden="true" /> Refresh
      </Button>
    </>
  )

  const settings = (
    <fieldset className="sandbox-settings" disabled={starting}>
      <ShareOptions switches={switches} onChange={setSwitches} />

      <label className="sandbox-field">
        <span className="sandbox-heading">Memory</span>
        <span className="sandbox-field-control">
          <select className="select" value={memoryGb ?? ''} onChange={e => setMemoryGb(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{DEFAULT_MEMORY_GB} GB (Windows default)</option>
            {MEMORY_GB.map(gb => <option key={gb} value={gb}>{gb} GB</option>)}
          </select>
        </span>
      </label>

      <div className="sandbox-field">
        <span className="sandbox-heading">Folder</span>
        <div className="sandbox-field-control">
          <Button onClick={chooseFolder}><FolderOpen size={12} aria-hidden="true" /> {folder ? 'Change folder' : 'Share a folder'}</Button>
          {folder && (
            <>
              <div className="sandbox-folder-path">
                <span className="ident sandbox-path" title={folder}>{folder}</span>
                <Button size="sm" variant="ghost" aria-label="Remove shared folder" onClick={() => { shareFolder(null); setNotice(null) }}>Remove</Button>
              </div>
              <span className="sandbox-help">It appears on the sandbox desktop. Programs can read every file in it.</span>
              <label className="sandbox-check">
                <input type="checkbox" checked={writable} aria-describedby="sandbox-writable-help" onChange={e => setWritable(e.target.checked)} />
                <span>
                  Let programs change this folder
                  <span id="sandbox-writable-help" className="sandbox-help">Programs can edit or delete your real files in this folder.</span>
                </span>
              </label>
            </>
          )}
        </div>
      </div>
    </fieldset>
  )

  const openPanel = (
    <Panel
      title="Open a file"
      className="sandbox-panel"
      actions={
        <span role="status">
          {notice && <Tag tone="ok"><CircleCheck size={11} aria-hidden="true" /> {notice}</Tag>}
        </span>
      }
    >
      <div className="panel-body sandbox-panel-body">
        <FileDropPrompt
          row={!!current}
          title="Drop a file anywhere on this page"
          description={openHelp}
          actions={
            <Button disabled={starting} onClick={chooseFile}>
              {starting ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <File size={12} aria-hidden="true" />}
              {' '}{starting ? 'Opening…' : 'Choose file…'}
            </Button>
          }
        />
        {opensInNew && folder && writable && (
          <Tag tone="warn" className="sandbox-warning">
            <Pencil size={11} aria-hidden="true" /> Programs can change your real files in {shortName(folder)}
          </Tag>
        )}
        <label className="sandbox-check">
          <input type="checkbox" checked={replaceRunning} aria-describedby="sandbox-replace-help" onChange={e => setReplaceRunning(e.target.checked)} />
          <span>
            Open in a new sandbox
            <span id="sandbox-replace-help" className="sandbox-help">Stops a running sandbox first and deletes everything inside. You confirm first.</span>
          </span>
        </label>
      </div>
    </Panel>
  )

  return (
    <div className="view-container">
      <FileDropZone className="sandbox-drop" label={describeDrop} disabled={!status?.available || stopTarget !== null || replaceTarget !== null} onDrop={dropItems}>
        <div className="page-head">
          <SheetHead
            crumbs={[
              { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
              { label: 'Windows Sandbox' },
            ]}
            title="Windows Sandbox"
            subtitle="A clean, throwaway copy of Windows for trying programs. Everything inside is deleted when it stops."
            status={(status?.available || loadError != null) && (
              <span className="pill" role="status">
                <span className={clsx('rail-dot', pill.dot)} />
                {pill.text}
              </span>
            )}
            actions={headActions}
          />
        </div>

        <div className="page-scroll">
          {loadError != null && <ErrorBanner title="Could not check Windows Sandbox" error={loadError} />}
          {actionError != null && <ErrorBanner title={actionError.title} error={actionError.error} />}
          {status === null && loadError == null && <div className="img-loading">Checking Windows Sandbox…</div>}

          {status?.available === false && (
            <Prerequisite
              title="Windows Sandbox is not ready on this PC"
              description="This page uses the wsb command. It needs Windows Pro, Enterprise, or Education with Windows Sandbox turned on. If it is already on, update Windows, because older versions do not include wsb."
              steps={[
                'Open PowerShell as administrator and run the command below.',
                'Restart your PC.',
                'Come back here and choose Check again.',
              ]}
              command="Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All"
              actions={<Button onClick={load}>Check again</Button>}
            />
          )}

          {status?.available && (
            <div className="sandbox-page">
              {running.map(id => <RunningSandbox key={id} id={id} status={status} />)}

              {current ? (
                <>
                  {openPanel}
                  <DisclosurePanel title="New sandbox" meta={nextSandbox}>
                    <div className="panel-body sandbox-panel-body">{settings}</div>
                  </DisclosurePanel>
                </>
              ) : (
                <div className="sandbox-columns">
                  <Panel title="New sandbox" className="sandbox-panel">
                    <div className="panel-body sandbox-panel-body">{settings}</div>
                  </Panel>
                  {openPanel}
                </div>
              )}
            </div>
          )}
        </div>
      </FileDropZone>

      {stopTarget && (
        <ConfirmDestructive
          title="Stop this sandbox?"
          consequence="Windows shuts it down and deletes everything inside it, including anything you installed or saved there. Changes already made to a shared folder stay on your PC."
          command={`wsb stop --id ${stopTarget}`}
          confirmLabel="Stop sandbox"
          busyLabel="Stopping…"
          busy={stopBusy}
          onConfirm={() => stop(stopTarget)}
          onCancel={() => setStopTarget(null)}
        />
      )}

      {replaceTarget && (
        <ConfirmDestructive
          title={`Stop this sandbox and open ${shortName(replaceTarget.file)}?`}
          consequence={`Windows shuts it down and deletes everything inside it, including anything you installed or saved there. Changes already made to a shared folder stay on your PC. Then ${shortName(replaceTarget.file)} opens in a new sandbox.`}
          command={`wsb stop --id ${replaceTarget.id}`}
          confirmLabel="Stop and open"
          busyLabel="Stopping…"
          busy={stopBusy}
          onConfirm={() => confirmReplace(replaceTarget)}
          onCancel={() => setReplaceTarget(null)}
        />
      )}
    </div>
  )
}
