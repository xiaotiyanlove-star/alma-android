/**
 * Pairing links that arrive from the system instead of from the form.
 *
 * The Android shell registers `alma://connect` and forwards the URL; it parses
 * nothing, because the pairing rules (HTTPS relay, `e2e=1`, key shape) live in
 * one place and duplicating them in Java would create a second place for them
 * to drift. Validation therefore happens exactly where a pasted link is
 * validated: in `parsePairing`, when the user submits.
 *
 * The link is a credential, so it is held in a module variable and nowhere
 * else. It used to go through `sessionStorage`, which is disk-backed and can
 * outlive the tap it arrived with — not what "never stored" is supposed to
 * mean for a key.
 */

/** The link waiting to be shown, if any. */
let pending = ''

/** True for anything the shell would forward: scheme and host, nothing more. */
export function looksLikePairingLink(value: string): boolean {
  return value.trim().toLowerCase().startsWith('alma://connect')
}

/** Queues a link and returns whether it was one. */
export function rememberPairingLink(link: string): boolean {
  if (!looksLikePairingLink(link)) return false
  pending = link.trim()
  return true
}

/** The link waiting to be shown, if any. Reading it clears it. */
export function takePendingLink(): string {
  const value = pending
  pending = ''
  return value
}
