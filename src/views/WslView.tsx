import { useEffect, useRef } from 'react'
import { RefreshCw, Upload } from 'lucide-react'
import { useRefreshKey } from '../hooks/useRefreshKey'
import { useAppStore, type WslDistroTab } from '../store/appStore'
import { useVisiblePoll } from '../hooks/useVisiblePoll'
import { useWslData } from '../features/wsl/hooks'
import WslHome from '../features/wsl/components/WslHome'
import WslDistroPage from '../features/wsl/components/WslDistroPage'
import WslConfigTab from '../features/wsl/components/WslConfigTab'
import WslInstallWizard from '../features/wsl/components/WslInstallWizard'
import { SheetHead, Prerequisite, Button, ErrorBanner, StatusPill } from '../components/ui'
import KeepAlive from '../components/KeepAlive'

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

  const { status, distros, loading, reloading, runningChecked, error, reload, refresh, refreshRunning } = useWslData()
  const available  = status?.available ?? false
  const runningCnt = distros.filter(d => d.running).length
  const selectedDistro = distros.find(d => d.name === selected)

  useEffect(() => {
    useAppStore.getState().setWslDistrosNav(
      distros.map(d => ({ name: d.name, running: d.running, is_default: d.is_default })),
    )
  }, [distros])

  // Default the global selection to the default distro (or first), and keep it
  // valid if the current selection disappears (e.g. after migrate/unregister).
  useEffect(() => {
    if (distros.length === 0) return
    if (!selected || !distros.some(d => d.name === selected)) {
      setSelected((distros.find(d => d.is_default) ?? distros[0]).name)
    }
  }, [distros, selected, setSelected])

  useRefreshKey(reload)

  // A cheap 5 s running-state poll catches start and stop; a full silent refresh on navigation and
  // focus catches distros added or removed outside the app. Mount is skipped: useWslData already loaded.
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
    wslView === 'dashboard'  ? 'All distros at a glance: manage, clone, export, and optimize'
    : wslView === 'wslconfig' ? 'Machine-wide WSL2 settings, applied to every distro'
    : wslView === 'install'   ? 'Browse the catalog and install a new Linux distribution'
    : DISTRO_TAB_SUBTITLES[wslDistroTab]

  return (
    <div className="view-container wsl-view">
      <SheetHead
        crumbs={[
          { label: 'Overview', onClick: () => useAppStore.getState().setActiveView('dashboard') },
          ...(wslView === 'distro' && selected
            ? [{ label: 'WSL', onClick: () => useAppStore.getState().setWslView('dashboard') }, { label: selected }]
            : [{ label: 'WSL' }]),
        ]}
        title={wslView === 'distro' && selected ? selected : 'WSL'}
        subtitle={subtitle}
        status={
          wslView === 'distro' && selectedDistro ? (
            <StatusPill on={selectedDistro.running}>
              {selectedDistro.running ? 'Running' : 'Stopped'} · WSL {selectedDistro.version === 1 ? '1' : '2'}
            </StatusPill>
          ) : status && (
            <StatusPill on={available}>
              {available
                ? `${distros.length} distro${distros.length !== 1 ? 's' : ''}${runningCnt ? `, ${runningCnt} running` : ''}`
                : 'not installed'}
            </StatusPill>
          )
        }
        actions={
          <>
            {available && wslView === 'dashboard' && (
              <Button variant="primary" onClick={() => useAppStore.getState().setWslImportOpen(true)}>
                <Upload size={13} /> Import distro
              </Button>
            )}
            <Button onClick={reload} disabled={reloading}>
              <RefreshCw size={13} className={reloading ? 'spin' : ''} />
              Refresh
            </Button>
          </>
        }
      />

      <div className="page-scroll">
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!loading && status && !available && (
        <Prerequisite
          title="WSL is not installed"
          description="This page needs the Windows Subsystem for Linux. The rest of Workspace Atlas keeps working without it."
          steps={[
            'Open Windows Terminal or PowerShell as Administrator',
            'Run the command below',
            'Restart Windows when the installer asks',
            'Return here and refresh',
          ]}
          command="wsl --install"
          actions={
            <Button onClick={reload} disabled={reloading}>
              <RefreshCw size={13} className={reloading ? 'spin' : ''} />
              Refresh
            </Button>
          }
        />
      )}

      {available && loading && <div className="img-loading">Loading distros…</div>}

      {/* A probe boots a stopped distro, so these stay paused until the running flags are current. */}
      {available && !loading && (
        <KeepAlive active={runningChecked}>
          {wslView === 'dashboard' && <WslHome distros={distros} onReload={reload} />}
          {wslView === 'distro'    && <WslDistroPage distros={distros} onReload={reload} />}
          {wslView === 'install'   && <WslInstallWizard distros={distros} onReload={reload} />}
          {wslView === 'wslconfig' && (
            <WslConfigTab runningNames={distros.filter(d => d.running).map(d => d.name)} onAfterShutdown={reload} />
          )}
        </KeepAlive>
      )}
      </div>
    </div>
  )
}
