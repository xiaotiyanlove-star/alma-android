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

## Release contract

The publishing workflow is `.github/workflows/ci.yml`. Pushing a `v*` tag starts:

1. all unit, type, build, and UI checks;
2. a check that the tag matches both `package.json` and Gradle;
3. the APK build;
4. signature verification;
5. a SHA-256 checksum file;
6. a public GitHub Release with the APK attached.

The current application release line is `0.1.x`. Historical `v0.4.213-*` and
`v1.x` tags do not describe the current application package version.

To publish the current app version:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.22 -m "Alma Android 0.1.22"
git push origin v0.1.22
```

Release signing uses Android Keystore secrets available only to the workflow:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

When those secrets are absent, the workflow publishes a debug-signed APK whose
name says `-debug`. It does not publish an unsigned release artifact.

## Connection changes

Read [network-routing.md](./network-routing.md) before changing the LAN or relay
path. In particular, do not change the encrypted handshake, relay URL
construction, subnet gate, or pairing-identity proof to work around discovery.

## UI conventions

- Sheets share the `sheet-standard` shell: fixed header, scrollable body,
  persistent footer action area, and a close button.
- Destructive actions appear in the danger zone and require confirmation.
- “Desktop” is the user-facing name for a paired machine; “relay” is the
  network fallback, and “Connection & relay” is the connection-details sheet.
- Every string passed through `t()` or `tWith()` needs an English entry.
