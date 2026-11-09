/**
 * Display preferences. Everything defaults to "follow the system"; the app
 * never turns a locale or time zone into stored data unless the user picks one.
 */

export type LocaleChoice = 'system' | 'zh-CN' | 'en'
export type TimeZoneChoice = 'system' | string

export const LOCALE_KEY = 'herdr.prefs.locale'
export const TIMEZONE_KEY = 'herdr.prefs.timezone'
export const MARKDOWN_KEY = 'herdr.prefs.markdown'
export const THEME_KEY = 'herdr.prefs.theme'

export type ThemeChoice = 'system' | 'light' | 'dark'

/** The saved appearance choice; `system` is the default and stores nothing. */
export function themeChoice(): ThemeChoice {
  const value = read(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}
export function setThemeChoice(value: ThemeChoice) {
  write(THEME_KEY, value === 'system' ? '' : value)
  applyTheme()
}

/** The appearance in force right now, after resolving `system`. */
export function resolvedTheme(): 'light' | 'dark' {
  const choice = themeChoice()
  if (choice !== 'system') return choice
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch { return 'light' }
}

/**
 * Puts the appearance on the document and tells the native shell.
 *
 * The page and the Android window have to agree: the WebView's own background,
 * the status bar and the system bar icons are native, so a dark page over a
 * white window frame shows as flashes and unreadable bars.
 */
export function applyTheme() {
  // Called from tests too, where there is no document or window.
  try {
    const theme = resolvedTheme()
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    const bridge = (window as unknown as { __almaAndroidUi?: { setTheme?(mode: string): void } }).__almaAndroidUi
    bridge?.setTheme?.(themeChoice())
  } catch { /* web preview, or no DOM */ }
}

/** Rendered markdown is the default; the toggle switches to raw source. */
export function markdownEnabled(): boolean {
  try { return localStorage.getItem(MARKDOWN_KEY) !== 'off' } catch { return true }
}
export function setMarkdownEnabled(enabled: boolean) {
  try { localStorage.setItem(MARKDOWN_KEY, enabled ? 'on' : 'off') } catch { /* storage blocked */ }
}

/** Common zones offered first; anything else is reachable by typing. */
export const COMMON_ZONES = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
] as const

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* storage blocked */ }
}

export function localeChoice(): LocaleChoice {
  const value = read(LOCALE_KEY)
  return value === 'zh-CN' || value === 'en' ? value : 'system'
}
export function setLocaleChoice(value: LocaleChoice) { write(LOCALE_KEY, value === 'system' ? '' : value) }

export function timeZoneChoice(): TimeZoneChoice {
  const value = read(TIMEZONE_KEY)
  if (!value) return 'system'
  // A zone that no longer exists falls back to the system rather than throwing.
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value } catch { return 'system' }
}
export function setTimeZoneChoice(value: TimeZoneChoice) { write(TIMEZONE_KEY, value === 'system' ? '' : value) }

/** Resolved IANA zone name for display, e.g. "Asia/Shanghai". */
export function resolvedTimeZone(): string {
  const choice = timeZoneChoice()
  if (choice !== 'system') return choice
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Resolved locale tag, e.g. "zh-CN". */
export function resolvedLocale(): string {
  const choice = localeChoice()
  if (choice !== 'system') return choice
  return navigator.language || 'zh-CN'
}

/**
 * Formats an agent timestamp in the chosen zone using the system's convention
 * (24h for zh, 12h for en-US). Returns null for unusable input so callers can
 * omit the element instead of printing a raw ISO string.
 */
export function formatTime(value: string | undefined, now = new Date()): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const locale = resolvedLocale()
  const timeZone = resolvedTimeZone()
  const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone }).format(date) === new Intl.DateTimeFormat('en-CA', { timeZone }).format(now)
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
