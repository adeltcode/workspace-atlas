import { useAppStore } from '../store/appStore'
import ErrorBoundary  from '../components/ErrorBoundary'
import KeepAlive      from '../components/KeepAlive'
import Dashboard      from '../views/Dashboard'
import DockerView     from '../features/docker/DockerView'
import WslView        from '../views/WslView'
import SandboxView    from '../features/sandbox/SandboxView'
import PackagesView   from '../features/packages/PackagesView'
import PortsView      from '../features/holders/PortsView'
import LocksView      from '../features/holders/LocksView'
import ClipboardView  from '../features/clipboard/ClipboardView'
import CachesView     from '../features/caches/CachesView'
import SettingsView   from '../views/SettingsView'

// Constant elements, so moving between pages does not re-render the hidden ones.
const PAGES = {
  dashboard: <Dashboard />,
  docker:    <DockerView />,
  wsl:       <WslView />,
  sandbox:   <SandboxView />,
  packages:  <PackagesView />,
  ports:     <PortsView />,
  locks:     <LocksView />,
  clipboard: <ClipboardView />,
  caches:    <CachesView />,
  settings:  <SettingsView />,
}

export default function MainPanel() {
  const activeView = useAppStore(s => s.activeView)

  return (
    <main className="main-panel">
      {Object.entries(PAGES).map(([view, page]) => (
        <KeepAlive key={view} active={activeView === view}>
          <ErrorBoundary title="This page failed to render">{page}</ErrorBoundary>
        </KeepAlive>
      ))}
    </main>
  )
}
