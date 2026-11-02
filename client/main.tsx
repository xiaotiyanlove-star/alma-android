import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { controller } from './controller'
import { back, setExitHandler } from './router'

/**
 * The Android shell asks this before falling back to the system.
 * Returning true means the page handled Back; false lets the OS exit.
 */
window.__almaAndroidBack = () => {
  // true  = the page consumed Back (moved up one level)
  // false = let the native shell fall back to its own handling
  return back()
}
// When the router has nothing left, tell the shell to close the activity.
setExitHandler(() => {
  const bridge = (window as unknown as { __herdrExitApp?: () => void }).__herdrExitApp
  if (bridge) bridge()
})
// Development builds only: let the local debugger drive the controller.
if (import.meta.env.DEV) (window as unknown as { __herdrController?: typeof controller }).__herdrController = controller

declare global { interface Window { __almaAndroidBack?: () => boolean } }
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
