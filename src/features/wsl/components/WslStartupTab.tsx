import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Play, RefreshCw, Search, ShieldAlert, Settings2 } from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import type { WslDistro, ServiceList, Service, ServiceDetail } from '../types'

type Filter = 'all' | 'enabled' | 'disabled' | 'running' | 'failed'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'enabled', label: 'Enabled' },
  { key: 'disabled', label: 'Disabled' },
  { key: 'running', label: 'Running' },
  { key: 'failed', label: 'Failed' },
]

/** Services whose enabled-state can be toggled with enable/disable. static,
 *  masked, alias, generated, etc. are not user-togglable. */
const TOGGLABLE = new Set(['enabled', 'disabled'])

function activeClass(active: string): string {
  if (active === 'active') return 'wsl-svc-badge--active'
  if (active === 'failed') return 'wsl-svc-badge--failed'
  if (active === 'activating' || active === 'deactivating') return 'wsl-svc-badge--pending'
  return 'wsl-svc-badge--inactive'
}

function matchesFilter(s: Service, f: Filter): boolean {
  switch (f) {
    case 'enabled':  return s.enabled_state === 'enabled'
    case 'disabled': return s.enabled_state === 'disabled'
    case 'running':  return s.active_state === 'active'
    case 'failed':   return s.active_state === 'failed'
    default:         return true
  }
}

function ServiceRow({ distro, svc, onToggle }: {
  distro: string
  svc: Service
  onToggle: (svc: Service, enable: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<ServiceDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)

  const expand = async () => {
    const next = !open
    setOpen(next)
    if (next && !detail) {
      try {
        setDetail(await api.wslServiceDetail(distro, svc.name))
        setDetailErr(null)
      } catch (e) {
        setDetailErr(String(e))
      }
    }
  }

  const togglable = TOGGLABLE.has(svc.enabled_state)
  const enabled = svc.enabled_state === 'enabled'

  return (
    <>
      <tr className="wsl-svc-row" onClick={expand}>
        <td className="wsl-svc-expand">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </td>
        <td>
          <span className="wsl-svc-name">{svc.name.replace(/\.service$/, '')}</span>
          {svc.description && <span className="wsl-svc-desc">{svc.description}</span>}
        </td>
        <td>
          <span className={clsx('wsl-svc-badge', activeClass(svc.active_state))}>
            {svc.active_state}{svc.sub_state && svc.sub_state !== svc.active_state ? ` · ${svc.sub_state}` : ''}
          </span>
        </td>
        <td className="wsl-svc-toggle-cell" onClick={e => e.stopPropagation()}>
          {togglable ? (
            <button
              className={clsx('wsl-toggle', enabled && 'wsl-toggle--on')}
              role="switch"
              aria-checked={enabled}
              onClick={() => onToggle(svc, !enabled)}
              title={enabled ? 'Disable at boot' : 'Enable at boot'}
            >
              <span className="wsl-toggle-knob" />
            </button>
          ) : (
            <span className="wsl-svc-statelabel">{svc.enabled_state}</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="wsl-svc-detail-row">
          <td colSpan={4}>
            {detailErr ? (
              <p className="wsl-opt-error" style={{ margin: 0 }}>{detailErr}</p>
            ) : !detail ? (
              <p className="wsl-svc-detail-loading">Loading…</p>
            ) : (
              <div className="wsl-svc-detail">
                {detail.fragment_path && (
                  <div className="wsl-svc-detail-item">
                    <span className="wsl-svc-detail-key">Unit file</span>
                    <span className="wsl-svc-detail-val">{detail.fragment_path}</span>
                  </div>
                )}
                {detail.main_pid && detail.main_pid !== '0' && (
                  <div className="wsl-svc-detail-item">
                    <span className="wsl-svc-detail-key">Main PID</span>
                    <span className="wsl-svc-detail-val">{detail.main_pid}</span>
                  </div>
                )}
                {detail.requires.length > 0 && (
                  <div className="wsl-svc-detail-item">
                    <span className="wsl-svc-detail-key">Requires</span>
                    <span className="wsl-svc-detail-val">{detail.requires.join(', ')}</span>
                  </div>
                )}
                {detail.after.length > 0 && (
                  <div className="wsl-svc-detail-item">
                    <span className="wsl-svc-detail-key">After</span>
                    <span className="wsl-svc-detail-val">{detail.after.join(', ')}</span>
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

export default function WslStartupTab({ distros, onReload, onGoToConf }: {
  distros: WslDistro[]
  onReload: () => Promise<void> | void
  onGoToConf: () => void
}) {
  const addActivity = useAppStore(s => s.addActivity)
  const selected    = useAppStore(s => s.wslSelectedDistro) ?? ''
  const busyDistro  = useAppStore(s => s.wslBusyDistro)

  const [data, setData]       = useState<ServiceList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [query, setQuery]     = useState('')
  const [filter, setFilter]   = useState<Filter>('all')
  const [pending, setPending] = useState<{ svc: Service; enable: boolean } | null>(null)
  const [working, setWorking] = useState(false)

  const current = distros.find(d => d.name === selected)
  const running = current?.running ?? false

  const load = useCallback(async () => {
    if (!selected) return
    setLoading(true)
    try {
      setData(await api.wslListServices(selected))
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [selected])

  // Explicit start: boot for real and refresh the shared list so every view syncs.
  const startDistro = async () => {
    setStarting(true); setError(null)
    try {
      await api.wslStartDistro(selected)
      await onReload()
    } catch (e) {
      setError(String(e))
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => { setData(null); setError(null); setQuery(''); setFilter('all') }, [selected])
  // Load services only for a running, non-transitioning distro — the probe would
  // otherwise boot a distro that's being stopped.
  useEffect(() => { if (running && selected !== busyDistro) load() }, [running, busyDistro, selected, load])

  const confirmToggle = async () => {
    if (!pending) return
    setWorking(true)
    try {
      await api.wslServiceSet(selected, pending.svc.name, pending.enable)
      addActivity({
        module: 'wsl',
        action: `${pending.enable ? 'Enabled' : 'Disabled'} ${pending.svc.name}`,
        outcome: 'success',
        detail: selected,
      })
      setPending(null)
      await load()
    } catch (e) {
      addActivity({
        module: 'wsl',
        action: `${pending.enable ? 'Enable' : 'Disable'} ${pending.svc.name}`,
        outcome: 'failure',
        detail: String(e),
      })
      setError(String(e))
      setPending(null)
    } finally {
      setWorking(false)
    }
  }

  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.services.filter(s =>
      matchesFilter(s, filter) &&
      (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
    )
  }, [data, query, filter])

  if (distros.length === 0) {
    return <p className="empty-state" style={{ marginTop: 24 }}>No distributions found.</p>
  }

  return (
    <div className="wsl-startup">
      {!running && (
        <div className="offline-card" style={{ marginTop: 16 }}>
          <p className="offline-title">{selected} is stopped</p>
          <p className="offline-desc">Listing services needs the distro running. Start it to continue.</p>
          {error && <p className="wsl-opt-error" style={{ margin: '0 0 12px' }}>{error}</p>}
          <button className="btn-filled btn-filled--accent" onClick={startDistro} disabled={starting}>
            <Play size={13} /> {starting ? 'Starting…' : 'Start distribution'}
          </button>
        </div>
      )}

      {running && data && !data.init.is_systemd && (
        <div className="offline-card" style={{ marginTop: 16 }}>
          <p className="offline-title">systemd is not running (init: {data.init.pid1 || 'unknown'})</p>
          <p className="offline-desc">{data.init.hint}</p>
          <button className="btn-secondary" onClick={onGoToConf}>
            <Settings2 size={13} /> Open wsl.conf editor
          </button>
        </div>
      )}

      {running && error && (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <span className="error-title">Error</span>
          <span className="error-msg">{error}</span>
        </div>
      )}

      {running && data?.init.is_systemd && (
        <>
          <div className="wsl-svc-toolbar">
            <div className="wsl-svc-search">
              <Search size={13} className="wsl-svc-search-icon" />
              <input
                className="wsl-svc-search-input"
                placeholder="Search services…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="wsl-svc-filters">
              {FILTERS.map(f => (
                <button
                  key={f.key}
                  className={clsx('wsl-svc-filter', filter === f.key && 'wsl-svc-filter--active')}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button className="btn-icon" onClick={load} disabled={loading} title="Refresh" style={{ marginLeft: 'auto' }}>
              <RefreshCw size={12} className={loading ? 'spin' : ''} />
            </button>
          </div>

          <p className="wsl-svc-count">{filtered.length} of {data.services.length} services</p>

          <div className="wsl-compare-wrap">
            <table className="wsl-compare wsl-svc-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>Service</th>
                  <th style={{ width: 150 }}>Status</th>
                  <th style={{ width: 90 }}>At boot</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <ServiceRow
                    key={s.name}
                    distro={selected}
                    svc={s}
                    onToggle={(svc, enable) => setPending({ svc, enable })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {running && !data && !error && (
        <p className="empty-state" style={{ marginTop: 24 }}>Loading services…</p>
      )}

      {pending && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div className={clsx('modal-icon-wrap', !pending.enable && 'warning')}>
                <ShieldAlert size={16} />
              </div>
              <h2 className="modal-title">{pending.enable ? 'Enable' : 'Disable'} {pending.svc.name}?</h2>
            </div>
            <p className="modal-body">
              This runs <code>systemctl {pending.enable ? 'enable' : 'disable'} {pending.svc.name}</code> as
              root in <strong>{selected}</strong>, changing whether it starts at boot. It does not
              {pending.enable ? ' start' : ' stop'} the service now.
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setPending(null)} disabled={working}>Cancel</button>
              <button className="btn-filled btn-filled--accent" onClick={confirmToggle} disabled={working}>
                {working ? 'Working…' : pending.enable ? 'Enable' : 'Disable'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
