/**
 * Composer drafts, kept per desktop and pane so leaving a session (or the app
 * being reclaimed) does not throw away what the user was typing.
 */
const KEY = 'herdr.drafts'
const LIMIT = 40

type Drafts = Record<string, string>

function read(): Drafts {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Drafts : {}
  } catch { return {} }
}

function write(value: Drafts) {
  try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* storage blocked */ }
}

const slot = (hostId: string, paneId: string) => `${hostId}::${paneId}`

export function loadDraft(hostId: string, paneId: string): string {
  return read()[slot(hostId, paneId)] ?? ''
}

export function saveDraft(hostId: string, paneId: string, text: string) {
  const drafts = read()
  if (text) drafts[slot(hostId, paneId)] = text
  else delete drafts[slot(hostId, paneId)]
  const keys = Object.keys(drafts)
  // Bounded so a long-lived install cannot grow without limit.
  if (keys.length > LIMIT) for (const key of keys.slice(0, keys.length - LIMIT)) delete drafts[key]
  write(drafts)
}

export function clearDraft(hostId: string, paneId: string) { saveDraft(hostId, paneId, '') }
