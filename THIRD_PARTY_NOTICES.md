# Third-Party Notices

## Alma Android (nanami-0713) — this fork's base

The Android shell and Capacitor project come from
[nanami-0713/alma-android](https://github.com/nanami-0713/alma-android),
pinned at `v0.4.213-21` (`121e3fcdc94b3d3c1caf6a076b8f7ae8d7272b73`).

MIT License, Copyright (c) 2026 yetone.

This fork replaces that project's bundled Alma renderer with an independently written
client under `client/`. The bundled renderer, its platform shims and the upstream release
scripts have been removed from this repository; nothing from them is shipped here.

## Alma Android (lazyeo)

`client/crypto.ts` is adapted from
[lazyeo/alma-android](https://github.com/lazyeo/alma-android)
(`src/relay/crypto.ts`, commit `932f9e73076e6d0e624cc42006d66f1dae22c821`).

MIT License, Copyright (c) 2026 lazyeo and contributors.

The E2E handshake, routing-token derivation, and AEAD framing in `client/transport.ts` were
written for this fork against the same wire protocol, with that file used as reference.

## Herdr

The Herdr name is used only to describe interoperability with [Herdr](https://herdr.dev).
No Herdr source code is included here.
