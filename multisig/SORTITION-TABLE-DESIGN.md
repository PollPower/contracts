# Sortition Table — draw-integrity & eligibility design

> **STATUS: DEV DRAFT — PROPOSED, NOT IMPLEMENTED.**
> This is a policy + verification layer specified on top of the existing
> `multisig-federated-v1.compact` (itself a DEV DRAFT: not deployed, not
> audited, not on the pilot's critical path — the pilot runs on flat
> Multisig v7). Nothing here has been built, compiled, or reviewed. It
> proposes **one small contract addition** (a `membershipRoot` bound
> alongside the existing `seedCommitment`) plus a body of **off-chain
> table-construction rules**. No change to the council mechanism, the
> quorum logic, the constitutional floor, the federation-seat path, or the
> recovery path is required or proposed.

---

## 0. What the contract does today (verified against the `.compact`)

Before proposing anything, here is what `multisig-federated-v1.compact`
**actually** enforces at rotation, read from the source (rev 4):

- `executeRotateSeats(outgoing[5], incoming[5], seedCommitment, currentTime)`
  recomputes an `actionHash` over a `Vector<14, Bytes<32>>`:
  `[opSel, self, outgoing[0..4], incoming[0..4], seedCommitment, nextNonce]`
  (contract L444–L462).
- It requires council quorum on that hash (`isApproved`), touches the
  liveness clock, asserts each `outgoing[i]` is a current seat, then
  `resetToDefault()`s `_seats` and inserts the 5 `incoming` ids, asserting
  `_seats.size() == 5` (L467–L480).
- It increments `_epoch`, which structurally kills every stale approval and
  signature keyed on the old epoch.
- `executeConveneRotation(...)` is the parent-recovery twin: same
  `seedCommitment` binding, no council quorum, gated on 30 days of
  inactivity + a parent signature that binds the seed (L499–L545).

**What the contract does NOT do** (this is the gap this note addresses):

1. It does **not** pin the *draw algorithm*. `incoming[5]` is whatever 5
   ids the council approved. `seedCommitment` is bound into the hash purely
   so the draw is *recomputable off-chain* — the contract never reveals the
   seed, never derives `incoming` from it, and never checks that derivation.
   The contract header says this in as many words: *"binding a seedCommitment
   so the sortition draw is auditable off-chain"* (L41–L42) and *"Cryptographic
   enforcement of the draw itself is future work; the auditability commitment
   is the same one regular rotation already relies on."* (note 5).
2. It does **not** commit the *eligibility set*. There is no `_members`
   ledger field and no membership root anywhere in the contract. So even a
   perfectly recomputable draw is only auditable against a table that the
   council could have hand-picked. "The draw was fair" and "the pool the
   draw ran over was fair" are two different claims; the contract underwrites
   neither on-chain today, and the second one isn't underwritten *at all*.

This note closes gap (2) with a single new on-chain field, and specifies
the off-chain machinery that makes gap (1) auditable in practice (full
in-circuit draw enforcement remains future work, exactly as the header says).

---

## 1. The sortition table

The **sortition table** is the ordered, frozen eligibility snapshot for a
single epoch `e`. It is an **off-chain artifact**; its **Merkle root**
(`membershipRoot`) is the only thing that goes on-chain.

Each row is a candidate the draw may select. Rows are **canonically ordered**
(see §1.2) so that every honest party building the table from the same inputs
produces byte-identical leaves and therefore an identical root.

| col          | type          | meaning                                                        |
|--------------|---------------|----------------------------------------------------------------|
| `index`      | `Uint`        | 0-based position after canonical sort. Defines the cumulative axis. |
| `memberAddr` | `Bytes<32>`   | the candidate's council-seat identity (pubkey, or a lower-tier council address for a federation seat). |
| `weight`     | `Uint`        | draw weight. Under the recommended policy (§4) this is **`1` for every eligible row**. |
| `cumulative` | `Uint`        | running sum of `weight` **up to and including** this row. `cumulative[last] == totalWeight`. |

Example (equal-weight gate policy, 6 eligible members):

```
index | memberAddr        | weight | cumulative
------+-------------------+--------+-----------
  0   | 0x9a…(alice)      |   1    |    1
  1   | 0xb2…(bob)        |   1    |    2
  2   | 0xc7…(cluster-W)  |   1    |    3     <- federation seat (lower-tier council addr)
  3   | 0xd4…(dembe)      |   1    |    4
  4   | 0xe1…(esther)     |   1    |    5
  5   | 0xf0…(farida)     |   1    |    6
                                    totalWeight = 6
```

### 1.1 Leaf encoding

Each leaf commits the full row so the table cannot be silently reshaped after
the root is published:

```
leaf[i] = H( "pp:sortition:leaf:v1"
           ‖ epoch_e            (8 bytes, big-endian)
           ‖ index_i            (4 bytes, big-endian)
           ‖ memberAddr_i       (32 bytes)
           ‖ weight_i           (8 bytes, big-endian) )
```

`membershipRoot_e = MerkleRoot( leaf[0..n-1] )` over a fixed-arity tree with a
domain-separated internal-node hash (`"pp:sortition:node:v1" ‖ left ‖ right`)
and a defined padding rule for non-power-of-two leaf counts (pad with a
sentinel `H("pp:sortition:pad:v1")` leaf; padded leaves have `weight = 0` and
can never be drawn). `epoch_e` is inside every leaf so a table for one epoch
can never be replayed as the table for another.

The full table (all rows) is published alongside the root at rotation time
(git, IPFS, or the ops-dashboard) so any observer can rebuild the tree, check
the root, and re-run the draw. On-chain we store only the 32-byte root.

### 1.2 Canonical ordering (determinism requirement)

Two honest builders **must** produce the same table. Ordering rule:

1. Take the eligible set (§4 gate applied at the snapshot instant, §3).
2. Sort ascending by `memberAddr` bytes (lexicographic over the 32-byte id).
   `memberAddr` is unique per member, so the sort is total — no tie-break
   ambiguity, no dependence on insertion order or map iteration.
3. Assign `index` 0..n-1 in that order; compute `cumulative` as the running
   weight sum.

Sorting by identity (not by weight, tenure, or anything mutable) means the
table's shape is a pure function of *which ids are eligible* and *their
weights* — nothing about ordering can be gamed.

---

## 2. Deterministic draw procedure

Given the frozen table and a revealed `seed` (§3), the 5 seats are drawn by a
procedure that is a **pure function of `(table, seed)`** — same inputs, same 5
seats, for everyone, forever.

```
seed = reveal(seedCommitment)          # see §3 for the reveal/derivation

selected = []                          # ordered list of winning memberAddr
k = 0                                  # draw index (advances on every H() call)
while len(selected) < 5:
    pick = H("pp:sortition:draw:v1" ‖ seed ‖ k) mod totalWeight   # k as 4-byte BE
    winner = binary_search_cumulative(table, pick)
        # smallest index i such that pick < cumulative[i]
        # (half-open bucket [cumulative[i-1], cumulative[i]) -> row i)
    if winner.memberAddr in selected:
        k += 1                         # collision: reject and advance, do NOT re-pick
        continue
    selected.append(winner.memberAddr)
    k += 1
return selected                        # exactly 5 distinct memberAddrs
```

Notes:

- **`H`** is a fixed hash pinned by this spec's version tag
  (`pp:sortition:draw:v1`). The concrete primitive (SHA-256 for the off-chain
  auditor tool; Poseidon if/when the draw is enforced in-circuit) is named in
  the versioned `SORTITION-DRAW-SPEC` companion so table + seed + spec-version
  fully determine the output.
- **Rejection sampling on collision** (advance `k`, don't re-pick the same
  `k`) keeps the draw uniform over *distinct* members and guarantees
  termination as long as `n >= 5` distinct eligible members exist (a hard
  precondition on the table; see §7).
- **`mod totalWeight` bias**: for pilot-scale `totalWeight` (tens, not 2^k)
  the modulo bias from a 256-bit hash is cryptographically negligible. If a
  large membership ever makes this matter, switch to rejection sampling on
  the hash output itself (reject `H(...) >= floor(2^256/totalWeight)*totalWeight`
  before the modulo). Named as a spec-version bump, not a silent change.
- The output `selected[0..4]` is exactly the `incoming[5]` vector the council
  approves in `executeRotateSeats`. Because the contract binds `seedCommitment`
  into the actionHash **and** (proposed) `membershipRoot`, any observer can:
  reconstruct the table (root matches), reveal the seed (commitment matches),
  re-run this procedure, and assert the result equals the `incoming` the
  council actually rotated in. A council that rotates in cronies produces an
  `incoming` that does not match the draw — publicly visible misbehavior,
  the same enforcement model the contract header already claims, now with the
  eligibility pool nailed down too.

---

## 3. Commit–reveal ordering (anti-grinding)

The one property that makes sortition meaningful is that **nobody can steer
the outcome**. There are two things an adversary could grind:

- **the seed** — try seeds until the draw favours them, or
- **the membership** — add/shape eligible rows after seeing the seed so a
  favoured member lands in a winning bucket.

Both are defeated by a strict ordering: **freeze the pool first, reveal the
seed second.**

### Snapshot-timing constraint (normative)

```
t0  FREEZE MEMBERSHIP.  Compute the sortition table from the eligibility gate
    (§4) evaluated at instant t0. Compute membershipRoot_e. PUBLISH the root
    (and the full table) and COMMIT it — no eligibility input observed after
    t0 may change the table for epoch e. membershipRoot_e is now immutable.

t1  REVEAL / DERIVE SEED.  Only after membershipRoot_e is committed does the
    seed become known:
      option A (commit-reveal): the seed was committed as seedCommitment in a
        PRIOR step whose preimage nobody could grind against t0's table
        (because t0's table did not yet exist when the commitment was made);
        reveal it now.
      option B (block-hash beacon, PREFERRED): derive seed from a FUTURE
        block hash chosen at t0 — seed = H("pp:sortition:beacon:v1" ‖
        blockhash(target_height)) where target_height > current at t0. The
        seed is unknowable at t0 and unforgeable at t1. seedCommitment then
        commits to target_height, not to a chosen value, so there is no value
        to grind.

t2  DRAW & ROTATE.  Run §2 over (table_e, seed). Council approves
    executeRotateSeats with incoming = selected, seedCommitment, and the new
    membershipRoot bound alongside it (§5).
```

**Invariant:** `membershipRoot_e` is fixed strictly before `seed` is
knowable. If this ordering is violated, the draw is void — an auditor who
sees a membership input dated after the seed reveal must reject the rotation.

Why each direction matters:

- **Freeze pool → then seed** stops *membership grinding*: once the seed is
  out, the pool is already locked, so no attacker can inject/shape a row to
  catch a now-known winning bucket.
- **Commit seed before it's knowable (or derive from a future block)** stops
  *seed grinding*: the seed's value can't be chosen to favour a known table,
  because at commit time the target table didn't exist (option A) or the value
  is a future beacon nobody controls (option B).

Option B is preferred because it removes the trusted "who commits the seed and
could they have grabbed the table first" question entirely — the beacon is
public and adversary-independent.

---

## 4. Weighting / eligibility policy

Garrett's ask, verbatim intent: *"not complete novices."* The threat to avoid
is the opposite failure mode — a **linear volume/holdings weight** that makes
the biggest earner the most likely governor, i.e. **plutocracy** wearing a
lottery costume.

### Recommendation: hard GATE + equal weight

Do **not** weight by volume or holdings. Instead impose a binary eligibility
**gate**, and give every member who passes it **equal weight (`weight = 1`)**.
Sortition's whole point is that legitimacy comes from *random selection among
qualified peers*, not from ranking them.

A member is **eligible for epoch `e`** iff **all** of:

| gate condition        | threshold (pilot default, tune per tier) | data source (verified to exist) |
|-----------------------|------------------------------------------|---------------------------------|
| **KYC'd**             | verified, one human ⇒ one membership     | KYC pipeline (Smile-ID) + the LD contract's `_seenKycJobHashes` Sybil guard (`living-dividend-v2.2.x`). |
| **≥ X distinct settlement sessions** | X = 3 (pilot) | EBT settlement history — count **distinct session IDs**, the same replay-guarded session identity `settle()` consumes. |
| **≥ Y days LD maturity** | Y = 30 (pilot) | `registeredAt` (tenure since LD enrolment) + a non-trivial LD `accPerShare` checkpoint proving real accrued share. |
| **currently live**    | not pruned / not marked dead             | LD living-member set (the death filter that `claimSplit`/keeper already respect). |

Rationale for a gate over a slope:

- A gate answers exactly the "not novices" ask: it excludes the unproven,
  then treats every proven member as a political equal.
- A linear slope (weight ∝ EBT volume, or ∝ holdings) concentrates governance
  in whoever moved the most energy-value — the plutocracy failure. It also
  turns governance into a *farming target* (see §5).

### If a gradient is ever wanted: concave + capped

Should a future tier decide equal-weight is too flat, the **only** acceptable
gradient is **concave and hard-capped**, in the quadratic-voting spirit:

```
weight_i = min( floor( sqrt( qualifying_metric_i ) ), W_CAP )
```

where `qualifying_metric` is a *non-farmable* quantity (distinct sessions or
tenure-days, never raw amount — §5) and `W_CAP` is a small constant (e.g. 3)
so the largest member can be at most `W_CAP`× a minimal member, never 100×.
`sqrt` makes each additional unit of metric buy sharply less influence;
the cap bounds the worst case regardless. This is a fallback, **not** the
recommendation — the recommendation is flat `weight = 1`.

---

## 5. Farmability mitigations

Every gate input is chosen so that buying more of it is either impossible or
economically pointless:

- **Distinct settlement sessions, not raw amount.** The gate counts *how many
  separate metered sessions* a member has, not KES/EBT throughput. A whale can
  push huge volume through one session and clear no more of the gate than a
  member with the same session count. Splitting volume into many fake sessions
  is bounded by the meter/gateway attestation path (each session needs a real
  gateway signature + Meter Authority attestation), so sessions are expensive
  to manufacture — the C-1 mint path already makes fake sessions hard.
- **Tenure can't be farmed.** `registeredAt` age and "≥ Y days LD maturity"
  are wall-clock quantities. You cannot buy time; you can only wait, which is
  exactly the "not a complete novice" signal we want.
- **KYC = one human, one membership.** The KYC gate plus the LD contract's
  `_seenKycJobHashes` Sybil rejection means a single human cannot appear as
  multiple eligible rows, so no amount of spending multiplies a person's draw
  probability.
- **LD maturity is downstream of real earning.** A non-trivial `accPerShare`
  checkpoint can only accrue from actual settled sales flowing through the
  dividend loop; it cannot be self-dealt without genuine metered energy
  economic activity.

Net: the cheapest way to raise your draw odds is to *be a real, long-standing,
active, KYC'd member* — which is the qualification the gate is trying to
select for. There is no shortcut.

---

## 6. Anti-incumbency

Maturity gates create a risk of their own: the same senior members qualify
every epoch, so "mature enough to govern" ossifies into "permanent governing
class." Sortition should rotate power, not entrench it.

**Mechanism: last-epoch cooldown.** A member who **held a seat in epoch
`e-1`** is, for epoch `e`, either:

- **cooldown-ineligible** (recommended default): omitted from table `e`
  entirely for one epoch, then eligible again at `e+1`; **or**
- **down-weighted** (only meaningful under the §4 concave gradient): their
  `weight` is reduced (e.g. halved, floored at 1) for one epoch.

The **cooldown-ineligible** variant is preferred with the recommended
equal-weight gate (down-weighting a `weight=1` member to `weight=1` is a
no-op; you'd have to drop them to keep the anti-incumbency effect, which is
just the ineligible variant). Cooldown length is a per-tier parameter (1 epoch
pilot default). Serving members are identifiable from the current `_seats` set
at the snapshot instant, so "held a seat in `e-1`" is a deterministic,
auditable predicate baked into the §1 table construction.

Federation seats (a seat id that is a lower-tier *council address*, not a
person) are exempt from the personal cooldown — a cluster's structural
representation is not an individual holding power — unless a tier explicitly
opts its federation seats into rotation too.

---

## 7. What must be true for the table to be valid (preconditions)

An auditor rejects a rotation whose table violates any of:

1. **`n >= 5` distinct eligible members** after the §4 gate and §6 cooldown
   are applied. With fewer than 5, the fixed-5 council cannot be filled by a
   distinct-member draw. (Operational implication: a tier must reach 5+
   qualified, non-cooling members before it can run sortition; until then it
   runs the flat council or defers rotation. This bounds how early a young
   tier can decentralise.)
2. **Canonical order** (§1.2) — leaves sorted by `memberAddr`, indices
   contiguous, `cumulative` monotone, `cumulative[last] == totalWeight`.
3. **Snapshot timing** (§3) — every eligibility input is dated at/before the
   membership freeze `t0`, and `t0` precedes the seed reveal.
4. **Root match** — recomputed `membershipRoot` equals the on-chain value
   bound in the rotation.
5. **Draw match** — §2 run over `(table, revealed seed)` yields exactly the
   `incoming[5]` the council rotated in.

---

## 8. Minimal on-chain change (proposed)

The **only** contract change this design needs is to bind the eligibility
snapshot alongside the seed that's already bound. Concretely (proposed, not
implemented):

- Add a `membershipRoot: Bytes<32>` parameter to `executeRotateSeats` and
  `executeConveneRotation`, folded into the same signed structures:
  - `executeRotateSeats` actionHash grows `Vector<14>` → `Vector<15>`, adding
    `membershipRoot` (place it adjacent to `seedCommitment`).
  - `executeConveneRotation` parent message grows `Vector<10>` → `Vector<11>`,
    adding `membershipRoot`, so the parent's convene signature attests to the
    eligibility pool too — closing the "parent picks the pool" gap in the
    recovery path the same way it closes it in the normal path.
- Optionally record the last-rotation `membershipRoot` in a ledger field for
  convenience (not required for auditability — the value is already in the
  bound actionHash / signed message and in the public table publication).

Everything else in this note — table construction, ordering, the draw, the
gate, cooldown, timing — is **off-chain rule + tooling**, exactly parallel to
how the seed's draw is "auditable off-chain" today. No quorum, constitutional,
federation, or recovery mechanism changes.

**Not proposed here:** full **in-circuit** enforcement of the draw and the
gate (proving `incoming` was derived from `seed` over a Merkle-proven eligible
set, entirely on-chain). That is the larger future-work item the contract
header already flags as *"cryptographic enforcement of the draw itself is
future work."* This note makes the draw + pool **auditable**; a later revision
can make them **enforced**.

---

## 9. Open items before this could leave DEV DRAFT

1. Pin the concrete hash + Merkle arity + padding in a versioned
   `SORTITION-DRAW-SPEC` companion (so off-chain auditors and any future
   in-circuit prover agree bit-for-bit).
2. Decide seed source: commit-reveal (option A) vs future-block beacon
   (option B, preferred) — depends on what block-hash access the ceremony
   tooling has on Midnight.
3. Calibrate the §4 gate thresholds (X sessions, Y days) and the §6 cooldown
   length per tier — pilot defaults here are placeholders.
4. Confirm the eligibility data sources are queryable at snapshot time from a
   single consistent view (KYC status, distinct-session count, LD maturity /
   `accPerShare` checkpoint, live/pruned flag) — spans v2-api + settlement-api
   + LD contract state.
5. Independent review — like `multisig-federated-v1` itself, this is the
   author specifying the author; it needs the same external audit bar as the
   2026-06-10 findings before anything ships.

---

*Author: Joi. DEV DRAFT, 2026-07-10. Verified against
`multisig/multisig-federated-v1.compact` rev 4 (executeRotateSeats L444–L487,
executeConveneRotation L499–L545, ledger decls L152–L183, design-notes header
L36–L135) — the contract binds `seedCommitment` for off-chain audit but does
not pin the draw algorithm and has no on-chain eligibility set, which is the
gap this note addresses.*
