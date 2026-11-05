import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { listen } from '@tauri-apps/api/event'
import {
  Check, Download, Terminal, LayoutDashboard, RotateCw,
  ChevronRight, ChevronLeft, ShieldCheck, FolderOpen, CircleCheck, TriangleAlert,
} from 'lucide-react'
import { useAppStore } from '../../../store/appStore'
import * as api from '../api'
import type { WslDistro, CatalogDistro, InstallProgress } from '../types'
import { bytesToHuman } from '../../../utils/format'
import { useAsyncAction } from '../../../hooks/useAsyncAction'
import { DistroLogo } from '../DistroLogo'
import { Toolbar, SearchField, Button, ErrorBanner } from '../../../components/ui'

type Step = 'select' | 'review' | 'install'

const STEPS: { id: Step; label: string }[] = [
  { id: 'select',  label: 'Choose distro' },
  { id: 'review',  label: 'Review' },
  { id: 'install', label: 'Install' },
]

const PHASE_LABEL: Record<InstallProgress['phase'], string> = {
  downloading: 'Downloading',
  verifying:   'Verifying',
  importing:   'Importing',
  done:        'Finishing',
}

/** Downloads the official image directly so it can report real progress, then verifies its SHA-256
 *  and installs it. First-run user setup happens when the user opens a terminal. */
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
  const [firstRun, setFirstRun] = useState(false)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const install  = useAsyncAction()
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

  const runInstall = () => install.run(async () => {
    // The hook blocks same-frame double-clicks; the store flag stops a re-opened
    // wizard from racing an in-flight download.
    if (!pickedDistro || wslInstalling) return
    setWslInstalling(pickedDistro.name)
    setStep('install'); setInstalling(true); setInstallErr(null); setDone(false); setProgress(null)
    const unlisten = await listen<InstallProgress>('wsl-install-progress', e => setProgress(e.payload))
    try {
      setFirstRun(await api.wslInstallDownload(pickedDistro.name, pickedDistro.url, pickedDistro.sha256, installDir))
      addActivity({ module: 'wsl', action: `Installed ${pickedDistro.name}`, outcome: 'success' })
      setDone(true)
      await onReload()
    } catch (e) {
      setInstallErr(String(e))
      addActivity({ module: 'wsl', action: `Install ${pickedDistro.name}`, outcome: 'failure', detail: String(e) })
    } finally {
      unlisten(); setInstalling(false); setWslInstalling(null)
    }
  })

  const reset = () => { setStep('select'); setPicked(null); setInstallErr(null); setDone(false); setProgress(null) }

  const phase = progress?.phase ?? 'downloading'
  const downloading = phase === 'downloading'
  const total = progress?.total ?? 0
  const pct = downloading ? Math.round(progress?.percent ?? 0) : 100
  const indeterminate = downloading && total === 0

  return (
    <div className="wsl-wizard">
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

      {wslInstalling && !installing && (
        <div className="wiz-inflight-note">
          <RotateCw size={13} className="spin" /> Installing {wslInstalling} in the background. Wait for it to finish before starting another.
        </div>
      )}

      {step === 'select' && (
        <div className="wiz-panel">
          <Toolbar>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search distros"
              label="Search installable distros"
            />
            <div className="toolbar-spacer" />
            <Button onClick={loadCatalog} disabled={catalog === null && !loadErr} title="Re-fetch the catalog">
              <RotateCw size={13} className={catalog === null && !loadErr ? 'spin' : ''} /> Refresh catalog
            </Button>
          </Toolbar>

          {loadErr ? (
            <ErrorBanner>{loadErr}</ErrorBanner>
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
            <p className="empty-state">No distros match “{query}”.</p>
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
              {pickedDistro ? `Selected: ${pickedDistro.friendly_name}` : 'Select a distro to continue.'}
            </span>
            <button className="btn-filled btn-filled--accent" disabled={!picked} onClick={() => setStep('review')}>
              Continue <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}

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
            <li><Download size={15} className="wiz-fact-icon" /><span>Downloads the official image directly and shows live speed and size.</span></li>
            <li>
              {pickedDistro.sha256
                ? <ShieldCheck size={15} className="wiz-fact-icon" />
                : <TriangleAlert size={15} className="wiz-fact-icon wiz-fact-icon--warning" />}
              <span>{pickedDistro.sha256
                ? 'The download is checked against the catalog’s SHA-256 checksum before import.'
                : 'The catalog has no checksum for this image. The download will not be verified before import.'}</span>
            </li>
            <li><Terminal size={15} className="wiz-fact-icon" /><span>The first time you open its terminal, the distro runs any first-run setup it has, such as creating your Linux username and password.</span></li>
          </ul>

          <div className="wiz-location">
            <span className="wiz-location-label" id="wiz-install-location">Install location</span>
            <div className="wsl-import-row">
              <input className="settings-dir-input" aria-labelledby="wiz-install-location" value={installDir} readOnly placeholder="Default location…" />
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

      {step === 'install' && pickedDistro && (
        <div className="wiz-panel">
          {installing && (
            <div className="wiz-install">
              <DistroLogo name={pickedDistro.name} label={pickedDistro.friendly_name} size={56} />
              <p className="wiz-status-title" role="status">{PHASE_LABEL[phase]} {pickedDistro.friendly_name}…</p>

              <div className="wiz-progress">
                {/* Indeterminate means no `aria-valuenow` at all, which is how a
                    screen reader is told "running, length unknown". */}
                <div
                  className="wiz-progress-track"
                  role="progressbar"
                  aria-label={`${PHASE_LABEL[phase]} ${pickedDistro.friendly_name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={indeterminate ? undefined : pct}
                  aria-valuetext={indeterminate ? `${PHASE_LABEL[phase]}…` : `${pct}%`}
                >
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
                {firstRun
                  ? 'Open a terminal to finish first-run setup. Most distros ask you to create your Linux username and password there.'
                  : 'First-run setup will not run for this install, so its terminal opens as root. Add a user inside the distro if you do not want to work as root.'}
              </p>
              <div className="wiz-done-actions">
                <button className="btn-filled btn-filled--accent" disabled={openTerm.pending}
                  onClick={() => openTerm.run(() => api.wslOpenTerminal(pickedDistro.name).catch(() => {}))}>
                  <Terminal size={13} /> Open terminal
                </button>
                <button className="btn-secondary" onClick={() => { setSelected(pickedDistro.name); setWslView('dashboard') }}>
                  <LayoutDashboard size={14} /> Go to WSL
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
