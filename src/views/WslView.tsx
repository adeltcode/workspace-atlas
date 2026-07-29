import { useEffect, useRef } from 'react'
import { RefreshCw, Upload } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore, type WslDistroTab } from '../store/appStore'
import { useVisiblePoll } from '../hooks/useVisiblePoll'
import { useWslData } from '../features/wsl/hooks'
import WslHome from '../features/wsl/components/WslHome'
import WslDistroPage from '../features/wsl/components/WslDistroPage'
import WslConfigTab from '../features/wsl/components/WslConfigTab'
import WslInstallWizard from '../features/wsl/components/WslInstallWizard'
import { SheetHead, Prerequisite, Button, ErrorBanner } from '../components/ui'

const DISTRO_TAB_SUBTITLES: Record<WslDistroTab, string> = {
  overview:    'Live CPU, memory, disk, network, and process metrics inside this distro',
  startup:     'View and manage the systemd services that start with this distro',
  performance: 'Benchmark cold-boot time and profile shell startup',
  config:      'Edit /etc/wsl.conf inside this distro',
}

export default function WslView() {
  const wslView      = useAppStore(s => s.wslView)
  const wslDistroTab = useAppStore(s => s.wslDistroTab)
  const selected     = useAppStore(s => s.wslSelectedDistro)
  const setSelected  = useAppStore(s => s.setWslSelectedDistro)

  const { status, distros, loading, error, reload, refresh, refreshRunning } = useWslData()
  const available  = status?.available ?? false
  const runningCnt = distros.filter(d => d.running).length
  const selectedDistro = distros.find(d => d.name === selected)

  // Publish the distro list + badge to the store for the sidebar nav.
  useEffect(() => {
    useAppStore.getState().setWslDistrosNav(
      distros.map(d => ({ name: d.name, running: d.running, is_default: d.is_default })),
    )
    useAppStore.getState().setWslBadges(
      distros.length
        ? { distros: runningCnt > 0 ? `${runningCnt}/${distros.length}` : String(distros.length) }
        : null,
    )
  }, [distros, runningCnt])

  // Default the global selection to the default distro (or first), and keep it
  // valid if the current selection disappears (e.g. after migrate/unregister).
  useEffect(() => {
    if (distros.length === 0) return
    if (!selected || !distros.some(d => d.name === selected)) {
      setSelected((distros.find(d => d.is_default) ?? distros[0]).name)
    }
  }, [distros, selected, setSelected])

  // Ctrl+R / Cmd+R → Refresh
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'r' && !e.shiftKey) {
        e.preventDefault(); reload()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reload])

  // Keep the distro list live without the heavy registry/VHD scan on every tick:
  //  • a cheap running-state poll every 5s catches start/stop (the common case),
  //  • a full silent refresh on sub-view navigation + window focus catches distros
  //    added/removed outside the app.
  // The initial mount is skipped - useWslData already did the full load - so we
  // don't double-fetch on open.
  const didMount = useRef(false)
  useEffect(() => {
    if (!available) return
    if (didMount.current) refresh()
    else didMount.current = true

    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [available, wslView, refresh, refreshRunning])

  useVisiblePoll(refreshRunning, 5000, available)

  const subtitle =
    wslView === 'dashboard'  ? 'All distributions at a glance: manage, clone, export, and optimize'
    : wslView === 'wslconfig' ? 'Machine-wide WSL2 settings, applied to every distribution'
    : wslView === 'install'   ? 'Browse the catalog and install a new Linux distribution'
    : DISTRO_TAB_SUBTITLES[wslDistroTab]

  return (
    <div className="view-container wsl-view">
      <div className="page-head">
      <SheetHead
        crumbs={[
          { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
          ...(wslView === 'distro' && selected
            ? [{ label: 'WSL', onClick: () => useAppStore.getState().setWslView('dashboard') }, { label: selected }]
            : [{ label: 'WSL' }]),
        ]}
        title={wslView === 'distro' && selected ? selected : 'WSL'}
        subtitle={subtitle}
        /* On a distro page the header describes that distro, not the module: the
           distro count, the default marker and the switcher were all repeating
           what the rail already shows, next to a name the page repeated too. */
        status={
          wslView === 'distro' && selectedDistro ? (
            <span className="pill">
              <span className={clsx('rail-dot', selectedDistro.running ? 'running' : 'stopped')} />
              {selectedDistro.running ? 'Running' : 'Stopped'} · WSL {selectedDistro.version === 1 ? '1' : '2'}
            </span>
          ) : status && (
            <span className="pill">
              <span className={clsx('rail-dot', available ? 'running' : 'stopped')} />
              {available
                ? `${distros.length} distro${distros.length !== 1 ? 's' : ''}${runningCnt ? `, ${runningCnt} running` : ''}`
                : 'not installed'}
            </span>
          )
        }
        actions={
          <>
            {available && wslView === 'dashboard' && (
              <Button variant="primary" onClick={() => useAppStore.getState().setWslImportOpen(true)}>
                <Upload size={13} /> Import distro
              </Button>
            )}
            <Button onClick={reload} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
              Refresh
            </Button>
          </>
        }
      />
      </div>

      <div className="page-scroll">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!loading && status && !available && (
        <Prerequisite
          title="WSL is not installed"
          description="This module needs the Windows Subsystem for Linux. The rest of Workspace Atlas keeps working without it."
          steps={[
            'Open Windows Terminal or PowerShell as Administrator',
            'Run the command below',
            'Restart Windows when the installer asks',
            'Return here and refresh',
          ]}
          command="wsl --install"
          actions={
            <Button onClick={reload} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
              Refresh
            </Button>
          }
        />
      )}

      {available && (
        <>
          {wslView === 'dashboard' && <WslHome distros={distros} loading={loading} onReload={reload} />}
          {wslView === 'distro'    && <WslDistroPage distros={distros} onReload={reload} />}
          {wslView === 'install'   && <WslInstallWizard distros={distros} onReload={reload} />}
          {wslView === 'wslconfig' && (
            <WslConfigTab runningNames={distros.filter(d => d.running).map(d => d.name)} onAfterShutdown={reload} />
          )}
        </>
      )}
      </div>
    </div>
  )
}
