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

**Model and context.** The model and reasoning effort come from the `settings` the desktop
reads out of the transcript itself, which is authoritative; the terminal's status line is
only a fallback for desktops too old to send them. Context usage has no other source and is
still parsed from the screen. An unrecognised line yields no chip rather than a guess.

**Background agents.** Subagents that have been dispatched and not yet finished are listed
for the current session, read from the transcript's tool rows. Opening one reads that
agent's own transcript — the desktop pages it by the tool-use id that dispatched it, and it
is the only way to see what a subagent actually did.

**Muting and restarting.** A session can be muted, and the list lives on the desktop, so
the desktop and any other device go quiet too. A stuck agent can be restarted from the
phone: the desktop quits its process tree, starts the same agent again, and optionally
hands it a prompt to continue with — all in the pane it was already in.

**Slash commands.** Typing `/` in the composer filters the commands the current agent
accepts, resolved per agent rather than from a Herdr API. Read-only and menu-opening
commands ship; anything that clears, compacts or rewinds a conversation is deliberately
left out.

**Connection.** An idle tunnel is probed every 20 seconds and is only declared dead after
10 seconds with no answer. No probe is sent while a request or an upload is in flight,
since a large attachment legitimately takes longer than that.

**Sending.** Messages go through `agent.prompt`; terminal input uses bracketed paste
followed by Enter. A request that was sent but never confirmed — a dropped tunnel, a
timeout, an HTTP error — is marked *uncertain* and is never retried automatically.
You check the transcript or terminal, then decide.

**Approval buttons.** A numbered menu drawn in the terminal becomes tappable. Before any
key is sent the terminal is re-read and the question, the option labels and the
highlighted row must all match; if anything changed the tap is cancelled and the screen
refreshes. Menus without a cursor or checkbox — plain numbered lists in agent output —
are never turned into buttons.

**Attachments.** Up to six files per message, 24 MB each, uploaded to the desktop over
the same tunnel and referenced by their absolute path. Images use the image route; other
files use the generic one. The ceiling is the tunnel, not Alma: an upload is one sealed
WebSocket message and the relay refuses anything over 32 MiB, so a larger file would fail
mid-transfer and be reported as an uncertain send rather than a refusal.

**New sessions.** Start Claude Code, Codex or pi in a directory of your choosing,
defaulting to the one you are already working in. It uses the phone bridge's allowlisted
`tab.create` + `agent.start` first, and falls back to `layout.apply` (which launches the
process by argv) only when that path genuinely is not available.

**QR pairing.** Scan the code from Alma's Remote Access screen, or paste the link.

**Local alerts.** A notification when an agent is waiting for you or has finished, based
on a status diff of the live connection. Nothing is uploaded and no push service is
involved.

The notifications are actionable: a waiting session offers Allow and Deny, a finished one
offers an inline reply. The buttons never replay a remembered option — tapping one re-reads
the terminal and resolves the row by its wording, and refuses (opening the session instead)
when the question changed, two rows could match, or the menu is a multi-select form.

**Background keep-alive.** By default the connection is held only while an agent is working, then the
service stops itself and nothing stays in the notification shade. "Always" (a standing
notification, subject to Android 15's six-hour cap) and "Never" are also available.

**Pairing from a link.** An `alma://connect` link in the system opens the app with the form
filled in, validated by exactly the same rules as a pasted one.

**Images in the conversation.** Pictures a transcript refers to are fetched through the same
encrypted tunnel and shown inline; a message still cannot make the web view reach the
network on its own.

**Display.** Markdown rendering with a per-session switch back to source, and language
and time zone that follow the system unless you override them.

## What it does not do

No remote desktop, no browser control, no client for Alma's own threads, no model or
provider configuration, and no cloud push. Chat history depends on the agent reporting a
native session id through its Herdr integration. A newly started agent has no id for a
moment and that is normal, so the message view stays open and says it is waiting; only
an agent that starts working — or gets a message — and still never reports an id is
reported as missing its integration. Refresh tokens, conversation history and agent
configuration are never stored on the phone beyond what the desktop sends.

## Weak networks

A phone loses its link constantly and silently, and a WebSocket that is dead can still
report itself open — the close event never runs when Android freezes the page, and a
Wi-Fi link can vanish without a FIN. Three things cover that:

- **Silence is a signal.** While the app is on screen, a tunnel quiet for eight seconds
  is probed with a short read on a three-second deadline. An answered probe resets the
  clock; an unanswered one rebuilds the tunnel. A dead link that used to take twenty
  seconds to show now takes about ten, and a healthy one is never probed at all because
  its own traffic proves it is alive.
- **Handovers redial.** The OS reports a Wi-Fi/cellular switch, which keeps the app
  "online" while invalidating every socket. The app redials immediately instead of
  waiting for a timeout, and the retry ladder restarts from the top.
- **A pocket costs nothing.** After the first few seconds a hidden app stops retrying
  entirely; coming back to the foreground, or the network returning, picks it up without
  the user tapping anything. A visible app keeps trying at a patient one-a-minute pace,
  indefinitely.

Uploads are limited to 24 MB for the same reason: the relay refuses a single WebSocket
message over 32 MiB, so a bigger attachment would fail half-way through.

## Requirements

- Alma desktop with Remote Access enabled, reachable over HTTPS
- Herdr running on that desktop
- A Herdr integration installed for the agent you want to follow
- To build: Node 22+, JDK 21, Android SDK 35

## Relays

The pairing link carries the relay address, so the phone needs no relay setup of its own:
whatever relay the desktop is configured to use is the one this client dials. With
end-to-end encryption on, which is the Alma default, the relay only ever sees ciphertext
and never the connect code.

Alma ships with a hosted relay at `relay.alma.now`. If you would rather keep traffic on
infrastructure you control — or want a region closer to you — you can run
[yetone/alma-relay](https://github.com/yetone/alma-relay) yourself. It deploys to
**Cloudflare Workers on the free plan** in a few minutes:

```bash
git clone https://github.com/yetone/alma-relay && cd alma-relay
npm install
npx wrangler deploy        # prints https://alma-relay.<you>.workers.dev
```

That uses SQLite-backed Durable Objects with WebSocket hibernation, so an idle pairing
costs next to nothing, and TLS plus a `*.workers.dev` hostname come with it. The same repo
also runs under Docker or behind your own reverse proxy if you prefer a VPS. Then point
the desktop at your relay under **Settings → Remote Access → Use a self-hosted relay** and
re-scan the pairing QR code: links created against the old relay do not carry the new
address.

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
  liveness.ts          When an idle tunnel is worth probing
  metrics.ts           Local stale-detection and retry counts
  network.ts           OS network changes, so a handover redials at once
  backoff.ts           Reconnect and session-refresh pacing
  attachments.ts       Upload helpers and message composition
  commands.ts          Per-agent slash commands offered in the composer
  subagents.ts         Running background agents, derived from transcript tool rows
  pending-link.ts      Staging and reading an alma://connect deep link
  session-info.ts      Model and context, parsed from the agent's status line
  notify.ts            Status diffing and local notifications
  keepalive.ts         Foreground service toggle
  drafts.ts            Per-desktop, per-session message drafts
  prefs.ts             Language, time zone, Markdown
  i18n.ts              English dictionary keyed by the Chinese source string
  App.tsx              Screens and components
android/               Capacitor shell
  HerdrVaultPlugin     Node credentials sealed with Android Keystore
  KeepAlivePlugin      Optional foreground service
  MainActivity         File chooser, camera grant, notification channel
client-tests/          Unit tests, Playwright flows, device probes
```

## Testing

```bash
npm test        # unit tests: crypto, frames, sessions, retries, prompts, prefs
npm run test:ui # every Playwright flow, page by page
npm run check   # unit tests, typecheck and a production build
npm run test:all # what a hand-over must pass: all of the above
```

**Run `npm run test:all` before handing over a build.** It chains the unit suite,
typecheck, build and every page's Playwright flow into one sequence, and stops at the
first failure with the name of the check that broke.

`npm run check` is the unit suite plus typecheck and build; the Playwright flows are a
separate command and are not part of it. CI runs `check` in one job and the flows in the
same required job, so neither half can ship alone.

The Playwright flows drive the real UI with a synthetic relay: they complete the
encrypted handshake, switch between desktops, send messages, answer an approval menu,
scan a generated QR code and toggle Markdown. They use synthetic pairing codes only and
never contact a real desktop. A `npm run test:live` probe does talk to a real desktop and
is read-only.

A guard test fails the suite if a Chinese UI string used through `t()` has no English
entry. It currently scans `App.tsx`, `controller.ts` and `transport.ts` only, so strings
in `ScanPairs.tsx`, `notify.ts` and `attachments.ts` are not covered by it.

## Security

- A pairing link grants full access to that desktop. It is masked in the UI, cleared
  after saving, never logged, and stored only in Keystore-encrypted storage under
  `noBackupFilesDir`; `allowBackup` is off.
- Only HTTPS relays are accepted, and cleartext traffic is disabled.
- Markdown from the model is rendered without raw HTML; images in the transcript are
  fetched through the tunnel, never by a plain URL load, so a message cannot make the app
  reach the network on its own.
- Transport failure ends every pending request; responses that arrive for a session you
  have since left are discarded by identity, not merged.

## Licence

MIT — see [LICENSE](LICENSE). Third-party attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This project is not affiliated with the Alma or Herdr projects.
