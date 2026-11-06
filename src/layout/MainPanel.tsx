import { useAppStore } from '../store/appStore'
import Dashboard      from '../views/Dashboard'
import DockerView     from '../features/docker/DockerView'
import WslView        from '../views/WslView'
import SandboxView    from '../features/sandbox/SandboxView'
import PackagesView   from '../features/packages/PackagesView'
import PortsView      from '../features/holders/PortsView'
import LocksView      from '../features/holders/LocksView'
import ClipboardView  from '../features/clipboard/ClipboardView'
import SettingsView   from '../views/SettingsView'

export default function MainPanel() {
  const activeView = useAppStore(s => s.activeView)

  return (
    <main className="main-panel">
      {activeView === 'dashboard'  && <Dashboard />}
      {activeView === 'docker'     && <DockerView />}
      {activeView === 'wsl'        && <WslView />}
      {activeView === 'sandbox'    && <SandboxView />}
      {activeView === 'packages'   && <PackagesView />}
      {activeView === 'ports'      && <PortsView />}
      {activeView === 'locks'      && <LocksView />}
      {activeView === 'clipboard'  && <ClipboardView />}
      {activeView === 'settings'   && <SettingsView />}
    </main>
  )
}
