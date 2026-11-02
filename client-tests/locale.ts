/**
 * Pins the UI locale for unit tests that assert on translated copy.
 *
 * `i18n.t()` resolves the language from `localStorage` and then
 * `navigator.language`, so a test that asserts a Chinese string only passes on
 * a machine whose language happens to be Chinese. CI runs in en-US and failed
 * exactly that way. Import this first in any suite that matches on copy.
 *
 * Importing this also pins the value before the app modules are loaded, since
 * `t()` reads the locale on every call but `prefs` captures `navigator` at
 * import time.
 */

const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

// Force "system" to mean Chinese regardless of the host, which is what these
// assertions are written against.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true,
  writable: true,
})

export const localeStore = store
