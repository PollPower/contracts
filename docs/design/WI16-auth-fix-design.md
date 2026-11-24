# WI-16 authorization fix design: C-1, C-2, H-1

Branch `wi16-ledger9`. Status: **proposal, awaiting Garrett's approval. Nothing
here is implemented in the contracts.** No contract goes to any public network,
Preprod included, until these are fixed (Garrett, 2026-11-24).

Findings: [`docs/findings-status.md`](../findings-status.md).

## Summary

| Finding | Fix | Contracts | Effort |
|---|---|---|---|
| **C-1** signature/council checks trust prover witnesses | (a) Council members sign with **secp256k1 ECDSA**, verified in-circuit by the stdlib `secp256k1EcdsaVerify` inside the multisig `approve`. (b) Consumers (EBT, TariffRegistry, LD) ask the multisig **`isApproved(actionHash)` through a ledger 9 cross-contract call** and keep their own consumed-action set. (c) Machine signers (Meter Authority HAT, escrow attestor, schedule operators) sign with **Jubjub Schnorr**, verified in-circuit by the stdlib `jubjubSchnorrVerify`. | Multisig v6.2 → v7-L9, EBT v8 → v9, TariffRegistry v1 → v2, LD → v3 | 7–9 dev-days |
| **C-2** EBT owner gate uses `ownPublicKey()` | Owner proves a key **in-circuit**. Recommended: Jubjub Schnorr signature over the action (owner public key stored at deploy). Alternative: hash-preimage identity (owner secret as a private circuit argument). | EBT | 1 dev-day |
| **H-1** first-caller `initialize` | Delete the exported `initialize`; set every authority in the **constructor** (deploy transaction). Immutable values become `sealed`. | EBT, Multisig v6.2 | 1 dev-day |
| Tests, tooling, ceremony | Parity + negative tests for each fix; ceremony scripts and signers ported; local-devnet end-to-end run before any public deploy | all | 3–4 dev-days |

**Total: 12–15 dev-days** for the four contracts with tests and a devnet
end-to-end run. **Nov 30 is 6 days away**, so the full set does not fit; see
[Schedule options](#schedule-options).

## What the spike established (throwaway, scratchpad; Compact 0.36.1)

Every mechanism below compiles under 0.36.1 (full ZK where sizes are given):

| Mechanism | Spike circuit | Proving key | Verifier key (on chain) |
|---|---|---|---|
| Jubjub Schnorr, stdlib `jubjubSchnorrVerify` | `settleSchnorr` (HAT over 4 fields) | 2.1 MB | 1,593 B |
| Jubjub Schnorr, zk-loan polyfill | `settle` (5 fields) | 4.2 MB | 1,593 B |
| secp256k1 ECDSA, stdlib `secp256k1EcdsaVerify` | `approveEcdsa` (council) | 117 MB | 2,745 B |
| Hash-preimage identity (`persistentHash(domain, sk)`) | `ownerOp`, `approve` | 11.3 MB | 2,121 B |
| Cross-contract `council.isApproved(h)` + local consumed set | `execMultisigOp` | 0.2 MB | 1,353 B |
| `kernel.caller()` == LD contract, then mint | `mintDividend` | 0.4 MB | 1,353 B |

For comparison, EBT v8 today: `settle` proving key 86 MiB, verifier keys
1,353–2,121 B. **No fix grows a verifier key beyond 2,745 B**, so the
ceremony-fence deploy plan stays valid (one insert ≈ 4.5% of a block).

Not yet proven: run-time and on-chain behaviour of cross-contract calls (two
calls to the same callee in one transaction; a mint inside a callee). The plan
puts a local-devnet end-to-end run before any public deploy.

---

## C-1: authorization that is checked in the circuit

### Rule

After this change, no `assert` in a PollPower contract depends on a witness that
returns a yes/no. Witnesses may still supply *data* the circuit then checks
(Merkle paths, division quotients, Schnorr challenge reductions, signatures),
which is the safe use. Each remaining witness gets a one-line comment saying
what the circuit checks about its output.

### C-1a: council approvals (Multisig v6.2 → Multisig v8)

Named **v8** (`multisig/multisig-v8-secp256k1.compact`) because v7 is the live
Preview Ed25519 contract.

- Admin keys are **secp256k1 public keys**, set in the constructor (H-1).
  **Confirmed 2026-11-24: council keys can stay on the Tangem rings** (see
  "Tangem ring test" below).
- **Constructor** (decided 2026-11-24; council make-up still to be confirmed
  by Garrett, devnet uses 3 test keys at 2-of-3):
  `constructor(adminPks: Vector<7, Secp256k1Point>, adminCount: Uint<8>, threshold: Uint<8>)`.
  Slots `0..adminCount-1` are the council; later slots are ignored. Asserts:
  `1 ≤ adminCount ≤ 7` (H-3 cap), `0 < threshold ≤ adminCount`, strict majority
  (`2·threshold > adminCount`), and **no key twice** (each key's
  `persistentHash` goes in a set; a duplicate would let one ring count twice).
  Admins are addressed by slot index.
- **Approval** `approve(actionHash, adminIndex, sig: Secp256k1EcdsaSignature)`:
  `digest = persistentHash([pad("pp:ms:v8:approve"), kernel.self().bytes, actionHash, epoch])`,
  `assert(secp256k1EcdsaVerify(digest, sig, adminPk[adminIndex]))`. The contract
  address keeps M-2's domain separation; `epoch` is the council generation
  (0 until a rotation, see below). The ring signs `digest` as given.
  `approvalDigest(self, actionHash, epoch)` is an exported pure circuit so the
  admin app computes exactly the same bytes.
- **Approvals are recorded per `(actionHash, adminIndex)`** under the current
  epoch, never per signature: the circuit accepts both `(r, s)` and
  `(r, n−s)`, so signature bytes are not unique. A second approval by the same
  slot is rejected.
- Witness-free `isApproved(actionHash): Boolean` (approvals in the current
  epoch ≥ threshold). Witness-free is required: a circuit reached by a
  cross-contract call may not call witnesses. The contract has **no witnesses
  at all**.
- No generic `execute`: replay protection lives in each consumer (C-1b), so
  an approval is consumed where it is used.
- Cost: ~117 MB proving key per approval, ~2.7 KB verifier key. Approvals are
  rare council actions, so this is acceptable.

#### Council rotation: sealed for the Nov 30 demo, **required before Preprod**

Decision (Garrett, 2026-11-24): the council is sealed (no rotation circuits)
for the Nov 30 devnet demo. **Preprod gate: no Preprod deploy until the
council is rotatable as below.**

Rotation is in place (same contract address), so EBT, TariffRegistry and LD
keep their sealed `_council` reference.

1. **Propose.** `rotationHash = persistentHash([pad("pp:ms:v8:rotate"), self,
   epoch, keyIds…, adminCount, threshold])` over the complete new council
   (all slots, count and threshold, so the H-3 bounds are checked on the
   whole new set).
2. **Approve.** Admins approve `rotationHash` with `approve()`, recorded per
   `(rotationHash, adminIndex)` under the current epoch like any other action.
3. **Schedule.** Once the current threshold is reached, anyone calls
   `scheduleRotation(newCouncil…)`; the contract recomputes the hash, checks
   `isApproved`, and records `readyAt = blockTime + ROTATION_DELAY` (block-time
   validated, L-3).
4. **Execute.** After `readyAt`, anyone calls `executeRotation(newCouncil…)`:
   the hash must match the scheduled one, then the keys, count and threshold
   are replaced and **`epoch` increments, which invalidates every outstanding
   approval** (approvals and digests are keyed by epoch, so a removed admin's
   earlier approvals no longer count).
5. **Cancel.** A council-approved `cancelRotation(rotationHash)` before
   execution.

**`ROTATION_DELAY`: 72 hours (approved by Garrett, 2026-11-24).** Reasons: the council spans JST and
EAT, and 72 h gives every member at least one working day to see a pending
rotation even across a weekend; it is long enough for Joi's monitoring and the
dependent apps to alert, and short enough that replacing a lost or
compromised ring doesn't leave the council degraded for long. A single
compromised key cannot rotate anything on its own (threshold ≥ 2 for any
council of 3 or more); the delay protects against a mistaken or coerced
threshold approval, since the honest majority can cancel within the window.
Cost: one extra secp256k1-free circuit pair (schedule/execute) and a
`cancelRotation`; no change to `approve` or `isApproved`, because the epoch is
already in the approval layout from the demo version.

#### Council make-up and standby (decided 2026-11-24)

- **Council: 2-of-3**, three members each holding their own Tangem ring
  (secp256k1 wallet). Constructor at the Preprod deploy:
  `adminCount = 3, threshold = 2`, slots 0–2 = the three ring keys, slots 3–6
  filler.
- **Standby:** one further ring holder is the pre-agreed replacement if a
  member's ring is lost or a member leaves. The standby is **not a council
  member and has no on-chain role** until rotated in.
- **Records are off-chain.** Which ring belongs to whom, the card IDs and the
  collected public keys live in the council-keys file kept outside every
  repository (on throne: `%UserProfile%\PollPower-council\council-keys.json`),
  never in this repo or on chain beyond the public keys in the constructor.
- **Devnet:** 2-of-3 test keys until the real rings are scanned; the real keys
  go into the constructor only at the Preprod deploy.
- **Ring readiness** before the Preprod deploy: every member's and the
  standby's ring holds a secp256k1 wallet, checked with the admin app's ring
  test, and each public key is verified with a signature (as in the
  2026-11-24 test) before it is written into the council-keys file. No
  permanent key is created on a ring without Garrett's approval.

**Standby procedure (one ring lost, or a member leaves):**

1. The holder (or any member) reports it to the council at once. A lost ring
   alone cannot approve anything: it needs its access code, and 2-of-3 needs a
   second ring.
2. Confirm the standby ring's secp256k1 public key against the council-keys
   file (re-run the ring test if it hasn't been verified recently).
3. Build the new council: the standby key takes the departing member's slot;
   the other slots, `adminCount = 3` and `threshold = 2` stay the same.
4. **The two remaining members both approve** the rotation hash (2-of-3).
5. Anyone schedules the rotation; **the 72-hour delay applies**. During the
   window either remaining member can still have it cancelled with a
   council-approved cancel if something is wrong.
6. After the delay, anyone executes it. The epoch increments, so any approval
   the lost ring gave before the change no longer counts. Update the
   council-keys file (standby → member, departing ring retired) and tell Joi.

Risk to know: from the loss until the rotation executes, the council runs on
exactly two rings and needs both. If a second ring is lost in that window the
council cannot act (no recovery path in v8). Mitigation: start the procedure
immediately; a second standby or a higher council size would remove this,
at the cost of more rings to manage.

A member who leaves on good terms follows the same steps; their ring can still
be one of the two approvals, but the rotation should not rely on it.

#### Tangem ring test (2026-11-24): PASS

A real Tangem ring signed the test digest
`1f530333927aed3cadebc75edb1d176c3335015006bb8af0600c83cabd713176` with its
secp256k1 wallet through the admin app's ring test screen (monorepo
`wi16-ledger9`, `e77521b`/`f2d77c0`).

| Property | Ring behaviour | What the tooling and contract must do |
|---|---|---|
| Public key format | **Compressed SEC1, 33 bytes** (`02`/`03` ‖ x). `publicKey` = `walletPublicKey` | Decompress off-chain to `Secp256k1Point {x, y, identity: false}` for the constructor / admin set |
| Signature encoding | **Raw r ‖ s, 64 bytes** (big-endian), no DER, no recovery byte | Split into `{r, s}`; no DER parsing needed. The parser still accepts DER and 65-byte r‖s‖v |
| Hashing | Signs the 32 bytes **as given** (no prehash) | The circuit's digest goes to the ring unchanged |
| S value | **Low-S** on this signature | Nothing: the circuit accepts high-S as well (pinned by test), so normalisation can't fail a council approval |

Verified three ways: `@noble/curves` (with and without the low-S rule); the
compiled `secp256k1EcdsaVerify` circuit (as given, low-S and high-S forms);
and **on the local ledger 9 devnet with a real proof**: `verifyAndRecord`
accepted on chain (tx `00ad83ae…406228`, block 627), and a wrong digest was
rejected.

Design consequences:
- Because the circuit accepts both `(r, s)` and `(r, n−s)`, a signature is not
  unique. **Approvals must be recorded per `(actionHash, adminIndex)`**, never
  per signature bytes, or one admin could approve twice.
- The council public keys are read from the ring once (scan) and placed in
  the constructor; the ring itself never leaves the admin.

Fallback (no longer needed): council keys as Jubjub Schnorr on the admin
phones, with Tangem dropped from the on-chain path.

### C-1b: consumers of council approval (EBT, TariffRegistry, LD)

Replace `assert(disclose(multisig_signature_valid(payload, authorityHash)))`
with:

```compact
contract Council { circuit isApproved(actionHash: Bytes<32>): Boolean; }
export sealed ledger _council: Council;          // set in the constructor
export ledger _consumedActions: Set<Bytes<32>>;

circuit requireCouncil(actionHash: Bytes<32>): [] {
  const h = disclose(actionHash);
  assert(!_consumedActions.member(h), "action already executed");
  assert(_council.isApproved(h), "council has not approved");
  _consumedActions.insert(h);
}
```

- Each consumer computes `actionHash` with its own domain tag and
  `kernel.self()`, so an approval for one contract or action cannot be reused
  on another.
- Replay protection lives in the consumer. Nobody else can burn an approval.
- `_council` is sealed in the consumers. Council membership rotates inside
  Multisig v8 (same address, see "Council rotation"), so consumers never need
  a `setCouncil`.

### C-1c: machine signers (HAT, escrow attestor, schedule operators/validators)

**Implemented 2026-11-24** (EBT v8 + ceremony, TariffRegistry v1 + ceremony).
No `signature_valid` witness is left in either contract. Each signer holds a
**Jubjub** key; the contract verifies `jubjubSchnorrVerify<1>([m], sig, pk)`
in-circuit, where `m` is the Field returned by an **exported pure circuit**.
The signing services call that circuit from the compiled contract (or rebuild
it from the layout below; parity test EBT-2 checks an independent rebuild).

| Signer | Key held in | Signs | Layout of `m` (`transientHash<Vector<n, Bytes<32>>>`, integers little-endian) |
|---|---|---|---|
| Meter authority, HAT (`settle`), countersigning the chip's native attestation | EBT `_meterAuthorityPubkey: JubjubPoint` (owner rotates, `execOwnerOp` op 1) | `hatMessage` | `pad("pollpower:ebt:v9:hat"), self, recordDigest, chipPubkey, chipSigR, chipSigS`; `recordDigest = settleRecordDigest(self, sessionID, amount, producerKey, producerAddr.bytes, meterKeyHash, chipHwId, chipSessionUwh, chipUptimeMs, chipNonce)` (`pad("pollpower:hat:record:v1")`, Vector<11>); the circuit also asserts `amount == floor(chipSessionUwh / 1000)` |
| Meter authority, reissue co-signature (`manualReissue`) | same key | `reissueMessage` | `pad("pollpower:ebt:v9:reissue"), self, producerKey, producerAddr.bytes, amount, seq` (`seq` = `reissuanceCount`) |
| Escrow attestor (`redeem`, KES) | EBT `_escrowAttestorPubkey: JubjubPoint` (council rotates, op 4) | `escrowMessage` | `pad("pollpower:ebt:v9:escrow"), self, trustFloat, outstandingEbt, attestationEpoch` |
| Schedule validator (`registerSchedule`) | TR `_validatorPk: JubjubPoint` (constructor; council rotates with `setValidator`) | `signerMessage(registerScheduleActionHash(...))` | `pad("pp:tariff:v2:signer"), digest` |
| Schedule operator (`retuneClass`) | schedule record stores `operatorKeyId(pk)`; caller passes `pk` | `signerMessage(retuneAuthHash(...))` | as above |

Changes beyond swapping the signature scheme, all found while writing the
attack tests:

- **TR front-run (new, High, fixed):** the council-approved
  `registerSchedule` hash left out `operatorPubkey` and `refRateFiatPerKwh`,
  and the "validator" key was a free argument. Whoever submitted an approved
  registration first chose the schedule's operator (the key that may retune
  its splits) and its reference rate. Shown on the old build: a front-runner
  registered with its own operator id and a 10× rate, using an approval the
  council gave for another operator. Now `registerScheduleActionHash` binds
  both, and the validator key is pinned in the ledger.
- **Reissue co-signature** bound only `(producerKey, amount, seq)`; the
  recipient address and the contract were free. It now binds both.
- **HAT** also binds `meterKeyHash` and the contract address. `settle` no
  longer takes `hatPubkey`: the key is the ledger's.
- **Escrow attestation** binds the contract address.
- Domain tags bumped (`pollpower:ebt:v9:*`, `pp:tariff:v2:*`), so nothing
  signed for the old contracts verifies.
- A degenerate key cannot be used to forge signatures: the stdlib verifier
  refuses the identity point ("JubjubPoint identity is not a permitted
  jubjubSchnorrVerify verifying key"), and the order-2 point fails too
  (checked with a forged signature against both).

Interface changes (callers must follow):

- EBT constructor: `meterAuthorityPubkey` and `escrowAttestorPubkey` are
  `JubjubPoint`. `execOwnerOp` op 1 and `execMultisigOp` op 4 take
  `JubjubPoint`; `ownerDigest_execOwnerOp` and `councilActionHash` hash both
  coordinates.
- `settle(sessionID, amount, producerKey, producerAddr, meterKeyHash,
  hatSig: JubjubSchnorrSignature, ...)`; `redeem(..., attestationSig:
  JubjubSchnorrSignature, ...)`; `manualReissue(..., authoritySig:
  JubjubSchnorrSignature, ownerSig)`.
- TR constructor: `(council, governanceRoot, refRateFiatPerKwh,
  validatorPk)`. `registerSchedule(nodeId, scheduleHash, operatorKeyId,
  refRate, effectiveEpoch, validatorSignature, currentTime)`;
  `retuneClass(..., operatorPk: JubjubPoint, operatorSignature, ...)`; new
  `setValidator(newValidatorPk, currentTime)` (council-approved
  `setValidatorActionHash`).

### HAT trust model (Garrett, 2026-11-24: option 3 + native attestation)

The HAT chip (TI CC1352P7, firmware `PollPower/gateway-execution`) signs
**Ed25519** on chip, which ledger 9 cannot verify in-circuit. So:

1. The chip's **native attestation** (`ATTEST` 0x60): Ed25519 over
   SHA-512(`"pollpower:hat:attest:v1"` || ieee(8) || userid(4) ||
   sessionID[0..16] || session_uwh(8) || uptime_ms(8) || nonce(8)), where
   `session_uwh` is the chip's **own INA226-metered** energy, the nonce comes
   from its TRNG, and the host supplies only the 16-byte session id. The
   settle session id is that id zero-padded (it is also the v2-api purchase /
   outlet session id: Gap A). `SIGN_HASH` (chip signs any host hash) is
   refused for settles.
2. `meter-authority-service` (`POST /hat/v9`) verifies the attestation against
   the chip's allowlisted key and hardware id, then its rules (the chip's own
   meter / producer / payout address, `amount == floor(uWh / 1000)`, per-settle
   cap, max kW since the chip's last countersignature by the server clock, no
   reused session or nonce), and signs `hatMessage(self, settleRecordDigest(...),
   chipPubkey, chipSigR, chipSigS)` with its Jubjub key.
3. `settle` verifies that Jubjub signature in-circuit, **asserts the minted
   amount is the chip-metered energy**, and emits `pp:ebt:v9:settleChip`
   (session, chip key, chip signature, hardware id, uWh, uptime, nonce): every
   field needed to re-verify the chip signature off-chain (tested).

**Until the chip signs a curve the circuit verifies, the on-chain proof
vouches for the service, not the chip.** A stolen service key could still
mint for an approved chip's producer, but every such mint carries a chip
signature anyone can check from the event, and the minted amount is bound to
the attested energy. Follow-up after Preprod:
[hat-chip-signing-followup.md](./hat-chip-signing-followup.md).

**Cross-app impact: `meter-authority-service` must sign Jubjub Schnorr
instead of Ed25519**, over `hatMessage` and `reissueMessage`; the escrow
attestor, the schedule validator and operators likewise. The relay HAT signer,
settle ceremony and retune scripts in this repo refuse to run until they are
rewritten for the devnet run. Joi is notified.

Why not ECDSA for the HAT: it would add ~117 MB to every `settle` proof
(already 86 MiB). Schnorr adds ~2 MB.

Tests: `tests/contract/c1c-ebt-machine-signers.test.mjs` (18, 12 negative),
`tests/contract/c1c-tariff-signers.test.mjs` (11, 7 negative); the PoC (a
lying `signature_valid` witness) is supplied in every case.

### manualReissue: council gate (Gap C, Garrett 2026-11-24)

An exceptional correction (`manualReissue`, capped at 1,000,000 base units per
call with a 1 h cooldown) now needs **three** authorisations, all checked
in-circuit: the owner's Jubjub signature (`requireOwner`), the meter
authority's Jubjub co-signature over `reissueMessage(self, producerKey,
producerAddr, amount, seq)`, and the council's 2-of-3 approval (Multisig v8
`isApproved`) of `councilReissueHash(self, producerKey, producerAddr, amount,
reasonCode, evidenceHash, sourceTariffPath, currentTime)`, recorded in
`_consumedCouncilActions`. Tooling: owner key + signer in `tooling/owner/`;
co-signature from meter-authority-service `POST /reissue/v9` (token-gated,
once per reissue sequence). Tests: `c1c-ebt-machine-signers` RC1-RC5,
`owner-tooling`.

### Settle path findings (found while building LD v3's tests, 2026-11-24)

Building a full in-memory settle (real TariffRegistry schedule and class,
mirrored into EBT through action-log proofs) for the LD v3 tests showed three
pre-existing gaps on the path that feeds the dividend budget. Each was shown
on the pre-fix build, then fixed test-first (`tests/contract/ld3-ebt-side.test.mjs`).

| ID | Severity | Gap | Fix |
|---|---|---|---|
| WI16-E-1 | High | `settle` took `ldBps`, `opsBps`, `daoBps` as free arguments, checked only to sum to 10000 with the mirrored statutory total. Any HAT holder could settle with the dividend, ops and DAO shares at 0 and give them to the producer. | The class mirror stores the whole `SplitShares` (`_classSplitMirror`); settle asserts the three shares equal the class's (`SPLIT_OFF_CLASS`). |
| WI16-E-2 | High | Mirror writes were not monotonic. The registry log is append-only, so an older entry stays provable: re-mirroring it rolled a class back to an old split (shown: statutory 500 → 0, then a settle skipped the statutory lane) or a retired schedule back to live. | `_mirrorSeq` per mirrored item; a write needs a strictly newer `actionSeq` (`MIRROR_STALE_ENTRY`). Applies to classes, schedules and lanes. |
| WI16-E-3 | Medium | `EventProof.actionSeq` was not tied to the Merkle path, so any sequence number could be claimed (it drives lane freshness, and now E-2). | `verifyEventProof` rebuilds the leaf index from the path bits and requires it to equal `actionSeq`. |

Also noted, not fixed (Low): TariffRegistry `retireSchedule` at epoch 0
records `retiredEpoch = 0`, which every reader treats as "live", so a
retirement before the first epoch advance does nothing.

## C-2: EBT owner gate

Replace `assertOnlyOwner()` (`ownPublicKey() == _owner`) in the six owner-gated
circuits.

**Recommended: owner proves a Jubjub key with a Schnorr signature over the action.**

```compact
export sealed ledger _ownerPk: JubjubPoint;   // constructor (H-1)
circuit requireOwner(actionHash: Bytes<32>, sig: JubjubSchnorrSignature): [] {
  assert(jubjubSchnorrVerify<1>([transientHash<Vector<2, Bytes<32>>>([pad(32, "pp:ebt:v9:owner"), actionHash])],
                                sig, _ownerPk), "Only owner");
}
```

- `actionHash` binds the circuit name, its arguments and `kernel.self()`, and
  is **computed in-circuit from the call's own arguments, never passed in**;
  otherwise a signature over one hash could authorise a different call. The
  same rule applies to every council `actionHash` in C-1b.
- Owner rotation is a council action (C-1b), not owner-only.

**Alternative (your proposed form): hash-preimage identity.**
`_ownerId = persistentHash([pad("pp:ebt:v9:owner"), sk])`, and each owner
circuit takes `sk` as a private argument. Simpler signer (no curve maths), but:

- **Whoever runs the proof server sees `sk`**: the proof server receives every
  private input. Today the consumer app proves on a LAN proof server
  (`192.168.50.116:6300`), and kenya proves for the daemons. With Schnorr, the
  proof server sees only a signature that is useless for any other action.
- 11.3 MB proving key versus 2.1 MB for Schnorr.

Recommendation: Schnorr for the owner and for every member/user identity (LD);
the hash-preimage form only where the prover is always the key holder.

## H-1: no first-caller initialization

- **EBT:** delete `export circuit initialize`. The constructor takes
  `ownerPk`, `meterAuthorityPk`, `council` (contract reference),
  `operationsRecipient`, `daoRecipient`, `escrowAttestorPk`,
  `registryActionLogRoot`. Immutable values (`_council` for the Buildathon,
  token domain) are `sealed`; rotatable keys stay unsealed and change only
  through council actions. `_initialized` and `assertInitialized()` go away.
  One fewer circuit, so one fewer verifier key in the fence plan.
- **Multisig v6.2:** delete `export circuit initialize`; the constructor takes
  the 5 admin keys and the threshold (H-3 majority floor kept).
- **TariffRegistry:** already constructor-seeded. No change.
- Ceremony impact: the deploy transaction carries the constructor arguments, so
  the init values must be final before deploy. With the ceremony fence, the
  constructor runs in the fenced deploy, so there is no window.

## Contract-by-contract change list

| Contract | C-1 | C-2 | H-1 |
|---|---|---|---|
| Multisig v6.2 → v7-L9 | `approve` verifies secp256k1 in-circuit; new `isApproved` | — | constructor init |
| EBT v8 → v9 | `settle`, `redeem`: Jubjub Schnorr; `manualReissue` co-sign and `execMultisigOp`: council via `isApproved` | `requireOwner` with Schnorr | constructor init |
| TariffRegistry v1 → v2 | `consumeFederationApproval` → `isApproved`; `registerSchedule`, `retuneClass`: Schnorr | — (no owner gate) | already fixed |
| Living Dividend v3 | council via `isApproved`; member claims via Schnorr | — | constructor init |

Signed-payload layouts change for every signer. Domain tags bump to `v9` (EBT),
`v2` (TariffRegistry), `v3` (LD) so nothing signed for the old contracts
verifies on the new ones.

## Test plan (TDD, before contract code)

For each fix, written first and failing on the current contracts:

1. **Negative (the PoC as a regression test):** a lying or forged
   witness/signature must not pass `approve`, `settle`, `redeem`,
   `manualReissue`, owner circuits or council-gated circuits. The multisig PoC
   becomes `tests/parity/` regression tests that must reject.
2. **Positive:** a real ECDSA/Schnorr signature over the exact digest passes.
3. **Binding:** the same signature fails for a different action, argument or
   contract address.
4. **Front-run:** no exported circuit can set authorities after deploy.
5. **Parity:** each off-chain signer's digest equals the digest captured from
   the compiled circuit (the `tests/parity` pattern).
6. **Cross-contract:** consumed-set replay protection, and the approval of one
   consumer not usable on another; first on a local devnet.

## Schedule options

| Option | What ships to Preprod by Nov 30 | Risk |
|---|---|---|
| **A. Full fix, deploy after Nov 30** | Nothing public by Nov 30; Buildathon demo on a local devnet with the fixed stack | Misses a public Wave 3 deploy; safest |
| **B. Critical path only by Nov 30** | Multisig v7-L9 + EBT v9 (fixed) + TariffRegistry v2 (fixed); LD v3 after | Tight: ~10 dev-days of work in 6 calendar days, so it needs two people in parallel and still has little review time |
| **C. Ship as-is to Preprod** | Current contracts | Ruled out by Garrett's rule |

Recommendation: **A**, with the Buildathon demo on a local devnet and a
written disclosure of the findings and fixes (the fix itself is a strong
Buildathon story: it uses ledger 9 cross-contract calls and in-circuit
signature verification). Move to Preprod once the devnet end-to-end and a
review pass are done.

## Decisions needed

1. Approve this design (or the hash-preimage alternative for C-2).
2. ~~Can the Tangem rings sign secp256k1?~~ **Yes**, verified on the devnet 2026-11-24 (C-1a stays on hardware).
3. ~~`_council` sealed or rotatable?~~ **Sealed for the Nov 30 devnet demo; rotatable (72 h delay, proposed) before any Preprod deploy.**
5. ~~Council make-up~~ **2-of-3, three ring holders, plus one standby; 72 h rotation delay approved** (see "Council make-up and standby").
4. Schedule option A or B.
