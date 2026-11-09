/**
 * A ceiling on a promise that may never settle.
 *
 * Two calls in the connection path come from the native bridge — "which
 * subnets is this phone on" and, through it, "may this local address be
 * dialled" — and a bridge callback can be lost, most easily while the page is
 * being frozen or resumed. A promise that never settles is not a slow answer:
 * every later caller receives the same pending future, and the dial that awaits
 * it sits there until its own timeout, on every reconnect, forever.
 *
 * The fallback is always the answer that keeps the plain-text path closed. This
 * is a deadline, never a loosened check.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([work.catch(() => fallback), expiry]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
