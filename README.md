# Alma Android

An unofficial Android client for [Herdr](https://herdr.dev), connecting through
[Alma](https://alma.now)'s end-to-end encrypted remote access.

[Alma](https://alma.now) is a desktop AI workspace by **yetone**: every model in one app,
a memory you can read, skills and MCP, and the part this client builds on, remote access
over a QR code. [Herdr](https://herdr.dev) is a terminal workspace manager for coding
agents, so Claude Code, Codex and pi keep running in their terminals while a side panel and
a phone can see what they are doing.

Pair with one or more Alma desktops and drive the coding agents running there —
Claude Code, Codex, pi — from a phone. The models, the agent processes and the API
keys stay on the desktop; the phone is a window onto them.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Credits

- **[yetone](https://github.com/yetone)** for [Alma](https://alma.now), which provides the
  encrypted relay this client talks to.
- **[nanami-0713](https://github.com/nanami-0713/alma-android)** for the Capacitor shell this
  project started from.
- **[lazyeo](https://github.com/lazyeo/alma-android)** for a clean reference implementation of
  the relay handshake.

## What it does

**Multiple desktops.** Each pairing is a node with its own relay and credentials. The
client keeps one encrypted tunnel per desktop; identical pane IDs on two machines never
share content or send targets, and the last desktop you used is restored on launch.

**Sessions and transcripts.** Workspaces, agents and their live status, chat history
with incremental updates, and a terminal view with the keys you actually need. History
is paginated by cursor and resumes from the last item received, so a reconnect does not
replay or skip messages.

**Sending.** Messages go through `agent.prompt`; terminal input uses bracketed paste
followed by Enter. A request that was sent but never confirmed — a dropped tunnel, a
timeout, an HTTP error — is marked *uncertain* and is never retried automatically.
You check the transcript or terminal, then decide.

**Approval buttons.** A numbered menu drawn in the terminal becomes tappable. Before any
key is sent the terminal is re-read and the question, the option labels and the
highlighted row must all match; if anything changed the tap is cancelled and the screen
refreshes. Menus without a cursor or checkbox — plain numbered lists in agent output —
are never turned into buttons.

**Attachments.** Up to six files per message, 50 MB each, uploaded to the desktop over
the same tunnel and referenced by their absolute path. Images use the image route; other
files use the generic one.

**New sessions.** Start Claude Code, Codex or pi in a directory of your choosing,
defaulting to the one you are already working in.

**QR pairing.** Scan the code from Alma's Remote Access screen, or paste the link.

**Local alerts.** A notification when an agent is waiting for you or has finished, based
on a status diff of the live connection. Nothing is uploaded and no push service is
involved.

**Display.** Markdown rendering with a per-session switch back to source, and language
and time zone that follow the system unless you override them.

## What it does not do

No remote desktop, no browser control, no client for Alma's own threads, no model or
provider configuration, and no cloud push. Chat history depends on the agent reporting a
native session id through its Herdr integration; where it does not, the client says so
and offers the terminal instead. Model names and context usage are not shown: Herdr's
API does not expose them, and the terminal does not print them.

## Requirements

- Alma desktop with Remote Access enabled, reachable over HTTPS
- Herdr running on that desktop
- A Herdr integration installed for the agent you want to follow
- To build: Node 22+, JDK 21, Android SDK 35

## Build

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21   # or wherever your JDK 21 lives
export ANDROID_HOME=$HOME/Library/Android/sdk

npm ci
npm run check          # unit tests, typecheck, production build
npm run android:build  # build the web app and assemble the debug APK
```

The APK lands in `android/app/build/outputs/apk/debug/`. Its `versionName` comes from
`android/app/build.gradle` and is injected into the About screen at build time, so the
two can never disagree.

For a browser preview without the native shell:

```bash
npm run dev            # http://127.0.0.1:5174
```

Browser preview has no Keystore, so nodes live in memory and disappear on reload.

## Layout

```
client/                The app
  transport.ts         E2E tunnel: P-256 + HKDF + AES-GCM, HTTP/WS multiplexing
  frames.ts            Inner frame codec (JSON/base64 and optional binary form)
  crypto.ts            Crypto primitives (adapted from lazyeo/alma-android, MIT)
  controller.ts        Per-desktop state, subscriptions, sending, approvals
  prompt.ts            Terminal menu parsing and drift detection
  router.ts            Navigation stack shared by the UI and the Back button
  lifecycle.ts         Foreground/background connection policy
  backoff.ts           Bounded reconnect pacing
  attachments.ts       Upload helpers and message composition
  prefs.ts             Language, time zone, Markdown
  i18n.ts              English dictionary keyed by the Chinese source string
  App.tsx              Screens and components
android/               Capacitor shell
  HerdrVaultPlugin     Node credentials sealed with Android Keystore
  KeepAlivePlugin      Optional foreground service
  MainActivity         File chooser, camera grant, notification channel
client-tests/          Unit tests, Playwright flows, device probes
www/                   Upstream's bundled Alma renderer, kept for the upstream
                       release scripts only. Not built, not used by this client.
```

## Testing

```bash
npm test        # unit tests: crypto, sessions, retries, prompts, prefs
npm run test:ui # Playwright flows against the dev server with a mocked relay
npm run check   # the above plus typecheck and a production build
```

The Playwright flows drive the real UI with a synthetic relay: they complete the
encrypted handshake, switch between desktops, send messages, answer an approval menu,
scan a generated QR code and toggle Markdown. They use synthetic pairing codes only and
never contact a real desktop.

A guard test fails the suite if a Chinese UI string used through `t()` has no English
entry, so untranslated text cannot slip back in.

## Security

- A pairing link grants full access to that desktop. It is masked in the UI, cleared
  after saving, never logged, and stored only in Keystore-encrypted storage under
  `noBackupFilesDir`; `allowBackup` is off.
- Only HTTPS relays are accepted, and cleartext traffic is disabled.
- Markdown from the model is rendered without raw HTML, and images are limited to inline
  data so a message cannot make the app fetch arbitrary URLs.
- Transport failure ends every pending request; responses that arrive for a session you
  have since left are discarded by identity, not merged.

## Licence

MIT — see [LICENSE](LICENSE). Third-party attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This project is not affiliated with the Alma or Herdr projects.
