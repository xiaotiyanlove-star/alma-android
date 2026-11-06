import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The three values that have to agree before a release.
 *
 * CI checks them too, but at tag-push time a mismatch wastes a full test run and
 * can leave a tag on the wrong commit. They are read from the source of truth
 * here, not repeated as literals, so bumping a version does not need a test edit.
 */
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const gradle = readFileSync('android/app/build.gradle', 'utf8')
const versionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1]
const versionCode = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1])

test('package.json, versionName and versionCode describe the same release', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'the release version is `major.minor.patch`')
  assert.equal(versionName, pkg.version, 'Gradle and npm must name the same version')
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  // Android only installs a larger versionCode, and the project's convention is
  // that it tracks the patch of a 0.1.x line. A mismatch that compiles is still
  // a release the phone will refuse as "already installed".
  assert.ok(Number.isInteger(versionCode) && versionCode > 0, 'versionCode is a positive integer')
  assert.equal(versionCode, patch, `versionCode ${versionCode} should track patch ${patch} on the ${major}.${minor}.x line`)
})
