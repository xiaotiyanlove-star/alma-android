# LAN and relay routing

This note is the maintenance boundary for the connection path. A local
connection is only a faster route to the same paired desktop. It must never
disable or bypass the relay retry path.

## Required behavior

- A desktop with a known, verified LAN address is tried before the relay.
- A LAN attempt that cannot open or complete the E2E handshake falls back to
  the configured relay.
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
