# LAN and relay routing

This note is the maintenance boundary for the connection path. A local
connection is only a faster route to the same paired desktop. It must never
disable or bypass the relay retry path.

## Required behavior

- A desktop with a known, verified LAN address is tried before the relay.
- A known address only suppresses the search while the tunnel is actually using
  it. On the relay, the desktop is asked again — otherwise a stale address
  (moved desktop, changed network, suspended path) pins the session to the
  relay with nothing left to notice.
- A LAN attempt that cannot open or complete the E2E handshake falls back to
  the configured relay.
- The subnet gate is consulted with a deadline. A gate that never answers must
  cost the relay nothing: the timeout is read as "not verified", the plain-text
  dial is skipped, and the relay is dialled immediately.
- A relay failure starts LAN discovery independently of the retry timer.
- A relay failure while the app is visible continues the existing retry ladder;
  LAN discovery is an additional recovery path, not a replacement.
- An error state caused by a failed relay does not wait for the normal idle
  discovery interval before the LAN search starts.
- A LAN search only scans while the app is visible and the user has enabled LAN
  discovery. Hidden apps do not scan.
- A discovered address is used only after its device is on a subnet reported by
  `LocalNetworkPlugin`, it is not already claimed by another paired desktop,
  and it proves possession of this pairing's confirmation key.
- A network handover aborts old scans and clears stale addresses and breakers.
- The relay address and pairing credential come from the pairing link. The LAN
  path never changes either.

## Deadlines and verdicts

Three rules exist because their absence each caused a permanent failure, and
none of them widens what may be dialled:

- **Every bridge wait has a ceiling.** `withDeadline` in `client/deadline.ts`
  backs both `deviceSubnets()` and the transport's `allowDirect` gate. A native
  callback lost while the page is frozen used to leave a promise pending
  forever; because the gate is awaited before the relay is dialled, that became
  "encrypted connection timed out" on every reconnect until the app restarted.
- **A path suspension is short and in memory.** `client/breaker.ts` holds the
  verdict for three minutes in a map, not in `localStorage`. A persisted
  half-hour suspension, combined with a cached address, kept a session on the
  relay for the rest of the day and survived a restart.
- **One runtime, one dial.** `Runtime.connecting` makes `connectHost` single
  flight. The return-to-foreground path used to dial twice — `resume` and then
  `retryStopped` — which opened two sockets, sent two `/api/herdr/info`, and let
  the losing subscription be closed under the winner.

## Returning to the app

`client/lifecycle.ts` no longer replaces the tunnel on a timer. A return asks the
open socket a question (`verify`); only a release (`suspend`, after 30 minutes
hidden) leads to `resume`. Guessing from elapsed time meant every return after a
minute tore down a working connection, which cost a route transition to the
relay and a session reload.

## Do not change without a new security review

- The P-256/HKDF/AES-GCM handshake and pairing confirmation in `transport.ts`
  and `crypto.ts`.
- Relay URL construction.
- The same-subnet gate in `lan.ts`, `localnet.ts`, `LocalNetworkPlugin.java`,
  and `transport.ts`.
- The rule that a LAN candidate must prove the pairing identity.

## Verification basis

`client-tests/lan-routing.test.ts` covers relay-failure discovery, throttling,
address ownership, network changes, and the production failure scheduler.
`client-tests/transport.test.ts` covers direct-first dialing, LAN-to-relay
fallback, silent-LAN timeout, handshake rejection, and relay fallback.
`client-tests/connection-recovery.test.ts` covers the three permanent failures
above: an unanswered gate, a double dial on return, and a search suppressed by a
stale address. `client-tests/deadline.test.ts` pins the deadline helper, and
`client-tests/breaker.test.ts` pins the in-memory, short-lived suspension.

## User-visible states

- `lan` means the active tunnel reached the paired desktop directly.
- `relay` means the tunnel is using the pairing link's HTTPS relay.
- A route transition is a connection transition: in-flight reads can fail and
  mutations that were sent but not acknowledged remain uncertain. The client
  reconnects the same session rather than replaying a mutation.
- LAN discovery is best effort. It does not promise that every private network
  permits client-to-client traffic, and it never turns a failed direct probe
  into a permanent relay outage.
