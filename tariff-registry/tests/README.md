# tariff-registry offline smoke suite

Offline JS mirror of `tariff-registry-v1.compact`, exercising the invariants
the brief + memo + red-team pre-read pin as required.

## Run

```
node --test tests/registry.test.mjs
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

Currently: **15/15 pass** on 2026-07-14 (Joi's executing session).

## Ground-truth relationship

`registry.test.mjs` calls into `lib.mjs`. `lib.mjs` mirrors the contract
byte-for-byte on domain tags, field order, revert messages, and checked-cast
underflow behavior. If the .compact file's on-chain behavior diverges from
lib.mjs, one of them is wrong — do NOT paper over it. The .compact is the
ground truth for chain behavior; lib.mjs is the ground truth for what the
offline tests observe.
