# Releasing Alma Android

This is the operational runbook for shipping a new APK. It assumes nothing
about the machine beyond a clone of the repository and GitHub access, so a new
environment can follow it from top to bottom.

Do not put a keystore, password, alias, token, or Base64 blob in this file, a
commit, an issue, or a shell command saved to history. They belong only in
GitHub Actions secrets.

## 1. What publishes a release

`.github/workflows/ci.yml` is the only publisher. A push to `main` builds and
tests; a push of a `v*` tag additionally builds the signed release APK and
creates a public GitHub Release. Both paths run the complete suite first.

```text
push to main        -> tests, types, web build, UI flows, debug APK artifact
push of vX.Y.Z tag -> the same checks, then signed release APK + GitHub Release
workflow_dispatch  -> optional signing diagnosis; never creates a Release
```

The tag is the release switch. Do not create a Release by hand and do not upload
an APK to GitHub manually: the workflow is what attaches the APK, its SHA-256
file, and the generated release notes.

## 2. Choose the kind of build

There are two different outputs, and they deliberately have different
identities:

| | Development preview | Official release |
| --- | --- | --- |
| Package name | `local.almaandroid.herdr.dev` | `local.almaandroid.herdr` |
| Launcher label | Alma Dev | Alma Android |
| Install behaviour | sits beside the official app | replaces the official app |
| Signing | local Android debug key | the four CI secrets |
| In-app update | intentionally disabled | enabled |
| Distribution | temporary download link | GitHub Release |
| Published from | this machine | a `vX.Y.Z` tag |

Never uninstall the official app to try a development preview. The `.dev`
suffix exists precisely so both can be installed at once without touching the
pairing vault.

## 3. One-time repository setup

The release job requires four repository secrets under **Settings → Secrets and
variables → Actions**:

| Secret | What it is |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The complete release `.jks`, Base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore's store password |
| `ANDROID_KEY_ALIAS` | The private-key alias inside the keystore |
| `ANDROID_KEY_PASSWORD` | The private key password for that alias |

The alias is taken from `ANDROID_KEY_ALIAS`. The workflow aborts if any of the
four values is missing or if the keystore, alias, or key password cannot be
verified, and it never generates a replacement key.

To set a secret without putting its value in shell history:

```bash
gh secret set ANDROID_KEYSTORE_BASE64 --repo xiaotiyanlove-star/alma-android < release.jks.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --repo xiaotiyanlove-star/alma-android
gh secret set ANDROID_KEY_ALIAS --repo xiaotiyanlove-star/alma-android
gh secret set ANDROID_KEY_PASSWORD --repo xiaotiyanlove-star/alma-android
```

The last three prompt for input. Create the Base64 file locally, with no
trailing newline, and delete it afterwards:

```bash
base64 -i /path/to/alma-release.jks | tr -d '\n' > /tmp/alma-release.jks.b64
```

### Keeping the key stable

Android only lets a new APK replace an installed one when the package name and
the signing certificate are both identical. Changing the keystore makes every
following release require an uninstall and loses the app's local pairing data.
The four secrets above must therefore stay the same for the life of this app.

To confirm that a release is signed with the expected certificate, compare the
certificate digest of two downloaded APKs:

```bash
apksigner verify --print-certs alma-android-v0.1.22.apk
apksigner verify --print-certs alma-android-v0.1.25.apk
```

The `Signer #1 certificate SHA-256 digest` must match. A different digest is the
reason an install asks the user to uninstall the old app first.

## 4. Development preview with trycloudflare

Use this when the user asks for a testable build, a focused fix, or an APK that
must not disturb the installed official app. This is **not** a release.

### Build

From the repository root, with Java 21 available and the Android SDK located
(`ANDROID_HOME` exported, or `sdk.dir` in `android/local.properties`):

```bash
npm ci
npm run test:all
npm run android:dev
```

`npm run test:all` drives the Playwright flows against
`http://127.0.0.1:5174`, so it needs the dev server running first (`npm run dev`
in another terminal) or `APP_PORT` pointing at one already listening. Without
either, every UI flow fails on navigation — which reads like a broken build
rather than a missing server.

`android:dev` builds the web bundle with
`ALMA_APP_ID=local.almaandroid.herdr.dev` and then assembles `Debug`; Gradle
adds both the `.dev` package suffix and the `-dev` version suffix. The result is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Check its identity before sharing it:

```bash
$HOME/Library/Android/sdk/build-tools/36.0.0/aapt dump badging \
  android/app/build/outputs/apk/debug/app-debug.apk | head -1
```

The output must contain `package: name='local.almaandroid.herdr.dev'` and
`versionName='<package version>-dev'`. Do not share a file that says
`local.almaandroid.herdr`; that would try to replace the official app.

### Make a temporary download

Cloudflare quick tunnels are temporary and have no uptime guarantee. Start the
file server and tunnel from the directory that contains the APK; do not expose
the project root or a keystore directory.

```bash
mkdir -p /tmp/alma-dev-build
cp android/app/build/outputs/apk/debug/app-debug.apk \
  /tmp/alma-dev-build/alma-android-<version>-dev.apk
cd /tmp/alma-dev-build
shasum -a 256 alma-android-<version>-dev.apk \
  > alma-android-<version>-dev.apk.sha256
python3 -m http.server 8842 --bind 127.0.0.1
```

In a second terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8842 --no-autoupdate
```

Copy the printed `https://….trycloudflare.com` URL, then verify the public path
before sending it:

```bash
curl -L -o /tmp/downloaded-dev.apk \
  https://<tunnel-host>/alma-android-<version>-dev.apk
shasum -a 256 /tmp/downloaded-dev.apk /tmp/alma-dev-build/alma-android-<version>-dev.apk
```

The two hashes must match. Send both the URL and hash in the handoff. When the
test is finished, stop `cloudflared` and the local HTTP server; the URL stops
working and must not be recorded as a release link.

A quick tunnel is only a transport for a file. It does not make the build
official, does not update the in-app updater, and must not be tagged `v*`.

## 5. Prepare a version

Before bumping anything, the worktree must be clean and the change must already
be committed. A release tag points at a commit, not at uncommitted files.

### Decide the version

Use semantic patch bumps for user-visible fixes and minor bumps for a coherent
feature set. Three values move together:

- `package.json` → `"version"`
- `android/app/build.gradle` → `versionName`
- `android/app/build.gradle` → `versionCode`

The tag is `v` followed by exactly that version. `versionCode` must be larger
than every APK ever installed; this repository keeps it equal to the patch on
the `0.1.x` line, and `client-tests/version-agreement.test.ts` checks the three
numbers agree.

Do not release a debug preview under a new version by itself. A development
build keeps the current release number and appends `-dev`; only an official
Release consumes a new version number.

The three release values must agree exactly, or the release job stops before
building:

```text
package.json                  "version": "0.1.26"
android/app/build.gradle      versionName "0.1.26"
android/app/build.gradle      versionCode 26
Git tag                       v0.1.26
```

`versionCode` must increase for every new APK; Android uses it to decide that a
package is newer. `versionName` is the human version shown in Settings → About.
The web bundle reads the Gradle value at build time, so do not edit the About
screen separately.

Before tagging, run the complete suite from the repository root:

```bash
npm ci
npm run test:all
```

That covers the unit tests, TypeScript, the production web build, and every
Playwright UI flow, including the update screen. A local Android build is useful
before a first release but the CI job is authoritative:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  ./android/gradlew -p android testDebugUnitTest assembleDebug
```

### Commit the version bump

```bash
git add package.json android/app/build.gradle README.md README.zh-CN.md \
  docs/releasing.md client-tests/version-agreement.test.ts
git commit -m "Release <version>"
git push origin main
```

Then wait for the main CI run for that exact commit:

```bash
gh run list --repo xiaotiyanlove-star/alma-android --branch main --limit 1
gh run watch <run-id> --repo xiaotiyanlove-star/alma-android --exit-status
```

Do not create the tag while that run is red or still in progress.

## 6. Publish an official release

Wait for the `main` CI run for the exact commit to go green, then create the tag:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.26 -m "Alma Android 0.1.26"
git push origin v0.1.26
```

Pushing the tag starts the release job. Track it with:

```bash
gh run list --repo xiaotiyanlove-star/alma-android --branch v0.1.26 --limit 1
gh run watch <run-id> --repo xiaotiyanlove-star/alma-android --exit-status
```

A successful release job runs these steps in order:

1. tests, types, web build, and all UI flows;
2. tag/package/Gradle version agreement;
3. decode and verify the release keystore, alias, and key password;
4. `assembleRelease` with that keystore;
5. `apksigner verify` on the produced APK;
6. SHA-256 checksum generation;
7. `gh release create` with the APK and checksum as public assets.

### If a tag run fails before the Release exists

A failed tag run leaves the public tag on the commit it was pushed from. Fix
`main`, push the correction, then move the tag — but only while no Release
exists for that tag:

```bash
gh release view v0.1.25 --repo xiaotiyanlove-star/alma-android
```

If it reports `release not found`:

```bash
git tag -d v0.1.25
git push origin :refs/tags/v0.1.25
git tag -a v0.1.25 -m "Alma Android 0.1.25"
git push origin v0.1.25
```

If a Release does exist, do not move the tag. Bump the version and publish a
new tag instead.

## 7. Verify the published APK

```bash
gh release download v0.1.26 --repo xiaotiyanlove-star/alma-android --dir /tmp/alma-release-check --clobber
shasum -a 256 /tmp/alma-release-check/alma-android-v0.1.26.apk
cat /tmp/alma-release-check/alma-android-v0.1.26.apk.sha256
```

The two hashes must match. Then check identity and signature:

```bash
$HOME/Library/Android/sdk/build-tools/36.0.0/aapt dump badging \
  /tmp/alma-release-check/alma-android-v0.1.26.apk | head -1
apksigner verify --print-certs /tmp/alma-release-check/alma-android-v0.1.26.apk
```

Expected package and version:

```text
package: name='local.almaandroid.herdr' versionCode='26' versionName='0.1.26'
```

The in-app updater reads `releases/latest` from the public repository. Confirm
it points at the new tag:

```bash
curl -sS https://api.github.com/repos/xiaotiyanlove-star/alma-android/releases/latest
```

### Release checklist

- [ ] the intended fixes are committed and the worktree is clean
- [ ] `package.json`, Gradle `versionName`, Gradle `versionCode`, and the planned tag agree
- [ ] `npm ci && npm run test:all` is green
- [ ] Android unit tests and debug assembly are green
- [ ] the main-branch CI run for the exact release commit is green
- [ ] the release keystore, alias, and passwords are present as the four secrets
- [ ] the tag is created exactly once, on that green commit
- [ ] the tag CI run is green and a public Release exists
- [ ] the downloaded APK has the same SHA-256 as its published checksum
- [ ] `aapt` shows the expected package name, `versionCode`, and `versionName`
- [ ] `apksigner` shows the same certificate digest as the previous release
- [ ] a device with the previous official version installs this APK without uninstalling
- [ ] `releases/latest` returns the new tag for the in-app updater

## 8. Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| `Keystore was tampered with, or password was incorrect` | Store password does not match the Base64 keystore | Re-enter `ANDROID_KEYSTORE_PASSWORD`; do not regenerate the key |
| `key password rejected` | Alias or private-key password is wrong | Run the local `keytool` check below, then fix `ANDROID_KEY_PASSWORD` |
| `tag X != package.json Y` | Tag and code versions disagree | Fix both version files, commit, and move the tag only if no Release exists |
| `apksigner: command not found` | Build-tools are not on `PATH` | The workflow exports `build-tools/36.0.0`; keep that step |
| Installer asks to uninstall the old app | APK certificate differs from the installed one | Compare `apksigner` certificate digests; publish a release signed with the stored key |
| `Cache not found` for signing material | Old fallback-cache design | Removed: the workflow now uses the four secrets and fails loudly |

Local keystore diagnosis, with the JDK `keytool` and no secrets in the command:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/keytool \
  -list -v -keystore /path/to/alma-release.jks \
  -storepass
```

It prompts for the store password and prints `Alias name`. The alias and the
private key must be accepted before CI can sign.

## 9. Sensitive material and Git history

The repository is safe to publish: no `.jks`, private key, or `.env` file has
ever been tracked. The only signing material in history is the four secret
*names* and the workflow code that reads them.

An early experimental workflow (commit `0a97660`, since removed) contained a
plaintext password for a temporary fallback key. Treat that value as exposed:
it is not this app's release key and was never used for `0.1.22` or later, but
replace it if it is ever reused elsewhere. The corresponding Actions caches
were deleted. Removing the text from Git history would require rewriting the
tag and every later commit, so it is left in place and documented here.

Never commit:

- `*.jks`, `*.keystore`, `*.p12`, `*.pem`, or `*.key`
- decoded or Base64 keystores
- store or key passwords, aliases paired with passwords
- GitHub tokens, relay credentials, or real pairing links

Before a release, a quick check:

```bash
git ls-files | grep -Ei '\.(jks|keystore|p12|pem|key)$|(^|/)\.env$'
git grep -I -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|gho_[A-Za-z0-9]{20,}'
```

Both should print nothing.
