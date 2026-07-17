# tariff-registry offline smoke suite

Offline JS mirror of `tariff-registry-v1.compact`, exercising the invariants
the brief + memo + red-team pre-read pin as required.

## Run

```
node --test tests/registry.test.mjs tests/wi13.2/action-log.test.mjs
```

No dependencies beyond Node ≥ 20 (uses `node:crypto` for SHA-256 + Ed25519,
`node:test` for the harness).

## What each test covers

| Test  | Source                        | Invariant / mechanism                                           |
|-------|-------------------------------|-----------------------------------------------------------------|
| T1    | brief §REQUIRED TESTS         | Happy path: charter → register → resolve → retune → resolve     |
| T2    | brief §REQUIRED TESTS + F-1   | I-A: unchartered nodeId → REVERT `SCHEDULE_UNCHARTERED_NODE`    |
| T3    | brief §REQUIRED TESTS         | I-B floor negatives: LD, Ops                                    |
| T3.5  | memo §3 F-5                   | Sanity-band retune: rate outside ±20% of schedule ref → REVERT  |
| T4    | brief §REQUIRED TESTS         | I-D replay: same federationApproval twice → REVERT              |
| T5    | brief §REQUIRED TESTS         | I-D forgery: no approval bundle → REVERT `..._INVALID`          |
| F-4   | memo §3                       | Second wrong-seat: bundle bound to wrong council → REVERT       |
| T6    | brief §REQUIRED TESTS         | Epoch retirement: e-1 works, retirement epoch REVERTs           |
| F-7a  | memo §3                       | Epoch decrement → REVERT `EPOCH_ADVANCE_NOT_PLUS_ONE`           |
| F-7b  | memo §3                       | Unauthorised advance → REVERT `FEDERATION_APPROVAL_INVALID`     |
| T7    | brief §REQUIRED TESTS         | Property: 1000 random valid retunes, sum-to-10000 holds         |
| R-A   | PR body / V1-DESIGN §4.1      | Charter proof against outdated root → REVERT                    |
| R-B   | PR body / V1-DESIGN §4.4      | Retune replay across schedules → REVERT                         |
| R-C   | PR body / V1-DESIGN §4.5      | `resolvePath(MAX_UINT64)` → REVERT                              |

### WI-13.2 action-log root + payloadHash widening (`tests/wi13.2/action-log.test.mjs`)

| Test  | Source                    | Invariant / mechanism                                                   |
|-------|---------------------------|-------------------------------------------------------------------------|
| AL-T1 | brief §REQUIRED TESTS     | Per-kind payloadHash (0,1,2,3,7 + sentinel 4/5/6): on-chain == off-chain recompute from map record (I-13.2-A/B) |
| AL-T2 | brief §REQUIRED TESTS     | Monotonicity: 10 mixed-kind emits, root changes & never rewinds, old-leaf proofs still verify (I-13.2-C) |
| AL-T3 | brief §REQUIRED TESTS     | Determinism: 1000 sequences → byte-identical roots (two builders); D-independence across depths 8/12/16/20 (I-13.2-D) |
| AL-T4 | brief §REQUIRED TESTS + §F | Migration: forward-only bootstrap → root == EMPTY_ROOT(D), baseSeq == pre-head, legacy entries carry sentinel payloadHash |
| AL-T5 | brief §REQUIRED TESTS + §E | WI-14 EventProof preview: simulated `verifyEventProof` accepts a valid proof; rejects wrong payloadHash / tampered sibling / stale root |

Merkle scheme: append-only incremental tree, leaf = raw `payloadHash` (no
re-hash), node = `persistentHash([nodeTag, left, right])`, empty-leaf =
`pad(32, "pp:tariff:v1:actionLogEmpty")`. `CAL-13.2-D` is a `TODO(calibration)`
placeholder in the contract (24); the harness proves correctness is
D-independent, so no test resolves it.

Currently: **32/32 regression + 12/12 WI-13.2 = 44/44 pass** on 2026-07-17.
(15 WI-13 + 17 WI-13.1 regression preserved unchanged — I-13.2-F.)
Previously: **15/15 pass** on 2026-07-14 (Joi's executing session).

## Ground-truth relationship

`registry.test.mjs` calls into `lib.mjs`. `lib.mjs` mirrors the contract
byte-for-byte on domain tags, field order, revert messages, and checked-cast
underflow behavior. If the .compact file's on-chain behavior diverges from
lib.mjs, one of them is wrong — do NOT paper over it. The .compact is the
ground truth for chain behavior; lib.mjs is the ground truth for what the
offline tests observe.
