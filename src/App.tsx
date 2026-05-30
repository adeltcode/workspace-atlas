import { useEffect } from 'react'
import { useAppStore } from './store/appStore'
import Titlebar   from './components/Titlebar'
import Sidebar    from './components/Sidebar'
import MainPanel  from './components/MainPanel'
import Terminal   from './components/Terminal'

export default function App() {
  const theme = useAppStore(s => s.theme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        <Sidebar />
        <div className="app-content">
          <MainPanel />
          <Terminal />
        </div>
      </div>
    </div>
  )
}
