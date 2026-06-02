import { useAppStore } from '../store/appStore'
import Dashboard      from '../views/Dashboard'
import DockerView     from '../features/docker/DockerView'
import WslView        from '../views/WslView'
import PackagesView   from '../views/PackagesView'
import AutomationView from '../views/AutomationView'

export default function MainPanel() {
  const activeView = useAppStore(s => s.activeView)

  return (
    <main className="main-panel">
      {activeView === 'dashboard'  && <Dashboard />}
      {activeView === 'docker'     && <DockerView />}
      {activeView === 'wsl'        && <WslView />}
      {activeView === 'packages'   && <PackagesView />}
      {activeView === 'automation' && <AutomationView />}
    </main>
  )
}
