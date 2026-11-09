import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The development APK has to install *beside* the release, not over it.
 *
 * Installing a build over the installed app is the normal Android behaviour,
 * so testing a change used to mean uninstalling first and losing every pairing.
 * Two things make the two copies siblings, and both are checked here because
 * either one silently breaking would put the release at risk:
 *
 * - a distinct application id, so the system never compares their signatures;
 * - a distinct launcher label, so neither is mistaken for the other.
 *
 * The pairing scheme is deliberately left alone: `alma://connect` is validated
 * in exactly one place, and a second scheme would be a second place for that
 * rule to drift.
 */
const gradle = readFileSync('android/app/build.gradle', 'utf8')
const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8')
const strings = readFileSync('android/app/src/main/res/values/strings.xml', 'utf8')

test('the debug build has its own application id, so it installs beside the release', () => {
  assert.match(gradle, /applicationIdSuffix\s+"\.dev"/, 'without a suffix the debug build replaces the release')
})

test('the debug build is labelled differently in the launcher', () => {
  assert.match(gradle, /almaLabel/, 'the label has to come from a placeholder')
  assert.match(gradle, /debug\s*\{[\s\S]*?almaLabel:\s*"@string\/app_name_dev"/, 'the debug label is its own string')
  assert.match(strings, /<string name="app_name_dev">Alma Dev<\/string>/)
  assert.match(manifest, /android:label="\$\{almaLabel\}"/, 'the manifest reads the placeholder')
})

test('the debug build keeps the release version number, plus a suffix', () => {
  // The version has to keep matching `package.json` and the git tag, so the dev
  // build marks itself with a suffix rather than by pretending to be a version
  // that was never released.
  assert.match(gradle, /versionNameSuffix\s+"-dev"/)
  assert.match(gradle, /versionName\s+"0\.1\.\d+"/, 'and the release version is untouched')
})

test('the pairing scheme is not duplicated for the dev build', () => {
  assert.doesNotMatch(gradle, /almadev/, 'a second scheme would be a second place to validate a credential')
  assert.match(manifest, /<data android:scheme="alma" android:host="connect" \/>/)
})

test('the page reports the build the user actually installed', () => {
  // Gradle applies the id and version suffixes at packaging time, after Vite
  // has read build.gradle. Without passing them across, About would show the
  // release identity for a dev APK — and the updater would think it could
  // install a release over itself.
  const vite = readFileSync('vite.config.ts', 'utf8')
  assert.match(vite, /ALMA_APP_ID/, 'the id comes from the build, not from the regex alone')
  assert.match(vite, /-dev/, 'and so does the suffix that makes the version honest')
  assert.match(readFileSync('package.json', 'utf8'), /ALMA_APP_ID=local\.almaandroid\.herdr\.dev/)
})

test('the release job signs with the alias it verified, not a hard-coded one', () => {
  // A keystore may legally use any alias. Hard-coding `alma` in the build
  // environment made the preceding keytool check meaningless: it verified the
  // configured alias and signing then used a different one.
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
  const releaseStep = workflow.match(/- name: Build signed release APK[\s\S]*?- name:/)?.[0] ?? ''
  assert.match(releaseStep, /ALMA_RELEASE_KEY_ALIAS: \$\{\{ secrets\.ANDROID_KEY_ALIAS \}\}/)
  assert.doesNotMatch(releaseStep, /ALMA_RELEASE_KEY_ALIAS: alma\b/)
})
