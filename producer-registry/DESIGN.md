# ProducerRegistry v1 — Design Notes

**Branch:** `dev/producer-registry-v1`
**Status:** Deployed + verified on Midnight Preview, 2026-05-09
**Contract:** `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d`

## Why this contract exists

EBT v5 is custodial: PollPower's settlement-authority key in the EBT v5
contract can register any meter unilaterally. Compromise of that key can
fabricate producer earnings.

ProducerRegistry v1 moves the meter approval decision out of EBT v5 into
a dedicated contract whose only mutations require a 3-of-5 admin ring
co-signature using the v6 Ed25519 witness pattern.

EBT v5 itself is **untouched.** The settlement-api will be taught to
consult the registry before approving any settlement: "is meterX
approved?" → if not, refuse.

## Architecture

Single contract embedded multi-sig (federated cross-contract reads are
not yet a stable feature on the Midnight chain we deploy to).

State:
- `_admins: Set<Bytes<32>>` — 5 Ed25519 ring pubkeys
- `_threshold: Uint<8>` — currently 3
- `_nonce: Counter` — replay protection
- `_approvals: Map<Bytes<32>, Set<Bytes<32>>>` — actionHash → admins who approved
- `_meters: Set<Bytes<32>>` — approved meter keyHashes (slim build)
- `_initialized: Boolean`

Witness (off-chain Ed25519 verification):
- `signature_valid(pubkey, messageHash, signature) -> Boolean`

Circuits:
- `initialize(...)` — one-shot admin seeding + optional first meter
- `approve(actionHash, signerPubkey, signature)` — admin records approval
- `executeAddAdmin / executeRemoveAdmin / executeSetThreshold` — self-governance
- `executeAddMeter / executeRemoveMeter` — registry mutations
- Read circuits: `isAdmin`, `getThreshold`, `getAdminCount`, `getNonce`,
  `getApprovalCount`, `isApproved`, `isMeterRegistered`, `getMeterCount`

## Slim build vs fat build

The original "fat" build had a `MeterInfo` struct on chain
(`active`/`producerCoinPubkey`/`metadataHash`) plus an `executeUpdateMeter`
circuit. It compiled to 19-24MB of proving keys and **exceeded Midnight
Preview's per-deploy block limit** (`1010: Transaction would exhaust block
limits`).

The slim build stores only the meter keyHash in a `Set<Bytes<32>>`. Coin
pubkey + metadata stay in postgres. UpdateMeter dropped (use remove+add).
Total proving keys: 16MB. Deploys cleanly in 23s.

What we lose vs fat:
- Coin pubkey isn't pinned on chain (postgres is the source of truth)
- Metadata hash isn't on chain
- Updating a meter requires a 2-step ceremony (remove + add)

What we keep:
- The exact trustless property we wanted: PollPower-the-key cannot
  unilaterally add a fake meter. Council is the gate.
- Single-source-of-truth for "is meterX approved?" (anyone can query the
  contract and get the canonical answer)

## Action hash convention

For each multi-sig-gated mutation:
```
opSel = persistentHash(pad(32, "registry:<opName>"))
nextNonce = (_nonce.read() + 1) as Bytes<32>
actionHash = persistentHash([opSel, paramKeyHash, nextNonce])
```

Ring signs `actionHash`. Threshold-many admins approve, then anyone calls
`executeAddMeter(meterKeyHash)` (or matching execute*) — circuit
recomputes the hash, verifies threshold, applies the change.

Replay-protected via the nonce: each successful execute increments. An
old approved-but-not-executed actionHash becomes invalid once nonce moves.

## Deployment

| Item | Value |
|------|-------|
| Network | Midnight Preview |
| Contract | `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d` |
| Deployer wallet | reuses EBT v5 deployer seed (in `deployment.json`, gitignored) |
| Initial admins | 5 pilot-mock keys derived from `pollpower-pilot-mock-ring-{1..5}` (same convention as multisig v6 prod) |
| Threshold | 3-of-5 |
| Seed meter | sha256 of an initial pilot meter identifier — placeholder for the smoke test |
| Proving keys | 16MB total, 17 circuits |
| Deploy time | 23 seconds |
| Deploy cost | (TBD — track on next ceremony) |

Verified state (post-init):
```
getAdminCount → 5
getThreshold → 3
getMeterCount → 1
isMeterRegistered(timothy) → true
getNonce → 0
```

## Next steps

1. **Ceremony script** — `test-ceremony.ts` analog: have 3 of the 5
   pilot-mock admins approve an `addMeter` actionHash and execute it.
   Confirms the multi-sig path works end-to-end (not just the deploy +
   single-action seed).
2. **Settlement-api integration** — the only place v5 settlement happens
   today (`/api/producer/buy-energy` → settlement) gets a pre-flight
   check: load registry contract → `isMeterRegistered(meterKeyHash)`
   → reject if false. v5 EBT contract still mints; the registry is just
   a gate.
3. **Backfill** — Timothy is seeded with a placeholder keyHash. Before
   pilot-actual we need to: (a) compute his real meter keyHash from
   his hardware key, (b) ceremony-add the real keyHash, (c) the
   placeholder can stay (no harm) or be ceremony-removed.
4. **Real Tangem rings** — when hardware arrives, swap pilot-mock admins
   for real rings via `executeAddAdmin` + `executeRemoveAdmin`
   ceremonies.

## Files

- Contract: `producer-registry-v1.compact`
- Build artifacts: `build/`
- Deploy script: `deploy-registry.ts`
- Verify script: `verify-registry.ts`
- Deployment record: `producer-registry-v1-deployment.public.json` (in
  settlement-api root, alongside other deployment records)

## Costs of this design

- The fat build's UX of "registry contract IS the source of truth for
  producer coin pubkey" is gone. Postgres remains authoritative. We
  partially compensate by keying the registry on a SHA-256 of the
  hardware-derived meter ID (so the on-chain keyHash is unforgeable
  even if we ever lost postgres).
- Single contract means EBT v7 / future contracts can't "share" this
  governance — they'd need their own embedded multi-sig. That's fine
  for now; the multi-sig pattern is mechanical to copy.
- Cross-contract reads remain blocked by Midnight protocol; revisit
  when shipped.
