import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  LayoutDashboard, ListChecks, Gauge, FileCog, Star, Terminal, FolderOpen,
  Download, Copy, ArrowRightLeft, Zap, ShieldAlert, SlidersHorizontal, ChevronDown, Trash2,
} from 'lucide-react'
import { useAppStore, type WslDistroTab } from '../../../store/appStore'
import * as api from '../api'
import type { WslDistro, DistroExtras } from '../types'
import { bytesToHuman } from '../../../utils/format'
import { Modal, Field } from './Dialog'
import { DistroLogo } from '../DistroLogo'
import { useAsyncAction } from '../../../hooks/useAsyncAction'
import { TabList, Tab } from '../../../components/ui'
import WslDashboardTab from './WslDashboardTab'
import WslStartupTab from './WslStartupTab'
import WslPerformanceTab from './WslPerformanceTab'
import WslConfTab from './WslConfTab'

const TABS: { id: WslDistroTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview',    label: 'Overview',    icon: LayoutDashboard },
  { id: 'startup',     label: 'Startup',     icon: ListChecks },
  { id: 'performance', label: 'Performance', icon: Gauge },
  { id: 'config',      label: 'Config',      icon: FileCog },
]

type PageStatus = { kind: 'ok' | 'err' | 'progress'; text: string } | null

/** Per-distribution page: identity strip with the management actions, plus
 *  Overview/Startup/Performance/Config tabs. The distro shown is the global
 *  selection (header dropdown / sidebar). */
export default function WslDistroPage({ distros, onReload }: {
  distros: WslDistro[]
  onReload: () => void
}) {
  const selected    = useAppStore(s => s.wslSelectedDistro) ?? ''
  const tab         = useAppStore(s => s.wslDistroTab)
  const setTab      = useAppStore(s => s.setWslDistroTab)
  const addActivity = useAppStore(s => s.addActivity)
  const busyDistro  = useAppStore(s => s.wslBusyDistro)

  const d = distros.find(x => x.name === selected)

  // ── Management state (export / optimize / clone / migrate / delete) ───────
  const [extras, setExtras]   = useState<DistroExtras | null>(null)
  const [busyOp, setBusyOp]   = useState<'export' | 'optimize' | 'clone' | 'migrate' | 'delete' | null>(null)
  const [status, setStatus]   = useState<PageStatus>(null)
  const [confirmOpt, setConfirmOpt] = useState(false)
  const [showClone, setShowClone]   = useState(false)
  const [cloneName, setCloneName]   = useState('')
  const [cloneDir, setCloneDir]     = useState('')
  const [cloneErr, setCloneErr]     = useState<string | null>(null)
  const [showMigrate, setShowMigrate] = useState(false)
  const [migrateDir, setMigrateDir]   = useState('')
  const [migrateErr, setMigrateErr]   = useState<string | null>(null)
  const [showDelete, setShowDelete]     = useState(false)
  const [deleteText, setDeleteText]     = useState('')
  const [deleteErr, setDeleteErr]       = useState<string | null>(null)
  // Shared re-entry guard for the management ops (export/optimize/clone/migrate),
  // and per-button guards for the fire-and-forget terminal/file launches.
  const op    = useAsyncAction()
  const term  = useAsyncAction()
  const files = useAsyncAction()
  // "Manage" dropdown holding the heavier image ops (export/clone/migrate/optimize).
  const [manageOpen, setManageOpen] = useState(false)
  const manageRef = useRef<HTMLDivElement>(null)

  // Reset management state when switching distros.
  useEffect(() => {
    setExtras(null); setStatus(null)
    setConfirmOpt(false); setShowClone(false); setShowMigrate(false); setManageOpen(false)
    setShowDelete(false); setDeleteText(''); setDeleteErr(null)
  }, [selected])

  // Close the Manage menu on outside-click / Escape.
  useEffect(() => {
    if (!manageOpen) return
    const onDown = (e: MouseEvent) => { if (manageRef.current && !manageRef.current.contains(e.target as Node)) setManageOpen(false) }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setManageOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [manageOpen])

  // Disk usage for the optimize dry-run estimate (only read while running, so a
  // stopped distro is never booted just by opening its page). Skip the distro
  // mid-action so the probe can't reboot one that's being stopped.
  useEffect(() => {
    if (!d?.running || d.name === busyDistro) return
    let alive = true
    api.wslDistroExtras(d.name).then(x => { if (alive) setExtras(x) }).catch(() => {})
    return () => { alive = false }
  }, [d?.name, d?.running, busyDistro])

  if (!d) {
    return <p className="empty-state" style={{ marginTop: 8 }}>Select a distribution from the sidebar.</p>
  }

  const openTerminal = () => {
    addActivity({ module: 'wsl', action: `Opened terminal · ${d.name}`, outcome: 'info' })
    return api.wslOpenTerminal(d.name).catch(() => {})
  }

  const runExport = () => op.run(async () => {
    setBusyOp('export'); setStatus(null)
    try {
      const r = await api.wslExportDistro(d.name)
      if (r) {
        setStatus({ kind: 'ok', text: `Exported to ${r.path} (${bytesToHuman(r.size_bytes)})` })
        addActivity({ module: 'wsl', action: `Exported ${d.name}`, outcome: 'success', detail: bytesToHuman(r.size_bytes) })
      }
    } catch (e) {
      setStatus({ kind: 'err', text: String(e) })
      addActivity({ module: 'wsl', action: `Exported ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyOp(null) }
  })

  const runOptimize = () => op.run(async () => {
    setConfirmOpt(false); setBusyOp('optimize')
    setStatus({ kind: 'progress', text: 'Approve the UAC prompt to compact the disk…' })
    try {
      const r = await api.wslOptimizeVhd(d.vhd_path)
      setStatus({
        kind: 'ok',
        text: `Reclaimed ${bytesToHuman(r.reclaimed_bytes)} (${bytesToHuman(r.before_bytes)} → ${bytesToHuman(r.after_bytes)} · ${r.method})`,
      })
      addActivity({ module: 'wsl', action: `Optimized ${d.name}`, outcome: 'success', detail: `reclaimed ${bytesToHuman(r.reclaimed_bytes)}` })
      onReload()
    } catch (e) {
      setStatus({ kind: 'err', text: String(e) })
      addActivity({ module: 'wsl', action: `Optimized ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyOp(null) }
  })

  const runClone = () => op.run(async () => {
    const name = cloneName.trim()
    if (!name || !cloneDir) return
    setBusyOp('clone'); setCloneErr(null)
    try {
      await api.wslCloneDistro(d.name, name, cloneDir, d.version)
      addActivity({ module: 'wsl', action: `Cloned ${d.name} → ${name}`, outcome: 'success' })
      setShowClone(false); setCloneName(''); setCloneDir('')
      setStatus({ kind: 'ok', text: `Cloned as ${name}` })
      onReload()
    } catch (e) {
      setCloneErr(String(e))
      addActivity({ module: 'wsl', action: `Cloned ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyOp(null) }
  })

  const runMigrate = () => op.run(async () => {
    if (!migrateDir) return
    setBusyOp('migrate'); setMigrateErr(null)
    try {
      const r = await api.wslMigrateDistro(d.name, migrateDir, d.is_default, d.base_path, d.version)
      setShowMigrate(false); setMigrateDir('')
      setStatus({ kind: 'ok', text: `Migrated. Backup kept at ${r.backup_tar}` })
      addActivity({ module: 'wsl', action: `Migrated ${d.name}`, outcome: 'success', detail: migrateDir })
      onReload()
    } catch (e) {
      setMigrateErr(String(e))
      addActivity({ module: 'wsl', action: `Migrated ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyOp(null) }
  })

  // The typed name must match exactly (trailing whitespace from a paste aside).
  // The backend re-checks it, so this only decides when the button lights up.
  const deleteArmed = deleteText.trim() === d.name

  const runDelete = () => op.run(async () => {
    if (!deleteArmed) return
    setBusyOp('delete'); setDeleteErr(null)
    try {
      await api.wslUnregisterDistro(d.name, deleteText.trim())
      addActivity({ module: 'wsl', action: `Deleted ${d.name}`, outcome: 'success', detail: `unregistered · ${bytesToHuman(d.vhd_size_bytes)} freed` })
      setShowDelete(false); setDeleteText('')
      // The page we're on no longer has a distro behind it, so leave for the
      // dashboard before the reload drops it from the list.
      useAppStore.getState().setWslView('dashboard')
      onReload()
    } catch (e) {
      setDeleteErr(String(e))
      addActivity({ module: 'wsl', action: `Deleted ${d.name}`, outcome: 'failure', detail: String(e) })
    } finally { setBusyOp(null) }
  })

  const busy = busyOp !== null

  return (
    <div className="wsl-distro-page">
      {/* The page header above already names this distro and states whether it
          is running, so this row is the logo and the actions, not a second
          copy of the identity. */}
      <div className="wsl-identity">
        <DistroLogo name={d.name} size={24} dimmed={!d.running} />
        {d.is_default && <Star size={11} className="wsl-distro-star" />}
        <div className="wsl-identity-actions">
          {/* Quick actions - the daily-use buttons stay inline. */}
          <button className="btn-secondary wsl-bcard-primary" onClick={() => term.run(openTerminal)} disabled={term.pending} title="Open a terminal in this distro">
            <Terminal size={13} /> Terminal
          </button>
          <button className="btn-secondary" onClick={() => files.run(() => api.wslOpenDistroFolder(d.name).catch(() => {}))} disabled={files.pending} title="Open the distro's files in Explorer (\\wsl.localhost)">
            <FolderOpen size={13} /> Files
          </button>

          {/* Manage - the heavier, less-frequent image ops, grouped to keep the
              strip uncluttered and the actions logically organized. */}
          <div className="wsl-menu" ref={manageRef}>
            <button
              className="btn-secondary"
              onClick={() => setManageOpen(o => !o)}
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={manageOpen}
              title="Export, clone, migrate, or optimize this distro"
            >
              <SlidersHorizontal size={13} /> {busy ? 'Working…' : 'Manage'}
              <ChevronDown size={13} className={clsx('wsl-menu-caret', manageOpen && 'wsl-menu-caret--open')} />
            </button>
            {manageOpen && (
              <div className="wsl-menu-panel" role="menu">
                <button className="wsl-menu-item" role="menuitem" onClick={() => { setManageOpen(false); runExport() }}>
                  <Download size={14} /> Export to .tar
                </button>
                <button className="wsl-menu-item" role="menuitem" onClick={() => { setManageOpen(false); setCloneErr(null); setCloneName(`${d.name}-clone`); setCloneDir(''); setShowClone(true) }}>
                  <Copy size={14} /> Clone…
                </button>
                <button className="wsl-menu-item" role="menuitem" onClick={() => { setManageOpen(false); setMigrateErr(null); setMigrateDir(''); setShowMigrate(true) }}>
                  <ArrowRightLeft size={14} /> Migrate to another drive…
                </button>
                {d.version === 2 && d.vhd_path && (
                  <button className="wsl-menu-item" role="menuitem" onClick={() => { setManageOpen(false); setConfirmOpt(true) }}>
                    <Zap size={14} /> Optimize disk
                    <ShieldAlert size={12} className="btn-admin-badge wsl-menu-badge" />
                  </button>
                )}
                {/* Destructive, so it sits below a divider at the end of the
                    menu rather than next to the reversible operations. */}
                <div className="wsl-menu-sep" role="separator" />
                <button
                  className="wsl-menu-item wsl-menu-item--danger"
                  role="menuitem"
                  onClick={() => { setManageOpen(false); setDeleteErr(null); setDeleteText(''); setShowDelete(true) }}
                >
                  <Trash2 size={14} /> Delete distro…
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* An operation here can run for minutes with no other visible sign, so the
          line that reports it is a live region. */}
      {status && (
        <p
          className={status.kind === 'err' ? 'wsl-opt-error' : status.kind === 'progress' ? 'wsl-opt-progress' : 'wsl-opt-result'}
          style={{ margin: '0 0 14px' }}
          role={status.kind === 'err' ? 'alert' : 'status'}
        >
          {status.text}
        </p>
      )}

      <TabList label={`${d.name} sections`} className="wsl-page-tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <Tab
            key={id}
            active={tab === id}
            panelId="wsl-distro-panel"
            className={clsx('wsl-page-tab', tab === id && 'wsl-page-tab--active')}
            onClick={() => setTab(id)}
          >
            <Icon size={13} /> {label}
          </Tab>
        ))}
      </TabList>

      <div id="wsl-distro-panel" role="tabpanel" aria-label={TABS.find(t => t.id === tab)?.label}>
        {tab === 'overview'    && <WslDashboardTab distros={distros} onReload={onReload} />}
        {tab === 'startup'     && <WslStartupTab distros={distros} onReload={onReload} onGoToConf={() => setTab('config')} />}
        {tab === 'performance' && <WslPerformanceTab distros={distros} onReload={onReload} />}
        {tab === 'config'      && (
          <WslConfTab
            distros={distros}
            runningNames={distros.filter(x => x.running).map(x => x.name)}
            onAfterShutdown={onReload}
          />
        )}
      </div>

      {/* ── Management dialogs ───────────────────────────────────────── */}
      {confirmOpt && (
        <Modal icon={<ShieldAlert size={16} />} iconWarning title={`Optimize ${d.name}?`} onClose={() => setConfirmOpt(false)}>
          <p className="modal-body">
            This compacts <code>ext4.vhdx</code> to reclaim unused space. It shuts down
            <strong> all WSL distributions</strong> and requires <strong>administrator approval</strong>.
          </p>
          {extras && extras.disk_used_bytes > 0 ? (
            <div className="wsl-estimate">
              <div className="wsl-estimate-row"><span>VHD file on Windows</span><strong>{bytesToHuman(d.vhd_size_bytes)}</strong></div>
              <div className="wsl-estimate-row"><span>Actually used inside</span><strong>{bytesToHuman(extras.disk_used_bytes)}</strong></div>
              <div className="wsl-estimate-row wsl-estimate-row--accent"><span>Estimated reclaimable</span><strong>≈ {bytesToHuman(Math.max(0, d.vhd_size_bytes - extras.disk_used_bytes))}</strong></div>
            </div>
          ) : (
            <p className="wsl-estimate-note">Reclaim estimate unavailable: usage is scanned while the distro is running.</p>
          )}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setConfirmOpt(false)}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={runOptimize}><Zap size={13} /> Optimize</button>
          </div>
        </Modal>
      )}

      {showClone && (
        <Modal icon={<Copy size={16} />} title={`Clone ${d.name}`} onClose={() => setShowClone(false)}>
          <p className="modal-body">Export <strong>{d.name}</strong> and re-import it as an independent copy. The source distro is left unchanged.</p>
          <Field label="New distro name">
            <input className="settings-dir-input" aria-label="New distro name" value={cloneName} onChange={e => setCloneName(e.target.value)} placeholder={`e.g. ${d.name}-clone`} spellCheck={false} />
          </Field>
          <Field label="Install location">
            <div className="wsl-import-row">
              <input className="settings-dir-input" aria-label="Install location" value={cloneDir} readOnly placeholder="Choose a folder…" />
              <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setCloneDir(p) }}>Browse…</button>
            </div>
          </Field>
          {cloneErr && <div className="settings-status settings-status--error" role="alert">{cloneErr}</div>}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setShowClone(false)} disabled={busyOp === 'clone'}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={runClone} disabled={busyOp === 'clone' || !cloneName.trim() || !cloneDir}>
              <Copy size={13} /> {busyOp === 'clone' ? 'Cloning…' : 'Clone'}
            </button>
          </div>
        </Modal>
      )}

      {showMigrate && (
        <Modal icon={<ArrowRightLeft size={16} />} iconWarning title={`Migrate ${d.name}`} onClose={() => setShowMigrate(false)}>
          <p className="modal-body">
            Move <strong>{d.name}</strong> to another drive or folder. The flow is safe: it exports a
            <code> .tar</code> backup, imports + boot-verifies the copy at the new location, and only then unregisters
            the original. The <strong>backup is kept</strong> as a rollback artifact.
          </p>
          <Field label="Destination folder">
            <div className="wsl-import-row">
              <input className="settings-dir-input" aria-label="Destination folder" value={migrateDir} readOnly placeholder="Choose a folder on the target drive…" />
              <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setMigrateDir(p) }}>Browse…</button>
            </div>
          </Field>
          {migrateErr && <div className="settings-status settings-status--error" role="alert">{migrateErr}</div>}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setShowMigrate(false)} disabled={busyOp === 'migrate'}>Cancel</button>
            <button className="btn-filled btn-filled--accent" onClick={runMigrate} disabled={busyOp === 'migrate' || !migrateDir}>
              <ArrowRightLeft size={13} /> {busyOp === 'migrate' ? 'Migrating…' : 'Migrate'}
            </button>
          </div>
        </Modal>
      )}

      {/* Delete is the one action with no rollback artifact: no backup .tar, no
          recycle bin, no undo. It is gated on typing the distro name exactly,
          so it cannot be reached by muscle memory or a stray Enter. The dialog
          stays open (and undismissable) while the unregister runs. */}
      {showDelete && (
        <Modal
          icon={<Trash2 size={16} />}
          iconDanger
          title={`Delete ${d.name}?`}
          onClose={() => { setShowDelete(false); setDeleteText('') }}
          blocking={busyOp === 'delete'}
        >
          <p className="modal-body">
            This runs <code>wsl --unregister {d.name}</code>, which permanently destroys the
            distribution and <strong>every file inside it</strong>. There is no undo and no backup.
            {d.is_default && <> This is also your <strong>default distribution</strong>.</>}
          </p>
          <div className="wsl-estimate">
            <div className="wsl-estimate-row"><span>Disk freed</span><strong>{bytesToHuman(d.vhd_size_bytes)}</strong></div>
            <div className="wsl-estimate-row"><span>Install folder deleted</span><strong className="wsl-estimate-path">{d.base_path}</strong></div>
          </div>
          <p className="wsl-estimate-note">
            Keeping a copy? Cancel and run <strong>Manage → Export to .tar</strong> first.
          </p>
          <label className="wsl-import-label" htmlFor="wsl-delete-confirm" style={{ marginTop: 12 }}>
            Type <strong>{d.name}</strong> to confirm
          </label>
          <input
            id="wsl-delete-confirm"
            className="modal-input"
            type="text"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={d.name}
            value={deleteText}
            onChange={e => setDeleteText(e.target.value)}
            disabled={busyOp === 'delete'}
          />
          {deleteErr && <div className="settings-status settings-status--error" role="alert">{deleteErr}</div>}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => { setShowDelete(false); setDeleteText('') }} disabled={busyOp === 'delete'}>Cancel</button>
            <button className="btn-filled btn-filled--danger" onClick={runDelete} disabled={!deleteArmed || busyOp === 'delete'}>
              <Trash2 size={13} /> {busyOp === 'delete' ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
