# SORTITION-DRAW-SPEC / v1

> **STATUS: DEV DRAFT — NORMATIVE COMPANION.**
> Companion to `multisig/SORTITION-TABLE-DESIGN.md` (the design note).
> The design note explains *why*. This document pins *what* — the exact byte
> encodings, hash primitive, Merkle construction, domain-tag registry, and
> version-bump rules so that two independent implementations MUST produce
> byte-identical roots and identical `selected[5]` from the same
> `(eligibility set, seed)`.
>
> Ambiguity anywhere in this spec is a spec failure. If reviewers find a
> latent choice not pinned here, the fix is to pin it in this file and bump
> the spec version — not to interpret.
>
> Machine-readable test vectors that MUST regenerate byte-for-byte from
> `multisig/tooling/gen-draw-spec-vectors.mjs` accompany this spec at
> `multisig/tooling/draw-spec-vectors.json`.

---

## 0. Scope and non-scope

**In scope (this document pins):**

1. Hash primitive for the off-chain auditor path.
2. Exact byte encodings for leaves, internal nodes, draw hashes, and the
   beacon derivation.
3. Merkle tree arity, internal-node construction, and padding rule.
4. Complete domain-tag registry with a closed set of tags.
5. The rejection-sampling collision rule (verbatim from the design note §2).
6. Spec-version string format and rules for what constitutes a version bump.
7. A worked end-to-end example whose values match test vector A.

**Out of scope (explicitly future work):**

- Any in-circuit enforcement of the draw. When and if the draw is enforced
  on-chain, the hash primitive will change (Poseidon-family, ZK-friendly),
  which is a spec-version bump; this document specifies the off-chain
  auditor path only.
- Calibration of gate thresholds and cooldown length (design note §4, §6;
  those are `TODO(calibration)` items owned by Garrett).
- Membership-root ledger placement inside the `.compact` contract; that
  belongs to the contract change proposed in the design note §8.

**Precedence.** If this document and the design note appear to disagree, the
design note wins for policy (§3 timing, §4 gate, §6 cooldown, §7
preconditions) and this document wins for byte-level layout, hash, and the
domain-tag registry. Editors resolving apparent conflict should treat it as a
spec bug and open an issue rather than silently reinterpreting either
document.

---

## 1. Versioning

### 1.1 Spec-version string

```
spec-version := "pp-sortition-draw-spec/v1"
```

The `v1` suffix is a single monotonically-increasing integer, no dots. This
version string SHOULD appear:

- as `specVersion` in emitted test vectors,
- in the header of every reference implementation (auditor tool, generator
  script, any future in-circuit prover),
- in any published table artefact (alongside `membershipRoot` and `epoch`).

### 1.2 What triggers a version bump

A version bump is REQUIRED for any change that could cause two
implementations of the same spec version to produce different bytes. The
following are enumerated bump triggers; this list SHOULD grow but MUST NOT
shrink:

| Trigger | Reason |
|---|---|
| Change of hash primitive (e.g. SHA-256 → any Poseidon variant for in-circuit). | Every hash output changes; roots and draws become incompatible. |
| Switch from `mod totalWeight` to rejection-sampling on the hash output itself (design note §2, "modulo-bias" note). | The k-sequence for the same seed diverges once one hash falls in the truncated-bias band. |
| Change of any domain tag string (§4). | Every domain-tagged hash output changes. |
| Change of any byte layout in §2 (endianness, field widths, ordering). | Every leaf, node, and draw hash changes. |
| Change of Merkle arity or padding rule (§3). | Every non-power-of-two root changes; some power-of-two roots may also change. |

Changes that are NOT version bumps:

- Additional test vectors, provided existing vectors regenerate byte-for-byte.
- Non-normative clarifying prose that pins no new choice.
- Reference-implementation refactors that preserve byte output.

### 1.3 Reserved tags

All domain tags in this spec live under the reserved prefix
`pp:sortition:` and the suffix `:v1`. A version bump MUST use suffix `:v2`
(etc.); no domain tag is silently reused across versions.

---

## 2. Byte-level primitives

All integer fields in this spec are unsigned, big-endian, fixed-width. There
is no varint, no length-prefix, no compression.

| Field | Width | Encoding | Source |
|---|---|---|---|
| `epoch` | 8 bytes | big-endian unsigned | design note §1.1 |
| `index` (row index in the canonical table) | 4 bytes | big-endian unsigned | design note §1.1 |
| `memberAddr` | 32 bytes | raw bytes as stored on-chain (`Bytes<32>`); no framing | design note §1.1 |
| `weight` | 8 bytes | big-endian unsigned | design note §1.1 |
| `k` (draw index) | 4 bytes | big-endian unsigned | design note §2 (`k as 4-byte BE`) |
| `seed` | 32 bytes | raw output of hash primitive | this spec §5 |
| `blockhash` (beacon input) | 32 bytes | raw block hash bytes | this spec §5 |

All domain tags are ASCII strings appended raw (no null terminator, no length
prefix). Concatenation is byte concatenation in the order given.

---

## 3. Hash primitive

For the off-chain auditor path — the path this spec governs — the primitive
is:

```
H(...) := SHA-256(...)
```

SHA-256 is standardised (FIPS 180-4), universally available in tooling
languages, and byte-deterministic across implementations. Its choice for the
off-chain path is fixed. Any change is a spec-version bump per §1.2.

The design note §2 mentions Poseidon "if/when the draw is enforced
in-circuit." That is a separate, future-work spec version. This document
does not describe it and does not attempt to make SHA-256 and Poseidon
interoperable; they cannot be.

---

## 4. Domain-tag registry (closed)

Every hash operation in this spec uses one of exactly five domain tags. New
tags MUST NOT be introduced without a version bump.

| Tag | Purpose | First byte of the pre-image of the tagged hash |
|---|---|---|
| `pp:sortition:leaf:v1` | Row (candidate) leaf in the Merkle tree. | Leaf hash pre-image. |
| `pp:sortition:node:v1` | Internal Merkle-tree node. | Internal-node hash pre-image. |
| `pp:sortition:pad:v1` | Sentinel padding-leaf. | Padding-leaf hash pre-image (no other inputs). |
| `pp:sortition:draw:v1` | Per-`k` draw hash. | Draw hash pre-image. |
| `pp:sortition:beacon:v1` | Seed derivation from a future blockhash (design note §3 option B). | Beacon hash pre-image. |

Cross-check: each of these tags appears verbatim in
`multisig/SORTITION-TABLE-DESIGN.md` (§1.1 for `leaf`, `node`, `pad`; §2 for
`draw`; §3 for `beacon`). This spec introduces no new tags.

---

## 5. Constructions

### 5.1 Leaf hash

Per row `i` of the canonical table for epoch `e`:

```
leaf[i] = SHA-256(
    "pp:sortition:leaf:v1"               # 20 bytes ASCII, no terminator
  || u64be(epoch_e)                      # 8 bytes
  || u32be(index_i)                      # 4 bytes
  || memberAddr_i                        # 32 bytes
  || u64be(weight_i)                     # 8 bytes
)
```

Total pre-image length: 20 + 8 + 4 + 32 + 8 = **72 bytes**.

`epoch_e` is inside every leaf: a table for one epoch can never be replayed
as the table for another (design note §1.1). This is invariant #3 of the
brief.

### 5.2 Padding-leaf hash (sentinel)

For non-power-of-two `n`, extend the leaf array to `nextPow2(n)` slots by
appending copies of the sentinel:

```
pad = SHA-256("pp:sortition:pad:v1")     # 20 bytes ASCII, no other inputs
```

The sentinel is a constant. Padded slots have **weight 0**, do not appear on
the cumulative axis, and are **undrawable** (invariant #4). Implementations
MUST NOT include padded slots in any weighted lookup structure used by §5.4.

### 5.3 Merkle tree

- **Arity:** binary.
- **Leaf order:** the canonical order from design note §1.2 (ascending by
  `memberAddr` bytes, lexicographic, total).
- **Padding rule:** pad to the next power of two using §5.2. If `n` is
  already a power of two, no padding is applied.
- **Internal-node hash:**

  ```
  node(left, right) = SHA-256(
      "pp:sortition:node:v1"             # 20 bytes ASCII, no terminator
    || left                              # 32 bytes
    || right                             # 32 bytes
  )
  ```

  Total pre-image length: 20 + 32 + 32 = **84 bytes**.

- **Root:** the single node produced by repeated pairwise application of
  `node(·,·)` from the leaf layer up. `membershipRoot_e = root of leaves for
  epoch e`.

`nextPow2(n)` is defined as `1` when `n ≤ 1`, else the smallest power of two
`≥ n`. The pilot precondition (design note §7) requires `n ≥ 5`, so in
practice the tree always has at least 8 slots.

### 5.4 Draw

Given the canonical table (drawable rows only — padded slots excluded) and a
32-byte `seed`, produce `selected[0..4]` verbatim from design note §2:

```
selected = []
k = 0
while len(selected) < 5:
    d    = SHA-256(
             "pp:sortition:draw:v1"      # 20 bytes ASCII, no terminator
          || seed                        # 32 bytes
          || u32be(k)                    # 4 bytes
        )
    pick = int_be(d) mod totalWeight
    winner = smallest i s.t. pick < cumulative[i]     # half-open bucket
    if winner.memberAddr in selected:
        k += 1                            # collision: advance k, DO NOT re-pick
        continue
    selected.append(winner.memberAddr)
    k += 1
return selected                           # exactly 5 distinct memberAddrs
```

`int_be(d)` reads the 32-byte SHA-256 output as a big-endian unsigned integer
(0 ≤ value < 2²⁵⁶). `totalWeight` is `cumulative[n-1]` after canonicalisation
(§1.2).

**Rejection-sampling collision rule.** Quoting the design note verbatim:

> **Rejection sampling on collision** (advance `k`, don't re-pick the same
> `k`) keeps the draw uniform over *distinct* members and guarantees
> termination as long as `n >= 5` distinct eligible members exist.

The `k` value that produced a collision is **retired** — it does not appear
again in the draw sequence.

**Modulo bias.** For pilot-scale `totalWeight` in the tens, the bias from
`int_be(d) mod totalWeight` is cryptographically negligible. If a future
deployment ever makes this matter, switch to rejection sampling on the hash
output (reject `int_be(d) ≥ floor(2²⁵⁶ / totalWeight) * totalWeight` before
the modulo). That switch is a spec-version bump (§1.2), not a silent change.

### 5.5 Beacon-derived seed (design note §3 option B)

When the seed is derived from a future blockhash (the preferred path):

```
seed = SHA-256(
    "pp:sortition:beacon:v1"             # 22 bytes ASCII, no terminator
  || blockhash(target_height)            # 32 bytes
)
```

`target_height` is the value the council committed to before the freeze `t0`
and is bound alongside `seedCommitment` in the rotation actionHash. This spec
does not govern which chain provides the blockhash; that is a deployment
choice fixed at ceremony configuration time. Two implementations MUST agree
on the blockhash they read for a given `(chain, target_height)` before this
derivation is meaningful.

Option A (bare commit-reveal) reveals the 32-byte `seed` directly; no
derivation from a beacon is applied. In that case the design note §3 timing
argument is what protects the draw, not the beacon tag.

---

## 6. Auditor procedure

An auditor validating a rotation MUST perform the following, in order, and
reject on any failure. The rejection reason SHOULD name the exact
divergence point.

1. **Table reconstruction.** Fetch the published sortition table for
   `epoch_e`. Verify canonical order (§1.2). Recompute each leaf hash (§5.1)
   and the Merkle root (§5.3). Assert the recomputed root equals the
   `membershipRoot` bound on-chain in the rotation actionHash / parent-signed
   convene message. **Reject on mismatch.**
2. **Precondition checks.** Assert design note §7: `n ≥ 5` distinct
   drawable rows, cumulative monotone strictly increasing, and
   `cumulative[n-1] == totalWeight`. **Reject on mismatch.**
3. **Seed reveal / derivation.** Verify option A or B per design note §3
   and this spec §5.5. Under option B, recompute `seed` from
   `blockhash(target_height)`. **Reject if the derivation does not match the
   revealed seed.**
4. **Draw replay.** Run §5.4 over `(table, seed)`. Compare the resulting
   `selected[0..4]` against the on-chain `incoming[5]`. **Reject on
   mismatch, naming the first index `j` where `selected[j] != incoming[j]`.**
5. **Timing witness.** Verify design note §3 snapshot-timing (`t0` freeze
   preceded `t1` reveal, no eligibility input dated after `t0`). This is a
   ceremony-log check, not a hash check, and is outside byte-level scope but
   MUST be performed by the auditor.

Test vector F exercises step 4 with a deliberate mismatch.

---

## 7. Worked example

This example is vector A of `multisig/tooling/draw-spec-vectors.json` and is
byte-identical to what `gen-draw-spec-vectors.mjs` emits.

### 7.1 Inputs

- `epoch_e = 7`
- Eligible set (all `weight = 1`, i.e. the equal-weight gate policy):

  | memberAddr (32 bytes, big-endian) | label |
  |---|---|
  | `0x11000000000000000000000000000000000000000000000000000000000000a1` | alice |
  | `0x22000000000000000000000000000000000000000000000000000000000000b2` | bob |
  | `0x44000000000000000000000000000000000000000000000000000000000000d4` | dembe |
  | `0x55000000000000000000000000000000000000000000000000000000000000e5` | esther |
  | `0x66000000000000000000000000000000000000000000000000000000000000f6` | farida |

- Seed:
  `0x5787a73119ee9e2cc16a1245e27c981d6c1cd8248e5543b6c1fcb04c9ace2280`
  (derived as `SHA-256("pp:test:seed:A")` — reproducibility helper for the
  vector; NOT a beacon derivation).

### 7.2 Canonical table

Sorted ascending by `memberAddr` bytes:

| index | memberAddr (short) | weight | cumulative |
|---:|---|---:|---:|
| 0 | `0x11…a1` (alice) | 1 | 1 |
| 1 | `0x22…b2` (bob) | 1 | 2 |
| 2 | `0x44…d4` (dembe) | 1 | 3 |
| 3 | `0x55…e5` (esther) | 1 | 4 |
| 4 | `0x66…f6` (farida) | 1 | 5 |

`totalWeight = 5`.

### 7.3 Leaf hashes

Each leaf per §5.1 (72-byte pre-image, then SHA-256):

| i | `leaf[i]` |
|---:|---|
| 0 | `0xfe90b5642e17a77b2eeec1502895f885a25af29a1fbe7e074449f5c1b880fe17` |
| 1 | `0x6bec6c718585fa8bd94906e2f174894e99ed791d8e75dec509b11e6b5c9ff854` |
| 2 | `0xbe3041f19cc5c24ebc45eda02c40bc8371cd111ac0dad6ea8eb94339d533002c` |
| 3 | `0x78e8a9231d776f279dd1e957a8ad568e358f0b13b655b0955a925681f883ebe1` |
| 4 | `0xa04e8a4162759fdb48fb79ffc7185dee639167e4b48d7a6f78e788301e309bc1` |

### 7.4 Padding sentinel

`n = 5`, so `nextPow2(5) = 8`. Three sentinel-padded slots are appended:

```
pad = SHA-256("pp:sortition:pad:v1")
    = 0x44f62bc37a8930f99b53cd15560ac4896e8d87020db9efbb71f03f3f91333d16
```

Leaf layer (8 slots):

```
L0 = leaf[0]   L1 = leaf[1]   L2 = leaf[2]   L3 = leaf[3]
L4 = leaf[4]   L5 = pad       L6 = pad       L7 = pad
```

### 7.5 Merkle root

Rolled up per §5.3 with `node(left, right) = SHA-256(TAG_NODE || left ||
right)`:

- Level 1 (4 nodes): `node(L0,L1)`, `node(L2,L3)`, `node(L4,L5)`,
  `node(L6,L7)`
- Level 2 (2 nodes): `node(level1[0], level1[1])`,
  `node(level1[2], level1[3])`
- Level 3 (root): `node(level2[0], level2[1])`

```
membershipRoot = 0x8407e8a69e7c6c7a4a1665ebc9c397aca5bcfc207ae7088a1a51e70449b40070
```

### 7.6 Draw

Running §5.4 over the table and seed. `d_k = SHA-256(TAG_DRAW || seed ||
u32be(k))`; `pick_k = int_be(d_k) mod 5`. Trace (all 13 steps until 5
distinct members are chosen):

| k | `d_k[0..8]` (prefix) | `pick_k` | winner idx | outcome |
|---:|---|---:|---:|---|
| 0 | `0xf9242969f8074d4b…` | 4 | 4 (farida) | ACCEPT |
| 1 | `0x923fa077e9e164ba…` | 4 | 4 | reject (collision — farida already in) |
| 2 | `0x0ef29d102a79f37f…` | 1 | 1 (bob) | ACCEPT |
| 3 | `0x75e631127ea5676d…` | 3 | 3 (esther) | ACCEPT |
| 4 | `0xa330c01a00933ecf…` | 2 | 2 (dembe) | ACCEPT |
| 5 | `0xa9b6cf0e2c0aa690…` | 2 | 2 | reject |
| 6 | `0x2426fb96c64e1a8f…` | 2 | 2 | reject |
| 7 | `0xf9edd62dde9745a9…` | 1 | 1 | reject |
| 8 | `0xee9b92317a76d3ad…` | 4 | 4 | reject |
| 9 | `0x191b87c4b2db259c…` | 4 | 4 | reject |
| 10 | `0x14327cf82616f405…` | 2 | 2 | reject |
| 11 | `0x627d4851374c4f9e…` | 2 | 2 | reject |
| 12 | `0xae8958a91c7cc465…` | 0 | 0 (alice) | ACCEPT |

Total k consumed: **13**. The 8 collisions between k=4 and k=12 are exactly
the "advance k, do not re-pick" rule at work — with 4 of 5 slots filled,
the marginal acceptance probability is 1/5 per step, so long tails are
expected on tight tables.

### 7.7 Result

```
selected[5] = [
  0x66…f6 (farida),
  0x22…b2 (bob),
  0x55…e5 (esther),
  0x44…d4 (dembe),
  0x11…a1 (alice),
]
```

This is exactly the `incoming[5]` the council should approve in
`executeRotateSeats`, and exactly the value emitted as
`vectors[0].expected.selected` in `draw-spec-vectors.json`.

---

## 8. Invariants (mandatory for reviewers)

Any implementation of this spec MUST preserve all of the following. Any
generator-script change that breaks any of them is a bug and requires a
version bump if merged.

1. **Cross-implementation agreement.** Two independent implementations given
   the same `(eligibility set, seed)` produce byte-identical `membershipRoot`
   and byte-identical `selected[5]`.
2. **Closed tag set.** Every domain tag in this document appears verbatim
   in `SORTITION-TABLE-DESIGN.md`. No new tag may be introduced without a
   version bump.
3. **Epoch inside every leaf.** The 8-byte `u64be(epoch_e)` is part of every
   leaf pre-image, so tables from different epochs are never
   interchangeable.
4. **Padded leaves are undrawable.** Padded slots have `weight = 0`, are
   never on the cumulative axis, and never appear in the winner-lookup for
   §5.4.
5. **Generator matches vectors.** `multisig/tooling/gen-draw-spec-vectors.mjs`
   emits byte-identical output to `multisig/tooling/draw-spec-vectors.json`.
   Reviewers regenerate before accepting changes.

---

## 9. Test vectors

The companion file `multisig/tooling/draw-spec-vectors.json` contains six
vectors (A–F) selected to cover the acceptance surface enumerated in the
WI-09 brief:

| id | title | exercises |
|---|---|---|
| A | minimal table `n=5`, equal weights | worked example (§7); tight table forces many rejections (13 k-steps for 5 seats) |
| B | non-power-of-two leaf count (`n=6`) — padding exercised | sentinel padding at two of eight slots |
| C | seed forces at least one rejection | collision path (advance `k`, do not re-pick) |
| D | equal-weight gate policy (`n=6`, all `weight=1`) | §4 recommendation round-trip |
| E | federation-seat row present | structural equivalence of federation and personal seats |
| F | wrong `incoming[5]` — auditor MUST reject | negative test with named divergence index |

Each vector carries: `epoch`, the full canonical `table` (including per-row
`leafHash`), `membershipRoot`, `seed`, and either `expected.selected +
kSequence` (positive) or `expected.verdict + correctSelected +
firstDivergenceIndex + rejectionReason` (negative).

### 9.1 Regeneration

```
node multisig/tooling/gen-draw-spec-vectors.mjs > multisig/tooling/draw-spec-vectors.json
```

The generator is deterministic (no wall-clock, no system entropy, no
network calls). Its output MUST be byte-identical to the committed vectors
file. CI (or a reviewer's local check) SHOULD `diff` the two.

### 9.2 Vector A ↔ worked example

The values in §7 match `vectors[0]` in `draw-spec-vectors.json` byte-for-byte:
`epoch`, `seed`, every row's `leafHash`, `membershipRoot`, the full
`kSequence`, and `selected[5]`.

---

## 10. Open items (not blocking this spec)

None from the byte-level layer — every choice in scope is pinned. The
following are known open items owned elsewhere:

- **`TODO(calibration)`** for design note §4 gate thresholds and §6
  cooldown length. These do not affect this spec; they change the input
  eligibility set the table is built from.
- **Beacon source pinning** (which chain / which height mapping) — a
  deployment configuration, not a spec value.
- **In-circuit spec (`v2` future work).** A Poseidon-based, ZK-friendly
  companion for enforced (not merely auditable) draws. Separate document,
  separate version.

---

*Author: Joi. DEV DRAFT, 2026-07-12. Companion to
`multisig/SORTITION-TABLE-DESIGN.md` (§1.1, §2, §3). Vectors verified
against `multisig/tooling/gen-draw-spec-vectors.mjs`.*
