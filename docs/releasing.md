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

## 2. One-time repository setup

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

## 3. Prepare a version

Three values must agree exactly, or the release job stops before building:

```text
package.json                  "version": "0.1.25"
android/app/build.gradle      versionName "0.1.25"
android/app/build.gradle      versionCode 25
Git tag                       v0.1.25
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

## 4. Publish

Wait for the `main` CI run for the exact commit to go green, then create the tag:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.25 -m "Alma Android 0.1.25"
git push origin v0.1.25
```

Pushing the tag starts the release job. Track it with:

```bash
gh run list --repo xiaotiyanlove-star/alma-android --branch v0.1.25 --limit 1
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

The tag can be moved to the corrected commit. This is only safe while no
Release exists for that tag; check first:

```bash
gh release view v0.1.25 --repo xiaotiyanlove-star/alma-android
```

If it reports `release not found`, fix `main`, push, then:

```bash
git tag -d v0.1.25
git push origin :refs/tags/v0.1.25
git tag -a v0.1.25 -m "Alma Android 0.1.25"
git push origin v0.1.25
```

If a Release does exist, do not move the tag. Bump the version and publish a
new tag instead.

## 5. Verify the published APK

```bash
gh release download v0.1.25 --repo xiaotiyanlove-star/alma-android --dir /tmp/alma-release-check --clobber
shasum -a 256 /tmp/alma-release-check/alma-android-v0.1.25.apk
cat /tmp/alma-release-check/alma-android-v0.1.25.apk.sha256
```

The two hashes must match. Then check identity and signature:

```bash
$HOME/Library/Android/sdk/build-tools/36.0.0/aapt dump badging \
  /tmp/alma-release-check/alma-android-v0.1.25.apk | head -1
apksigner verify --print-certs /tmp/alma-release-check/alma-android-v0.1.25.apk
```

Expected package and version:

```text
package: name='local.almaandroid.herdr' versionCode='25' versionName='0.1.25'
```

The in-app updater reads `releases/latest` from the public repository. Confirm
it points at the new tag:

```bash
curl -sS https://api.github.com/repos/xiaotiyanlove-star/alma-android/releases/latest
```

## 6. Troubleshooting

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

## 7. Sensitive material and Git history

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
