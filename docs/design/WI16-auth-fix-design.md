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

### C-1a: council approvals (Multisig v6.2 → "v7-L9")

- Admin keys are **secp256k1 public keys**, set in the constructor (H-1).
  Tangem cards sign secp256k1; the H-1 ring swap keeps the hardware.
  **Decision needed:** confirm the Tangem rings can sign secp256k1 digests
  (the validated ring path today is Ed25519).
- `approve(actionHash, adminIndex, sig: Secp256k1EcdsaSignature)`:
  `digest = persistentHash([pad("pp:ms:v7:approve"), kernel.self().bytes, actionHash])`,
  `assert(secp256k1EcdsaVerify(digest, sig, adminPk[adminIndex]))`, record.
  The contract address in the digest keeps M-2's domain separation.
- New witness-free `isApproved(actionHash): Boolean` (approvals ≥ threshold).
  Witness-free is required: a circuit reached by a cross-contract call may not
  call witnesses.
- H-3 caps (MAX_ADMINS = 7, threshold raised with size, majority floor) carry
  over unchanged.
- Cost: ~117 MB proving key per approval, ~2.7 KB verifier key. Approvals are
  rare council actions, so this is acceptable.

Alternative if Tangem cannot sign secp256k1: council keys as Jubjub Schnorr on
the admin phones (2 MB proving key), with Tangem dropped from the on-chain
path. That weakens H-1's hardware guarantee; not recommended.

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
- Rotating the council address becomes a council-approved action itself
  (`setCouncil`), or the field is `sealed` and rotation means redeploy.
  **Decision needed** (recommendation: sealed for the Buildathon, rotation
  in the next version).

### C-1c: machine signers (HAT, escrow attestor, schedule operators/validators)

- Keys become **Jubjub** (Schnorr) public keys, verified in-circuit with
  `jubjubSchnorrVerify<1>([transientHash(payload)], sig, pk)`.
- EBT `settle`: same 5 HAT fields as today (EBT-H-1 binding kept), domain tag
  bumped to `pollpower:ebt:v9:epoch1`.
- EBT `redeem`: escrow attestation the same way.
- TariffRegistry `registerSchedule` (validator) and `retuneClass` (operator):
  the same way.
- **Cross-app impact: `meter-authority-service` must sign Jubjub Schnorr
  instead of Ed25519.** The signer must reproduce the circuit's challenge
  exactly; the compiled contract exports the hash as a pure circuit for the
  service to call. Joi is notified.
- Why not ECDSA for the HAT: it would add ~117 MB to every `settle` proof
  (already 86 MiB). Schnorr adds ~2 MB.

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
2. Can the Tangem rings sign secp256k1? (Decides C-1a.)
3. `_council` sealed for the Buildathon (recommended), or rotatable now.
4. Schedule option A or B.
