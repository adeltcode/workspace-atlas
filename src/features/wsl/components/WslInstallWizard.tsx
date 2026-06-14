import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { listen } from '@tauri-apps/api/event'
import {
  Search, Check, Download, Terminal, LayoutDashboard, RotateCw,
  ChevronRight, ChevronLeft, ShieldCheck, FolderOpen, CircleCheck, TriangleAlert,
} from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import type { WslDistro, CatalogDistro, InstallProgress } from '../types'
import { bytesToHuman } from '../../../utils/format'
import { useAsyncAction } from '../../../hooks/useAsyncAction'
import { DistroLogo } from '../DistroLogo'

type Step = 'select' | 'review' | 'install'

const STEPS: { id: Step; label: string }[] = [
  { id: 'select',  label: 'Choose distribution' },
  { id: 'review',  label: 'Review' },
  { id: 'install', label: 'Install' },
]

const PHASE_LABEL: Record<InstallProgress['phase'], string> = {
  downloading: 'Downloading',
  verifying:   'Verifying checksum',
  importing:   'Importing',
  done:        'Finishing up',
}

/** Catalog browser + guided install for a new WSL distribution. Three steps:
 *  choose → review → install. Downloads the official distro image directly so it
 *  can report real progress (speed, size, percent), verifies its SHA-256, then
 *  imports it. First-run user setup happens when the user opens a terminal. */
export default function WslInstallWizard({ distros, onReload }: {
  distros: WslDistro[]
  onReload: () => Promise<void> | void
}) {
  const addActivity     = useAppStore(s => s.addActivity)
  const setWslView      = useAppStore(s => s.setWslView)
  const setSelected     = useAppStore(s => s.setWslSelectedDistro)
  // Cross-mount install guard: the download runs in the backend and survives this
  // component unmounting, so a re-opened wizard must not start a second install.
  const wslInstalling    = useAppStore(s => s.wslInstalling)
  const setWslInstalling = useAppStore(s => s.setWslInstalling)

  const [catalog, setCatalog] = useState<CatalogDistro[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [query, setQuery]     = useState('')
  const [picked, setPicked]   = useState<string | null>(null)
  const [installDir, setInstallDir] = useState('')
  const [step, setStep]       = useState<Step>('select')
  const [installing, setInstalling] = useState(false)
  const [installErr, setInstallErr] = useState<string | null>(null)
  const [done, setDone]       = useState(false)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  // Synchronous guard so a quick double-click can't kick off two downloads.
  const installInFlight = useRef(false)
  const openTerm = useAsyncAction()

  const installedNames = useMemo(
    () => new Set(distros.map(d => d.name.toLowerCase())),
    [distros],
  )

  const loadCatalog = useCallback(() => {
    setCatalog(null); setLoadErr(null)
    api.wslInstallCatalog().then(setCatalog).catch(e => setLoadErr(String(e)))
  }, [])

  useEffect(() => { loadCatalog() }, [loadCatalog])

  // Prefill the install location with the default for the picked distro.
  useEffect(() => {
    if (!picked) { setInstallDir(''); return }
    let alive = true
    api.wslDefaultInstallDir(picked).then(d => { if (alive) setInstallDir(d) }).catch(() => {})
    return () => { alive = false }
  }, [picked])

  const pickedDistro = catalog?.find(d => d.name === picked) ?? null
  const stepIndex = STEPS.findIndex(s => s.id === step)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (catalog ?? []).filter(d =>
      !q || d.name.toLowerCase().includes(q) || d.friendly_name.toLowerCase().includes(q),
    )
  }, [catalog, query])

  const runInstall = async () => {
    if (!pickedDistro) return
    // Block a second install: the synchronous ref stops same-frame double-clicks,
    // the store flag stops a re-opened wizard from racing an in-flight download.
    if (installInFlight.current || wslInstalling) return
    installInFlight.current = true
    setWslInstalling(pickedDistro.name)
    setStep('install'); setInstalling(true); setInstallErr(null); setDone(false); setProgress(null)
    const unlisten = await listen<InstallProgress>('wsl-install-progress', e => setProgress(e.payload))
    try {
      await api.wslInstallDownload(pickedDistro.name, pickedDistro.url, pickedDistro.sha256, installDir)
      addActivity({ module: 'wsl', action: `Installed ${pickedDistro.name}`, outcome: 'success' })
      setDone(true)
      await onReload()
    } catch (e) {
      setInstallErr(String(e))
      addActivity({ module: 'wsl', action: `Install ${pickedDistro.name}`, outcome: 'failure', detail: String(e) })
    } finally {
      unlisten(); setInstalling(false); installInFlight.current = false; setWslInstalling(null)
    }
  }

  const reset = () => { setStep('select'); setPicked(null); setInstallErr(null); setDone(false); setProgress(null) }

  // ── Install-step display ────────────────────────────────────────────────────
  const phase = progress?.phase ?? 'downloading'
  const downloading = phase === 'downloading'
  const total = progress?.total ?? 0
  const pct = downloading ? Math.round(progress?.percent ?? 0) : 100
  const indeterminate = downloading && total === 0

  return (
    <div className="wsl-wizard">
      {/* ── Stepper ──────────────────────────────────────────────────── */}
      <div className="wiz-steps">
        {STEPS.map((s, i) => (
          <Fragment key={s.id}>
            <div className={clsx('wiz-step', i === stepIndex && 'wiz-step--active', i < stepIndex && 'wiz-step--done')}>
              <span className="wiz-step-num">{i < stepIndex ? <Check size={13} /> : i + 1}</span>
              <span className="wiz-step-label">{s.label}</span>
            </div>
            {i < STEPS.length - 1 && <span className={clsx('wiz-step-line', i < stepIndex && 'wiz-step-line--done')} />}
          </Fragment>
        ))}
      </div>

      {/* A download started from an earlier visit is still running in the background. */}
      {wslInstalling && !installing && (
        <div className="wiz-inflight-note">
          <RotateCw size={13} className="spin" /> Installing {wslInstalling} in the background — wait for it to finish before starting another.
        </div>
      )}

      {/* ── Step 1: choose ───────────────────────────────────────────── */}
      {step === 'select' && (
        <div className="wiz-panel">
          <div className="wsl-distros-toolbar">
            <div className="wsl-distros-search">
              <Search size={14} className="wsl-distros-search-icon" />
              <input
                className="wsl-distros-search-input"
                placeholder="Search distributions…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                spellCheck={false}
              />
            </div>
            <button className="btn-refresh" onClick={loadCatalog} disabled={catalog === null && !loadErr} title="Re-fetch the catalog">
              <RotateCw size={13} className={catalog === null && !loadErr ? 'spin' : ''} /> Refresh catalog
            </button>
          </div>

          {loadErr ? (
            <div className="error-banner">
              <span className="error-title">Error</span>
              <span className="error-msg">{loadErr}</span>
            </div>
          ) : catalog === null ? (
            <div className="wiz-grid">
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} className="wiz-card wiz-card--skeleton">
                  <span className="sk-box" />
                  <span className="wiz-card-text">
                    <span className="sk-line w-24" style={{ height: 10 }} />
                    <span className="sk-line w-16" style={{ height: 8, marginTop: 6 }} />
                  </span>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="empty-state">No distributions match “{query}”.</p>
          ) : (
            <div className="wiz-grid">
              {filtered.map(d => {
                const installed = installedNames.has(d.name.toLowerCase())
                const active = picked === d.name
                return (
                  <button
                    key={d.name}
                    className={clsx('wiz-card', active && 'wiz-card--active', installed && 'wiz-card--installed')}
                    onClick={() => !installed && setPicked(d.name)}
                    disabled={installed}
                    title={installed ? `${d.name} is already installed` : `Select ${d.friendly_name}`}
                  >
                    <DistroLogo name={d.name} label={d.friendly_name} size={38} />
                    <span className="wiz-card-text">
                      <span className="wiz-card-name">{d.friendly_name}</span>
                      <span className="wiz-card-id">{d.name}</span>
                    </span>
                    {installed
                      ? <span className="wiz-card-badge">Installed</span>
                      : active && <span className="wiz-card-check"><Check size={14} /></span>}
                  </button>
                )
              })}
            </div>
          )}

          <div className="wiz-actions">
            <span className="wiz-actions-hint">
              {pickedDistro ? `Selected: ${pickedDistro.friendly_name}` : 'Select a distribution to continue.'}
            </span>
            <button className="btn-filled btn-filled--accent" disabled={!picked} onClick={() => setStep('review')}>
              Continue <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: review ───────────────────────────────────────────── */}
      {step === 'review' && pickedDistro && (
        <div className="wiz-panel">
          <div className="wiz-review">
            <DistroLogo name={pickedDistro.name} label={pickedDistro.friendly_name} size={52} />
            <div className="wiz-review-id">
              <span className="wiz-review-name">{pickedDistro.friendly_name}</span>
              <span className="wiz-review-sub">{pickedDistro.name}</span>
            </div>
          </div>

          <ul className="wiz-facts">
            <li><Download size={15} className="wiz-fact-icon" /><span>Downloaded straight from the official image, with live speed and size shown below.</span></li>
            <li><ShieldCheck size={15} className="wiz-fact-icon" /><span>Verified against the catalog’s SHA-256 checksum before anything is imported.</span></li>
            <li><Terminal size={15} className="wiz-fact-icon" /><span>Open a terminal afterward to finish first-run setup (create your Linux username and password).</span></li>
          </ul>

          <div className="wiz-location">
            <label className="wiz-location-label">Install location</label>
            <div className="wsl-import-row">
              <input className="settings-dir-input" value={installDir} readOnly placeholder="Default location…" />
              <button className="settings-dir-btn" onClick={async () => { const p = await api.pickDirectory(); if (p) setInstallDir(p) }}>
                <FolderOpen size={13} /> Browse…
              </button>
            </div>
          </div>

          <div className="wiz-actions">
            <button className="btn-secondary" onClick={() => setStep('select')}><ChevronLeft size={14} /> Back</button>
            <button className="btn-filled btn-filled--accent" onClick={runInstall} disabled={!installDir || !!wslInstalling}>
              <Download size={13} /> Install
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: install / result ─────────────────────────────────── */}
      {step === 'install' && pickedDistro && (
        <div className="wiz-panel">
          {installing && (
            <div className="wiz-install">
              <DistroLogo name={pickedDistro.name} label={pickedDistro.friendly_name} size={56} />
              <p className="wiz-status-title">{PHASE_LABEL[phase]} {pickedDistro.friendly_name}…</p>

              <div className="wiz-progress">
                <div className="wiz-progress-track">
                  <div
                    className={clsx('wiz-progress-fill', indeterminate && 'wiz-progress-fill--indet', !downloading && 'wiz-progress-fill--pulse')}
                    style={{ width: indeterminate ? undefined : `${pct}%` }}
                  />
                </div>
                <div className="wiz-progress-meta">
                  {downloading ? (
                    <>
                      <span>{bytesToHuman(progress?.downloaded ?? 0)}{total > 0 ? ` / ${bytesToHuman(total)}` : ''}</span>
                      <span className="wiz-progress-mid">{indeterminate ? 'downloading…' : `${pct}%`}</span>
                      <span>{bytesToHuman(progress?.bytes_per_sec ?? 0)}/s</span>
                    </>
                  ) : (
                    <span className="wiz-progress-mid">{PHASE_LABEL[phase]}…</span>
                  )}
                </div>
              </div>

              <p className="wiz-status-desc">Keep the app open until this finishes. Full output is in the terminal panel below.</p>
            </div>
          )}

          {!installing && done && (
            <div className="wiz-status">
              <span className="wiz-status-icon wiz-status-icon--ok"><CircleCheck size={34} /></span>
              <p className="wiz-status-title">{pickedDistro.friendly_name} installed</p>
              <p className="wiz-status-desc">
                Open a terminal to finish first-run setup, where you’ll create your Linux username and password.
              </p>
              <div className="wiz-done-actions">
                <button className="btn-filled btn-filled--accent" disabled={openTerm.pending}
                  onClick={() => openTerm.run(() => api.wslOpenTerminal(pickedDistro.name).catch(() => {}))}>
                  <Terminal size={13} /> Open terminal
                </button>
                <button className="btn-secondary" onClick={() => { setSelected(pickedDistro.name); setWslView('dashboard') }}>
                  <LayoutDashboard size={14} /> Go to dashboard
                </button>
                <button className="btn-secondary" onClick={reset}>Install another</button>
              </div>
            </div>
          )}

          {!installing && installErr && (
            <div className="wiz-status">
              <span className="wiz-status-icon wiz-status-icon--err"><TriangleAlert size={34} /></span>
              <p className="wiz-status-title">Install failed</p>
              <p className="wiz-status-desc wiz-status-desc--err">{installErr}</p>
              <div className="wiz-done-actions">
                <button className="btn-filled btn-filled--accent" onClick={runInstall}><RotateCw size={13} /> Retry</button>
                <button className="btn-secondary" onClick={() => setStep('review')}><ChevronLeft size={14} /> Back</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
