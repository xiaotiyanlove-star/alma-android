/**
 * Pairing links that arrive from the system instead of from the form.
 *
 * The Android shell registers `alma://connect` and forwards the URL; it parses
 * nothing, because the pairing rules (HTTPS relay, `e2e=1`, key shape) live in
 * one place and duplicating them in Java would create a second place for them
 * to drift. Validation therefore happens exactly where a pasted link is
 * validated: in `parsePairing`, when the user submits.
 *
 * A link received before the page exists is stored in `sessionStorage` rather
 * than memory, so a reload between the tap and the form still lands on the
 * filled form; it is removed as soon as it is read.
 */

export const PENDING_LINK_KEY = 'herdr.pendingPairingLink'

/** True for anything the shell would forward: scheme and host, nothing more. */
export function looksLikePairingLink(value: string): boolean {
  return value.trim().toLowerCase().startsWith('alma://connect')
}

/** Queues a link and returns whether it was one. */
export function rememberPairingLink(link: string): boolean {
  if (!looksLikePairingLink(link)) return false
  try { sessionStorage.setItem(PENDING_LINK_KEY, link.trim()) } catch { /* storage blocked */ }
  return true
}

/** The link waiting to be shown, if any. Reading it clears it. */
export function takePendingLink(): string {
  try {
    const value = sessionStorage.getItem(PENDING_LINK_KEY)
    if (value) sessionStorage.removeItem(PENDING_LINK_KEY)
    return value ?? ''
  } catch { return '' }
}
