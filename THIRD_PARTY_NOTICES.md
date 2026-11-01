# Third-Party Notices

## Alma Android (nanami-0713) — this fork's base

The Android shell, platform bridge patches, and bundled Alma renderer in `www/` come from
[nanami-0713/alma-android](https://github.com/nanami-0713/alma-android),
pinned at `v0.4.213-21` (`121e3fcdc94b3d3c1caf6a076b8f7ae8d7272b73`).

MIT License, Copyright (c) 2026 yetone.

That repository states the bundled renderer is included with the Alma author's permission under
MIT. This fork does not extend that permission to anything outside its stated scope, and does not
claim that the Alma application is otherwise open source. The legacy `www/` renderer is kept
unchanged for reference and is not the entry point of the new client.

## Alma Android (lazyeo)

`client/crypto.ts` is adapted from
[lazyeo/alma-android](https://github.com/lazyeo/alma-android)
(`src/relay/crypto.ts`, commit `932f9e73076e6d0e624cc42006d66f1dae22c821`).

MIT License, Copyright (c) 2026 lazyeo and contributors.

The E2E handshake, routing-token derivation, and AEAD framing in `client/transport.ts` were written
for this fork against the same wire protocol, with that file used as reference.

## Herdr

The Herdr name is used only to describe interoperability with [Herdr](https://herdr.dev).
No Herdr source code is included here.
