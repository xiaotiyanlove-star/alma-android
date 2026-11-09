# Development and release guide

## Source of truth

- `client/` contains the independently written Web UI and its encrypted tunnel.
- `android/` is the Capacitor shell. It owns Keystore storage, Android networking,
  notifications, the optional foreground service, and the activity lifecycle.
- `client-tests/` contains unit tests, Playwright UI flows, and opt-in live probes.
- `android/app/build.gradle` owns `versionCode` and `versionName`.
- `package.json` owns the npm package version. Release versions must match Gradle.

## Local workflow

```bash
npm ci
npm run test:all
npm run build:web
npx cap copy android
cd android
./gradlew testDebugUnitTest assembleDebug
```

Use `npm run test:all` before delivery. It runs the unit suite, type checking,
production build, and all Playwright flows. The UI flows use a synthetic relay
and never need a real desktop. Live probes are excluded from the normal suite.

Browser preview stores hosts in memory because it has no Android Keystore:

```bash
npm run dev
```

### Testing a build without disturbing the installed app

`npm run android:dev` produces an APK that installs **beside** the release
rather than replacing it. The debug build carries the `…herdr.dev` application
id and the “Alma Dev” label, so Android treats the two as separate apps: neither
can overwrite the other, and no pairing is lost when switching between them.

The dev build reports its own package name in Settings → About and turns off
in-app updates, because a release APK with a different id can never install over
it. `ALMA_APP_ID` in `vite.config.ts` is what carries that id into the page; the
Gradle suffix is invisible to the version regex.

The pairing scheme stays `alma://connect`. With both builds installed, Android
asks which app should open a pairing link — that choice is cheaper than a second
scheme, which would mean validating the same credential in two places.

## Release contract

The publishing workflow is `.github/workflows/ci.yml`. Pushing a `v*` tag starts:

1. all unit, type, build, and UI checks;
2. a check that the tag matches both `package.json` and Gradle;
3. the APK build;
4. signature verification;
5. a SHA-256 checksum file;
6. a public GitHub Release with the APK attached.

The complete operational runbook — secret setup, version bump, tagging,
post-publish verification, troubleshooting, and the Git-history check — is in
[releasing.md](./releasing.md). That document has two separate workflows:

- **Development preview:** a `.dev` APK built locally and shared through a
  temporary trycloudflare quick tunnel. It installs beside the official app and
  does not consume a version number.
- **Official release:** a version bump on `main`, green CI, a `vX.Y.Z` tag, CI
  signing, a public GitHub Release, and post-publish signature/checksum checks.

The current application release line is `0.1.x`. Historical `v0.4.213-*` and
`v1.x` tags do not describe the current application package version.

## Connection changes

Read [network-routing.md](./network-routing.md) before changing the LAN or relay
path. In particular, do not change the encrypted handshake, relay URL
construction, subnet gate, or pairing-identity proof to work around discovery.

## In-app updates

`client/app/updates.ts` reads the repository's latest GitHub Release and compares its
tag with the version baked into the web bundle. `DownloaderPlugin.java` in the
Android shell downloads only an asset URL from this repository, verifies the
published SHA-256, and hands the APK to the system installer through the existing
FileProvider. It never installs an unsigned or unverified file. Keeping the
release signing key stable is what lets a new APK replace the installed one.

## UI conventions

- Sheets share the `sheet-standard` shell: fixed header, scrollable body,
  persistent footer action area, and a close button.
- Destructive actions appear in the danger zone and require confirmation.
- “Desktop” is the user-facing name for a paired machine; “relay” is the
  network fallback, and “Connection & relay” is the connection-details sheet.
- Every string passed through `t()` or `tWith()` needs an English entry.
