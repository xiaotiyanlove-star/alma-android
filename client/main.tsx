import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { controller } from './controller'

window.__almaAndroidBack = () => {
  if (!controller.getState().selectedPaneId) return false
  controller.backToSessions()
  return true
}
// Development builds only: let the local debugger drive the controller.
if (import.meta.env.DEV) (window as unknown as { __herdrController?: typeof controller }).__herdrController = controller

declare global { interface Window { __almaAndroidBack?: () => boolean } }
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
