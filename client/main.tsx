import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { controller } from './controller'
import { back, replace } from './router'
import { rememberPairingLink } from './pending-link'
import { applyTheme } from './prefs'

// Before the first paint: a light frame around a dark page (or the reverse)
// shows up as a flash on every launch.
applyTheme()
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme())
} catch { /* older WebView */ }

/**
 * The Android shell asks this before falling back to the system.
 * Returning true means the page handled Back; false lets the OS exit.
 */
window.__almaAndroidBack = () => {
  // true  = the page consumed Back (moved up one level)
  // false = let the native shell fall back to its own handling
  return back()
}
// Development builds only: let the local debugger drive the controller.
if (import.meta.env.DEV) (window as unknown as { __herdrController?: typeof controller }).__herdrController = controller

/** A link the shell forwarded while the page was live. */
function handlePairingLink(link: string) {
  if (!rememberPairingLink(link)) return
  // `replace` rather than `push`: `push` is a no-op when the add form is
  // already open, and that form reads the pending link once, at mount — so a
  // second link tapped while it was up was silently dropped. Replacing remounts
  // it, so the field shows the link the user just tapped.
  replace({ name: 'addHost' })
}

// The shell calls this when the page is already able to take the link.
;(window as unknown as { __almaAndroidPairing?: (link: string) => void }).__almaAndroidPairing = handlePairingLink
// From `onCreate` the page does not exist yet, so the shell retains the value
// in Java for this one synchronous bridge read, then drops its copy.
try {
  const pending = (window as unknown as { __almaAndroidUi?: { takePairingLink?(): string } }).__almaAndroidUi?.takePairingLink?.()
  if (pending) handlePairingLink(pending)
} catch { /* browser preview, or no native shell */ }

declare global { interface Window { __almaAndroidBack?: () => boolean } }
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
