import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { savedState } from './store/appStore'

// Saving waits a moment, so write what is waiting before the window goes away.
window.addEventListener('pagehide', savedState.flush)
document.addEventListener('visibilitychange', () => { if (document.hidden) savedState.flush() })

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <App />
)
