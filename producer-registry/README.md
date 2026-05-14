# ProducerRegistry v1

**Address (Midnight Preview):** `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d`
**Deployed:** 2026-05-09
**Status:** ✅ **PRODUCTION** — gates every EBT v5 settlement via off-chain pre-flight check (live since 2026-05-09 09:08 UTC)

## What it does

The on-chain registry of producers approved to receive EBT mints. No EBT can mint to a producer who isn't in this registry.

Modification of the registry — adding a producer, removing a producer, rotating the Meter Authority key — requires a **3-of-5 council Ed25519 multi-signature** verified in-circuit. No single party, including PollPower, can modify the registry alone.

## How it integrates with the mint path

The `settlement-api` performs a pre-flight check before every `EBT.settle()` call: it queries `ProducerRegistry.isProducerRegistered(producer)` and refuses to attempt the mint if the answer is false.

This means **under the current architecture, PollPower-the-key cannot add a fake producer to the registry and then mint to it**. Adding a producer requires three of the five council keys to co-sign the action, and the action is verified in-circuit by `executeAddProducer`.

## Trust caveat — pilot-mock admins active

⚠️ **CRITICAL: see [STATUS.md](./STATUS.md).**

The 5 admin keypairs currently registered on this contract are derived from public seed strings, not real Tangem rings. The 3-of-5 multi-sig is architecturally correct but operationally controlled by anyone with access to the seed derivation. This is a deliberate pilot-stage choice for Midnight Preview; the ceremony to swap real hardware keys is documented.

The architectural claim "the registry is governed by 3-of-5 admin ring co-signature" is structurally true of the deployed contract. The operational reality is that the pilot-mock seeds are public.

This contract is currently a **demonstration of the trustless rail**, not the trustless rail itself.

## Design

See [`DESIGN.md`](./DESIGN.md) for the full architectural intent.

## Verifying contract state

Anyone can query the live contract for:

- `getAdminCount()` — number of registered admins
- `getThreshold()` — multi-sig threshold (currently 3)
- `getMeterCount()` — number of registered producers/meters
- `isMeterRegistered(<keyHash>)` — whether a specific meter is approved
- `isAdmin(pubkey)` — whether a specific pubkey is in the admin set
- `getNonce()` — current nonce (replay protection)

Use any Midnight Preview indexer or node-RPC to read this state without trusting any off-chain source.
