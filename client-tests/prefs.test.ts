import { test } from 'node:test'
import assert from 'node:assert/strict'

// The module reads localStorage and navigator at call time, so stub them per test.
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}
;Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })

const prefs = await import('../client/prefs.ts')
const { formatTime, localeChoice, setLocaleChoice, timeZoneChoice, setTimeZoneChoice, resolvedTimeZone, markdownEnabled, setMarkdownEnabled } = prefs

const reset = () => store.clear()

test('everything defaults to following the system', () => {
  reset()
  assert.equal(localeChoice(), 'system')
  assert.equal(timeZoneChoice(), 'system')
  assert.equal(markdownEnabled(), true)
  assert.equal(resolvedTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone)
})

test('explicit choices are honoured and an unknown zone falls back', () => {
  reset()
  setLocaleChoice('en')
  setTimeZoneChoice('Asia/Tokyo')
  assert.equal(localeChoice(), 'en')
  assert.equal(resolvedTimeZone(), 'Asia/Tokyo')
  setTimeZoneChoice('Not/AZone')
  assert.equal(timeZoneChoice(), 'system', 'a zone the runtime rejects must not be used')
})

test('times render in the chosen zone, not raw UTC', () => {
  reset()
  setLocaleChoice('en')
  setTimeZoneChoice('Asia/Tokyo')
  const value = '2026-11-01T17:15:35.254Z'
  const shown = formatTime(value, new Date('2026-11-01T18:00:00Z'))!
  assert.match(shown, /02:15/, 'JST is UTC+9')
  assert.doesNotMatch(shown, /Z$|T17:15/)
})

test('a different day shows the date, the same day does not', () => {
  reset()
  setLocaleChoice('en')
  setTimeZoneChoice('UTC')
  const value = '2026-11-01T08:00:00Z'
  const sameDay = formatTime(value, new Date('2026-11-01T20:00:00Z'))!
  const nextDay = formatTime(value, new Date('2026-11-03T20:00:00Z'))!
  assert.doesNotMatch(sameDay, /11\/1|11-01/)
  assert.match(nextDay, /11\/1|11-01|Nov/)
})

test('unusable timestamps are omitted instead of printed raw', () => {
  reset()
  assert.equal(formatTime(undefined), null)
  assert.equal(formatTime(''), null)
  assert.equal(formatTime('not-a-date'), null)
})

test('markdown preference round-trips', () => {
  reset()
  setMarkdownEnabled(false)
  assert.equal(markdownEnabled(), false)
  setMarkdownEnabled(true)
  assert.equal(markdownEnabled(), true)
})
