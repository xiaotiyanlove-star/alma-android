/**
 * Build metadata. `__APP_VERSION__`, `__APP_ID__` and `__BUILD_TIME__` are
 * replaced at build time by Vite (see vite.config.ts), so the About screen can
 * never disagree with the APK the user installed.
 */
declare const __APP_VERSION__: string
declare const __APP_ID__: string
declare const __BUILD_TIME__: string

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
export const APP_ID = typeof __APP_ID__ === 'string' ? __APP_ID__ : 'local.almaandroid.herdr'
export const BUILD_TIME = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev'
