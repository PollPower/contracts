# Sortition Table — draw-integrity & eligibility design

> **STATUS: DEV DRAFT — PROPOSED, NOT IMPLEMENTED.**
> This is a policy + verification layer specified on top of the existing
> `multisig-federated-v1.compact` (itself a DEV DRAFT: not deployed, not
> audited, not on the pilot's critical path — the pilot runs on flat
> Multisig v7). Nothing here has been built, compiled, or reviewed. It
> proposes **one small multisig contract addition** (a `membershipRoot`
> bound alongside the existing `seedCommitment`) plus a body of **off-chain
> table-construction rules**, and an **accept/decline + service-reward**
> policy (§7) whose only on-chain footprint — a temporary Living-Dividend
> share multiplier for members who serve — lands in the **LD contract**, not
> the multisig. No change to the council mechanism, the quorum logic, the
> constitutional floor, the federation-seat path, or the recovery path is
> required or proposed.

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

## 7. Accept / decline & the service reward

Sortition is **jury duty**: being drawn is not the same as agreeing to serve.
The draw (§2) *summons* 5 winners; it does not conscript them. Not everyone
can (or should) serve every time they're drawn — someone is travelling, ill,
or simply unwilling — so the design needs a real accept/decline step. The
challenge is to allow declining **without** letting service quietly collapse
into "only the eager serve," which would re-introduce the self-selection that
sortition exists to defeat.

### 7.1 Acceptance window

After the draw yields `selected[0..4]`, each winner has a fixed **acceptance
window** (pilot default: a few days) to confirm. This is **opt-out, not
opt-in**: silence past the window counts as a decline. Acceptance is a signed
message from the drawn member's key (or, for a federation seat, the lower-tier
council's attestor per the existing §8-federation path).

### 7.2 Declining is free; backfill continues the *same* draw

A member may decline for any reason, with **no justification required and no
direct penalty**. That is the honest "not everyone can participate" reality;
punishing a plain decline would either coerce unwilling members into being bad
councillors or push people to avoid qualifying at all.

A decline (or a window timeout) is simply **another reason to advance the
draw**. The §2 procedure already advances `k` on a collision; a decline is
treated identically — keep drawing from the **same frozen table and the same
revealed seed**, advancing `k`, until 5 members have accepted. This is
critical for auditability: backfill must **never** trigger a re-draw with a
new seed (that would open a grinding window, §3). Same `(table, seed)` +
the public ordered list of declines ⇒ the same final 5 acceptances for every
observer.

> **Precondition tightens (see §8):** because declines consume draw slots,
> the table needs enough eligible members that 5 will still accept after
> expected declines — not merely `n >= 5`. A tier with exactly 5 eligible
> members and any decline cannot fill the council; it must defer rotation or
> widen eligibility.

### 7.3 Consequences — asymmetric and mild

| event | consequence |
|---|---|
| **Not qualifying** (novice / below the §4 gate) | **None.** Being unproven is not a fault; the gate is a gate, not a punishment. |
| **Decline within the window** | **No penalty**, but a short **decline cooldown** (N epochs, pilot default 1) before the table may draw the member again. This is not punitive — it stops the draw repeatedly landing on someone who has said no, and gives others a turn. |
| **Accept then ghost** (confirm, then fail to sign the epoch's quorum actions) | The material one, because a no-show is 20% of a 5-seat quorum. Removal via the constitutional / parent-convene path (§ contract) **and** a longer eligibility cooldown. **Not** a funds slash — governance dereliction is a broken commitment, not theft. |

Governing consequences reuse existing contract machinery: a ghosting seat is
removed by the same rotation/convene paths that already exist; no new
penalty primitive is proposed.

### 7.4 The service reward — a temporary LD share multiplier

Garrett's design (2026-07-10): reward the *act of serving* by **boosting the
serving member's Living-Dividend share for a bounded time**, rather than
minting a separate stipend. A councillor who demonstrably serves epoch `e`
receives a **multiplier on their LD accrual** (e.g. 1.5× for the served epoch,
or 1.25× for the next N epochs) — paid *through the dividend pool they are
already in*, not as a new token.

**Why a share multiplier is the right shape:**

- **It self-selects toward need — without measuring need.** A boosted share is
  worth more, in real terms, to whoever depends more on the dividend. A
  comfortable member is near-indifferent to a 1.5× boost; a member who relies
  on the dividend finds it genuinely worth accepting the seat for. So the
  "those more in need serve more willingly" effect emerges **organically from
  the market**, with **no need-proxy, no means-test, and no farmable
  neediness signal** for the system to infer. (This is strictly better than an
  inverse-`accPerShare` bonus, which was farmable and paternalistic.)
- **It fits the LD contract's existing shape.** LD already pays each member as
  `accPerShare` × their share weight. A service boost is a temporary bump to
  that member's effective share weight (or a claim-time multiplier) for the
  boost window — close to the accumulator the pool already runs.

**Load-bearing constraint — the tilt goes on the *payout*, never the *draw*.**
The draw stays a flat, gated, equal-weight lottery (§4). We do **not** make
needier members more likely to be *drawn* — that would rebuild plutocracy
upside-down (selection tracking a wealth signal, with "neediness" as the new
farm target). Need influences only *how much a served seat is worth to you*,
via a reward that anyone drawn can earn equally. Selection fairness is
untouched.

**Guardrails (all pilot-calibration parameters):**

1. **Earned by participation, not by acceptance.** The multiplier activates
   only for an epoch the member **demonstrably served** (signed at least the
   quorum actions), not merely by being drawn and confirming. This makes it
   **clawback-free**: a ghosting councillor's boost simply never activates, so
   there is nothing to reclaim. It also aligns the reward with §7.3's
   accept-then-ghost consequence.
2. **Bounded total boost.** A boosted member is a larger slice of a fixed pie,
   so every non-serving member's slice shrinks slightly while boosts are live.
   That is intended (the commons pays its stewards) but must be **capped**:
   with rotation, this epoch's 5 and recent epochs' boosted members can be
   active simultaneously, so a ceiling on *total concurrent boost* must
   guarantee the non-serving majority is never diluted below a floor. The
   per-epoch service-reward budget needs an explicit maximum.
3. **Concave / capped magnitude.** Keep the multiplier modest and fixed
   (a small constant, not a slope), so the reward is an incentive, not a
   windfall that would distort the dividend's core purpose.

**Interlock with anti-incumbency (§6).** These two mechanisms protect each
other. The reward makes service attractive; the §6 last-epoch cooldown means
you **cannot** serve again the very next epoch, so the boost **cannot compound
into "serve forever, earn double forever."** The cooldown naturally caps how
often anyone collects the reward — reward and cooldown together make service
*attractive but non-rent-seeking*.

---

## 8. What must be true for the table to be valid (preconditions)

An auditor rejects a rotation whose table violates any of:

1. **Enough eligible members to fill 5 seats after expected declines** — a
   hard floor of `n >= 5` distinct eligible members after the §4 gate, §6
   anti-incumbency cooldown, and §7.2 decline cooldowns are applied, and in
   practice a margin above 5 so the §7.2 accept/decline backfill can still
   reach 5 acceptances. With too few, the fixed-5 council cannot be filled by
   a distinct-member draw. (Operational implication: a tier must reach a
   comfortable pool of qualified, non-cooling members before it can run
   sortition; until then it runs the flat council or defers rotation. This
   bounds how early a young tier can decentralise.)
2. **Canonical order** (§1.2) — leaves sorted by `memberAddr`, indices
   contiguous, `cumulative` monotone, `cumulative[last] == totalWeight`.
3. **Snapshot timing** (§3) — every eligibility input is dated at/before the
   membership freeze `t0`, and `t0` precedes the seed reveal.
4. **Root match** — recomputed `membershipRoot` equals the on-chain value
   bound in the rotation.
5. **Draw match** — §2 run over `(table, revealed seed)` yields exactly the
   `incoming[5]` the council rotated in.

---

## 9. Minimal on-chain change (proposed)

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
gate, cooldown, accept/decline, service reward, timing — is **off-chain rule +
tooling**, exactly parallel to
how the seed's draw is "auditable off-chain" today. No quorum, constitutional,
federation, or recovery mechanism changes.

The **service reward** (§7.4) touches the **LD contract**, not the multisig:
it is a temporary share multiplier on the dividend pool, so its on-chain
footprint (if built) lands in `living-dividend-v*`, gated on demonstrated
service in the epoch. It is **not** part of the multisig `membershipRoot`
change above and is specified here as policy, not implemented.

**Not proposed here:** full **in-circuit** enforcement of the draw and the
gate (proving `incoming` was derived from `seed` over a Merkle-proven eligible
set, entirely on-chain). That is the larger future-work item the contract
header already flags as *"cryptographic enforcement of the draw itself is
future work."* This note makes the draw + pool **auditable**; a later revision
can make them **enforced**.

---

## 10. Future extensions (proposed, beyond the pilot)

Two ideas that are **not** needed for the mechanism to work, but strengthen
its legitimacy and capture-resistance. Both are DEV DRAFT / for discussion.
Build only after real humans have used the simpler version — keep them as
tunable modules, not load-bearing walls.

### 10.1 Turnout-scaled constitutional floor

The constitutional floor (§ contract; rule changes need a passed member
referendum via Community Poll v2) currently treats a referendum as a binary
pass/fail. But in a member network, **who *didn't* vote is as meaningful as
who did.** A rule change that "passes" on 12% turnout is not a mandate — it is
apathy that a motivated minority exploited.

**Proposal:** require a **turnout floor that scales with the magnitude of the
change.** Low-stakes operations (e.g. rotating the Meter Authority) need only
modest participation; high-stakes changes (e.g. rewriting the dividend split,
the eligibility gate, or the constitutional authority itself) require
supermajority *participation*, not just a majority of those who bothered.

**Cost:** near-zero on-chain — Community Poll v2 already counts votes and
knows the eligible-member denominator. The constitutional-authority attestation
simply checks turnout ≥ the class-specific floor before signing. It is the
difference between "technically passed" and "the community actually decided,"
and it closes the failure mode where a captured-but-quorate council pushes a
rule change past a sleepy electorate. **Recommended as a pre-mainnet inclusion.**

### 10.2 Community-seeded randomness

The draw seed (§3) is proposed as a commit-reveal value or a future block-hash
beacon. A stronger, and more *fitting*, source: derive the seed from the
**community's own aggregate settlement activity** for the epoch — e.g.
`seed = H("pp:sortition:beacon:v2" ‖ aggregateSettlementDigest_e)`, where the
digest commits the epoch's real metered sessions across all gateways.

**Why it's better, not just poetic:**

- **Capture-resistance.** To grind a block-hash beacon you attack the chain;
  to grind *this* you would have to control the entire epoch's real energy
  trading across every village — vastly harder, and self-defeating (you'd have
  to transact honestly at scale to move it).
- **Legitimacy story.** The "dice roll" that chooses a tier's governors is
  literally *made of that community's own economic life that month.* The
  randomness is theirs, not an external oracle's.

**Caveats (why it's exploratory, not recommended-yet):**

- **Grindability at the margin.** A large player could try to nudge the digest
  by timing/shaping their own sessions near the epoch boundary. With enough
  participants the marginal influence is negligible, but it **must be modelled**
  before trusting it — the snapshot-timing discipline (§3) and a large-`n`
  precondition apply doubly here.
- **Determinism.** The aggregate digest must be a canonical, replayable
  function of on-chain settlement state at a fixed height, or the whole draw
  loses its "everyone recomputes the same result" property.

**Status:** prototype and adversarially model before trusting; keep the
block-hash beacon (§3 option B) as the default until then.

---

## 11. Open items before this could leave DEV DRAFT

1. Pin the concrete hash + Merkle arity + padding in a versioned
   `SORTITION-DRAW-SPEC` companion (so off-chain auditors and any future
   in-circuit prover agree bit-for-bit).
2. Decide seed source: commit-reveal (option A) vs future-block beacon
   (option B, preferred) — depends on what block-hash access the ceremony
   tooling has on Midnight.
3. Calibrate the §4 gate thresholds (X sessions, Y days) and the §6 cooldown
   length per tier — pilot defaults here are placeholders.
4. Calibrate the §7 accept/decline + service-reward parameters — acceptance
   window length, §7.3 decline cooldown (N epochs) and accept-then-ghost
   cooldown, the §7.4 share-multiplier magnitude + duration, and the total
   concurrent-boost ceiling (dilution floor for non-serving members). All
   pilot defaults here are placeholders needing Garrett's calibration.
5. Decide where the §7.4 service reward is enforced in the LD contract
   (effective-share bump vs claim-time multiplier) and how "demonstrably
   served this epoch" is proven to it (which quorum-action signatures count).
6. Confirm the eligibility data sources are queryable at snapshot time from a
   single consistent view (KYC status, distinct-session count, LD maturity /
   `accPerShare` checkpoint, live/pruned flag) — spans v2-api + settlement-api
   + LD contract state.
7. §10.1 turnout-scaled floor: define the change-magnitude classes and their
   participation thresholds; wire the turnout check into the
   constitutional-authority attestation path (Community Poll v2 already has
   the vote counts + eligible denominator).
8. §10.2 community-seeded randomness: model the marginal-grindability of the
   aggregate settlement digest at pilot `n` before adopting it over the
   block-hash beacon; define the canonical replayable digest function.
9. Independent review — like `multisig-federated-v1` itself, this is the
   author specifying the author; it needs the same external audit bar as the
   2026-06-10 findings before anything ships.

---

*Author: Joi. DEV DRAFT, 2026-07-10. Verified against
`multisig/multisig-federated-v1.compact` rev 4 (executeRotateSeats L444–L487,
executeConveneRotation L499–L545, ledger decls L152–L183, design-notes header
L36–L135) — the contract binds `seedCommitment` for off-chain audit but does
not pin the draw algorithm and has no on-chain eligibility set, which is the
gap this note addresses.*
