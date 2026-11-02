# Alma Android

An unofficial Android client for [Herdr](https://herdr.dev) on top of [Alma](https://alma.now).
Pair with one or more Alma desktops, then read and drive your coding agents — Claude Code,
Codex, pi — from a phone.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

This fork keeps the Android shell of [nanami-0713/alma-android](https://github.com/nanami-0713/alma-android)
but replaces the bundled Alma renderer with an independently written, Herdr-only client.
The connection, the state handling and the entire UI live in `client/`.

## What it does

- **Multiple desktops.** Each pairing is its own node with its own relay and credentials.
  Same pane IDs on different machines never share content or send targets.
- **Herdr sessions.** Workspace and agent list, live status, chat history with incremental
  updates, and a terminal view with the keys you actually need.
- **Sending.** Messages go through `agent.prompt`; terminal input uses bracketed paste plus
  Enter. A request that was sent but not confirmed is marked uncertain and never retried
  automatically.
- **Approval buttons.** A numbered menu drawn in the terminal becomes tappable, but only
  after the terminal is re-read and the question, labels and highlighted row all match.
- **QR pairing.** Scan the code from Alma's Remote Access screen, or paste the link.
- **Local alerts.** Notify when an agent is waiting for you or just finished. Optionally keep
  the connection alive in the background with a foreground service.
- **Display preferences.** Markdown rendering with a per-session source toggle; language and
  time zone both default to following the system.

## What it does not do

No remote desktop, browser control, chat composer for Alma's own threads, model/provider
configuration, or cloud push. The phone is a window onto the desktop; the models, the agent
processes and the keys stay on the Mac.

## Requirements

- Alma desktop with Remote Access enabled (relay reachable over HTTPS)
- Herdr running on that desktop
- A Herdr integration for your agent, so it reports its native session id
- Android 6.0+ (API 23); JDK 21 and Android SDK 35 to build

## Build

```bash
npm ci
npm run check                 # unit tests + typecheck + production build
npm run android:sync          # build client/ and copy it into the Android project
cd android && ./gradlew assembleDebug
```

Set `JAVA_HOME` and `ANDROID_HOME` first. The debug APK lands in
`android/app/build/outputs/apk/debug/`.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME=$HOME/Library/Android/sdk
```

For a browser preview without the native shell:

```bash
npm run dev                   # http://127.0.0.1:5174
```

In the browser there is no Keystore, so nodes live in memory and disappear on reload.

## Layout

```
client/            The app: transport, controller, UI
  transport.ts     E2E tunnel (P-256 + HKDF + AES-GCM) and HTTP/WS multiplexing
  controller.ts    Per-node state, session subscriptions, sending, approvals
  prompt.ts        Terminal menu parsing and drift detection
  crypto.ts        Crypto primitives (adapted from lazyeo/alma-android, MIT)
  prefs.ts         Language, time zone and Markdown preferences
android/           Capacitor shell
  HerdrVaultPlugin.java     Node credentials sealed with Android Keystore
  KeepAlivePlugin/Service   Optional foreground service
client-tests/      Unit tests, Playwright flows, device-side probes
www/               Upstream's bundled Alma renderer, kept for the upstream
                   release scripts. Not used by this client and not built.
```

## Testing

```bash
npm test                      # 44 unit tests
node_modules/.bin/tsx client-tests/browser-smoke.ts     # full UI flow
node_modules/.bin/tsx client-tests/scan-flow-check.ts   # QR scanner
node_modules/.bin/tsx client-tests/prompt-ui-check.ts   # approval buttons
node_modules/.bin/tsx client-tests/markdown-ui-check.ts # markdown + time zone
```

The Playwright checks run against the dev server with a mocked relay. They use synthetic
pairing codes only; no real desktop is contacted.

## Security

- A pairing link grants full access to that desktop. It is masked in the UI, cleared after
  saving, never logged, and stored only in Keystore-encrypted storage.
- `android:allowBackup="false"`; cleartext traffic is disabled except where the OS requires it.
- Markdown from the model is rendered without raw HTML, and images are limited to inline data.
- Transport failures end every pending request; late responses are discarded by session identity.

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Not affiliated with the Alma or Herdr projects.
