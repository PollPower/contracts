# Findings status — ledger 9 migration (WI-16)

Branch `wi16-ledger9`. Last updated 2026-11-24.

This file tracks every audit finding that touches the contracts in the
Nov 30 scope (Multisig v6.2, TariffRegistry monolith, EBT v8, new Living
Dividend), plus anything new found during the ledger 9 migration. The
README "Audit" section is the historical record; this file is the current
state.

Status words used here:

- **Fixed (source)**: the fix is in the source on this branch. Not yet
  proven against a deployed ledger 9 contract.
- **Fixed (runtime)**: reproduced as fixed by running the compiled contract.
- **Open**: not fixed.
- **Superseded**: the contract that carried it is out of scope.

## Is `settle()` fixed in v8?

**The finding it was meant to fix is fixed; `settle()` is not safe.**
EBT-H-1 (mint target not bound in the HAT signature) is fixed in the source:
the signed payload now carries `producerAddr`. But two new findings let
anyone mint without any key: the HAT signature check is a prover-supplied
witness (WI16-C-1), and the owner check that guards producer attestation
uses `ownPublicKey()` (WI16-C-2). Do not deploy EBT v8 anywhere that matters
until both are fixed.

## Fix status (2026-11-24, branch `wi16-ledger9`)

| Finding | Status | Commits | Tests |
|---|---|---|---|
| WI16-H-1 | **Fixed**: constructor sets every authority (EBT v8 + ceremony, Multisig v6.2; Multisig v8 born that way) | `9a1d7c0` | `tests/contract/h1-constructor-init.test.mjs` |
| WI16-C-2 | **Fixed**: EBT owner = Jubjub key, in-circuit Schnorr over (contract, circuit, args, nonce) | `d170a9f` | `tests/contract/c2-owner-schnorr.test.mjs` |
| WI16-C-1 council | **Fixed**: Multisig v8 verifies secp256k1 in-circuit (no witnesses); EBT `execMultisigOp` and TR federation ops check `isApproved` by cross-contract call with their own replay records | `6e818e3`, `1f9cf27`, `de37277` | `c1-council-v8`, `c1b-ebt-council`, `c1b-tariff-council` (PoC replayed in each) |
| WI16-C-1 machine signers | **Fixed** (C-1c): EBT HAT `settle`, `manualReissue` co-sign, escrow attestor `redeem`; TR validator (`registerSchedule`) and operator (`retuneClass`) are Jubjub keys verified in-circuit, no witness. Off-chain signers (`meter-authority-service`) still to switch | `1e90910`, `a95e48b` | `c1c-ebt-machine-signers`, `c1c-tariff-signers` (PoC replayed in each) |
| WI16-E-1 (new, High) settle split not bound to the class | **Fixed**: settle must use the mirrored class shares for dividend / ops / DAO | `b236ea4` | `ld3-ebt-side` E-1 |
| WI16-E-2 (new, High) registry mirror rollback | **Fixed**: per-item monotonic `actionSeq` on every mirror write | `b236ea4` | `ld3-ebt-side` E-2a/b/c |
| WI16-E-3 (new, Medium) EventProof `actionSeq` unbound | **Fixed**: `actionSeq` must equal the leaf index encoded by the path bits | `b236ea4` | `ld3-ebt-side` E-3 |
| Gap C: manualReissue not council-gated (decision 2026-11-24) | **Fixed**: 2-of-3 council approval of `councilReissueHash` (every argument) in addition to the owner and meter-authority co-signatures; per-action replay record; owner signer (`tooling/owner/`) and co-sign endpoint (meter-authority-service `/reissue/v9`) | (EBT native-attestation commit) | `c1c-ebt-machine-signers` RC1-RC5, `owner-tooling` |
| HAT used `SIGN_HASH` (host picks the amount) (decision 2026-11-24) | **Fixed in contracts + services**: settle carries the chip's native attestation; the circuit asserts amount == floor(chip uWh / 1000); meter-authority-service accepts only native attestations; pp-settle-service uses `ATTEST`. Firmware still exposes `SIGN_HASH`: disable for settle use in the next revision | (EBT native-attestation commit), meter-authority-service, pp-settle-service `7aa0eaf` | `c1c-ebt-machine-signers` S3b/S3c/S8, `hat-v9.test.ts` P2 |
| Chip allowlist off-chain only; chip nonce replay off-chain only (questions 2026-11-24) | **Fixed**: council-gated on-chain chip registry enforced in settle (`CHIP_NOT_REGISTERED` / `CHIP_REVOKED` / `CHIP_BINDING_MISMATCH`); `_usedChipNonces` (`CHIP_NONCE_REPLAYED`) | (chip registry commit) | `chip-registry` CR-1..CR-6 |
| TR retire at epoch 0 (new, Low) | **Fixed**: retireSchedule / retireLane refused until the first epoch advance (`RETIRE_AT_EPOCH_ZERO`); encoding unchanged | (this commit) | `tr-retire-epoch0` |
| WI16-T-2 (new, High) TR `registerSchedule` front-run | **Fixed**: the approved hash now binds operator key id and reference rate; validator key pinned in the ledger | `a95e48b` | `c1c-tariff-signers` V3 |
| WI16-C-1 Living Dividend | **Open**: fixed by LD v3 | | |

Nothing here is deployed; no contract goes to any public network until all
rows are fixed (and council rotation, a Preprod gate, exists).

## Headline

**WI16-C-1 (new, Critical): every signature and council check in the four
Nov 30 contracts can be bypassed by any transaction submitter.** The checks
are `assert(disclose(<witness>(...)))`, and a witness is code the submitter
supplies. The Compact reference says so directly: "Any DApp may provide any
implementation that it wants for your witness functions. Results from them
should be treated as untrusted input."

Reproduced on Multisig v6.2 compiled with Compact 0.36.1 and run with
`@midnight-ntwrk/compact-runtime` 0.21.0, offline:

| Run | Witness | Signature | Result |
|---|---|---|---|
| Control | real Ed25519 verify (`@noble/ed25519`) | 64 zero bytes | rejected: `failed assert: Bad Ed25519 signature` |
| Attack | returns `true` | 64 zero bytes, against 3 admins' **public** keys | 3 approvals recorded; `_threshold` = 3 reached |

The proof a submitter generates only shows the circuit ran with *some*
witness value, so the network accepts the attack transaction the same way
it accepts an honest one. The attack was not run on any network.

PoC: `poc-multisig.mjs` in the session scratchpad (to be moved into
`tests/` once a fix exists, as the regression test that must fail).

### Affected call sites

| Contract | Circuits | Witness | What a forger gets |
|---|---|---|---|
| Multisig v6.2 | `approve` | `signature_valid` | council quorum on any action |
| TariffRegistry v1 | `consumeFederationApproval` (all federation-gated actions), `registerSchedule`, `retuneClass` | `multisig_signature_valid`, `signature_valid` | rewrite tariffs, statutory lanes, federation authority |
| EBT v8 | `settle` | `signature_valid` (HAT) | mint to any address. Needs an active producer attestation, which the attacker can create for itself through WI16-C-2 below. |
| EBT v8 | `redeem`, `manualReissue`, `execMultisigOp` (5 sites) | `signature_valid`, `multisig_signature_valid` | redeem without escrow attestation; reissue; change owner/HAT key/LD binding |
| LD v2.2.1 (basis for the new LD) | all council paths, member claims | `witness_multisigSignatureValid`, `witness_memberSignatureValid` | register/prune members, claim for any member |

`multisig_signature_valid(payload, authorityHash)` in EBT and the
TariffRegistry is not passed a signature at all: it is a prover-asserted
yes/no about whether the council approved, with no on-chain link to the
multisig contract.

EBT `settle` and the TariffRegistry/LD sites are confirmed by reading the
source, not by running them; they use the same `assert(disclose(witness))`
shape that the multisig PoC proves bypassable.

## WI16-C-2 (new, Critical): EBT v8 owner gate uses `ownPublicKey()`

`assertOnlyOwner()` (`ebt-v8.compact:345-351`) compares `ownPublicKey()`
with the stored `_owner`. `ownPublicKey()` is a witness; the Compact
security guide: "Never use `ownPublicKey()` for verification of the caller …
each user frontend is capable of producing a malicious return." `_owner` is
public ledger state, so anyone can pass the check.

Owner-gated circuits: `attestProducerOwnership`, `revokeProducerOwnership`,
`claimSplit`, `execOwnerOp`, `manualReissue`, `mirrorActionLogRoot` (the
last removed by fix #5, registry-root anchor, branch `wi16-fix5`).

Combined with C-1 this is an **unprivileged mint**: self-attest a producer
via `attestProducerOwnership`, then `settle` with a lying HAT witness to any
`producerAddr`. Confirmed by source; not yet run. Multisig v6.2, the
TariffRegistry and LD v2.2.1 do not use `ownPublicKey()`.

## WI16-H-1 (new, High): EBT v8 `initialize` can be front-run

`initialize` (`ebt-v8.compact:~510-540`) is exported, guarded only by
`!_initialized`, and makes **the first caller** the owner while setting the
HAT key, multisig authority, recipients and escrow attestor. Anyone watching
the chain can call it between the deploy and the ceremony's initialize
transaction. The TariffRegistry closed the same window in PR #50 by sealing
its authority in the constructor; EBT v8 should do the same.

### Why the design missed it

`multisig/v6-DESIGN.md` (lines 88–90, 141) reasons that "the prover" is the
admin's own device, so lying only lets a compromised admin sign as
themselves. On Midnight the prover is whoever builds the transaction, and
anyone can build one. The repo's hard rule "witness pattern for signature
verification, never in-circuit" encodes the same assumption.

### Fix options (decision needed — see docs/STATUS.md)

1. **On-chain council state via ledger 9 cross-contract calls.** EBT,
   TariffRegistry and LD call the multisig contract to check that an action
   reached quorum, instead of asking a witness. Removes
   `multisig_signature_valid` entirely. Still needs (2) or (3) inside the
   multisig itself.
2. **In-circuit signature verification on Jubjub (Schnorr).** Compact can
   verify these in-circuit (`ecMul`/`ecAdd`; the official zk-loan example
   does it). Cost: larger circuits, and signers must hold Jubjub keys — the
   Tangem rings sign Ed25519, so they would need a different scheme or a
   bridging device.
3. **Hash-preimage authorization** (the pattern in the Compact security
   guide): each signer proves knowledge of a secret whose hash is registered.
   Cheapest in-circuit, but the secret must be on the proving device, which
   rules out hardware that only signs.
4. **Accept and contain for the Buildathon only**: deploy as-is to Preprod,
   label the authorization model as a known gap, no real value at stake.
   Not acceptable for anything holding real value.

## Audit findings in scope

| ID | Severity | Finding | Status on `wi16-ledger9` |
|---|---|---|---|
| **WI16-C-1** | Critical | Signature/council checks trust prover-supplied witnesses (above) | **Open** — confirmed (multisig, runtime); confirmed by source (EBT, TariffRegistry, LD) |
| **WI16-C-2** | Critical | EBT v8 owner gate trusts `ownPublicKey()` (above) | **Open** — confirmed by source |
| **WI16-H-1** | High | EBT v8 `initialize` front-runnable; first caller becomes owner (above) | **Open** — confirmed by source |
| EBT-H-1 | High | `producerAddr` not bound in HAT payload → mint redirection | **Fixed (source)** for the binding: `ebt-v8.compact:975-982` hashes the 5 fields (`sessionID`, `hatPubkey`, `amount`, `producerKey`, `producerAddr`) under domain `pollpower:ebt:v8:epoch1`, and still compiles under 0.36.1. **But the signature check over that hash is the bypassable witness in WI16-C-1**, so `settle` is not safe until C-1 is fixed. |
| EBT active-attestation (2026-07-07 medium) | Medium | `settle` must reject a de-federated producer | **Fixed (source)**: `ebt-v8.compact:992-993` asserts membership **and** `.active`. README still lists it as tracked; update when C-1 lands. |
| C-1 | Critical | Producer unauthenticated in v5.1 `settle` | Superseded (v5.x out of scope); its successor is EBT-H-1. |
| H-1 / AUTH-H-1 | High | Pilot-mock admin keys publicly derivable | **Open** — Tangem swap is Garrett's manual ceremony. Note: while C-1 is open, real keys don't help, because no key is needed. |
| H-3 | High | Multisig v6 admin set uncapped vs fixed threshold | **Fixed (source)** in v6.2: `MAX_ADMINS` = 7 cap in `executeAddAdmin`, threshold raised atomically with admin count, majority floor at `initialize` (v6.2 header, Fixes 1–3). Compiles clean under 0.36.1 (12 circuits). Not runtime-tested on this branch. Moot while C-1 lets anyone reach quorum. |
| M-2 | Medium | Ed25519 messages lack domain separation | Mitigated at the actionHash layer (contract address in preimage). Unchanged. Moot while C-1 is open. |
| M-4 | Medium | `manualReissue` uncapped / single-key | Cap (1,000,000 per call) and 1-hour cooldown present in v8 (`manualReissue`). Its owner check is WI16-C-2 and its co-signature is a C-1 witness, so the "single-key" half is not actually fixed. |
| L-3 | Low | Timestamps hardcoded | **Fixed (source)**: `settle` uses stdlib `blockTimeGte` (`ebt-v8.compact:970`). |
| LD-C-1 | Critical | LD time gates trusted a prover-controlled `witness_blockTimeGte` | **Fixed** in LD v2.2.2 (`settlement-api` commit `b50ee4d`, PR #5): stdlib `blockTimeGte`. A real fix of the same bug class as C-1. Carried into LD v3. |
| LD-H-3 | High | `bumpOnMint` unauthenticated | **Not fixed.** v2.2.2 (`dded75e`, PR #6) adds a keeper signature, but checks it through `witness_multisigSignatureValid`, a C-1 witness, so any caller still passes. LD v3 removes `bumpOnMint` entirely (accrual is read from EBT): see `docs/design/living-dividend-v3-design.md`. |
| **WI16-T-1** | Medium (test gap) | JS mirror `tests/lib.mjs` encoded integers big-endian; the circuit's `(x as Field) as Bytes<32>` is little-endian, so mirror tests on integer fields only checked themselves | **Fixed** (`b31e164`): mirror now little-endian, proven by parity test EBT-2. Live ceremony tooling was already correct. V2-split tooling (out of scope) is still big-endian. |

## Ledger 9 compile status (Compact 0.36.1, language 0.28.0, runtime 0.21.0)

| Contract | `--skip-zk` | Circuits | Source change needed | Full ZK |
|---|---|---|---|---|
| `ebt/ebt-v8.compact` | ✅ | 18 | pragma only (committed `c4a5240`) | ✅ the node host, 6 m 16 s; deploy needs the ceremony fence (84% of block) |
| `ebt/ebt-v8-ceremony.compact` | ✅ | 8 | pragma only (committed `c4a5240`) | ✅ the node host, 4 m 01 s; deploy fits (36% of block) |
| `multisig/multisig-v6.2-ed25519.compact` | ✅ | 12 | pragma only (committed `b7dfc89`) | not run |
| `tariff-registry/tariff-registry-v1.compact` | ✅ | 18 | pragma only (committed `b7dfc89`) | not run |
| `tariff-registry/tariff-registry-v1-ceremony.compact` | ✅ | 18 (11 stubs) | pragma only (committed `b7dfc89`) | not run |

### C-1 / C-2 / H-1 pattern check per contract

| Contract | C-1 (witness-trusted signatures) | C-2 (`ownPublicKey()` gate) | H-1 (first-caller init) |
|---|---|---|---|
| EBT v8 | present (`settle`, `redeem`, `manualReissue`, `execMultisigOp`) | **present** (6 circuits) | **present** (`initialize`) |
| Multisig v6.2 | present (`approve`) | absent | **present** (`initialize` installs the admin set for the first caller) |
| TariffRegistry v1 | present (`consumeFederationApproval`, `registerSchedule`, `retuneClass`) | absent | absent (constructor-seeded; `bootstrapActionLog` is open but deterministic) |
| LD v2.2.1 / v2.2.2 | present (all council and member paths, incl. the LD-H-3 keeper gate) | absent | absent (constructor) |

### Parity of compiled 0.36.1 contracts with the TypeScript side (`npm run test:parity`)

| Test | Checks | Result |
|---|---|---|
| TR-1 | TariffRegistry empty action-log root + all 24 zero levels vs JS mirror and the compact-runtime builder (mirror daemon / ceremony) | pass |
| EBT-1 | EBT attestation key computed in JS is accepted by the circuit; a wrong key is rejected | pass |
| EBT-2 | EBT `settle` HAT payload hash (captured from the circuit) vs `ceremony.mjs` builder and JS mirror `signHat` | pass after fixing WI16-T-1 |

Fix designs: [`docs/design/WI16-auth-fix-design.md`](design/WI16-auth-fix-design.md).

`compact fixup --check` reports whitespace-only changes for all five, and the
compiler emits no warnings. A clean compile does not show that hashes and
encodings still match the off-chain tooling; that needs the offline test
suites on Midnight.js 5.
