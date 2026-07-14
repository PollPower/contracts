# WI-13 Red-Team Memo — "Worst Compliant Implementation"

**Purpose:** plan §5.4 mandates that the supervising session — not the
executing session — writes a red-team pass *before* dispatch for
💰/🏛-class items. WI-13 is 🏛-class. This memo is that pass.

**Method:** answer the question "what is the worst compliant
implementation of `WI-13-TariffRegistry.md`?" — i.e. what implementation
technically satisfies every stated requirement while being maximally
dangerous. Then note the specific brief clause that guards against each,
and — where the guard is weak — recommend a brief amendment.

**Status:** authored 2026-07-14. To be re-read by the executing session
as part of their dispatch-time context, and used by the reviewing BIG
session as a checklist.

---

## Failure modes

### F-1. Registry check as warning, not fail (I-A bypass)

**The attack:** `registerSchedule` accepts a schedule whose `nationRef`
/ `operatorId` is not in the charter registry, but emits a
`SchedulePendingCharter` warning event instead of reverting. The
implementer justifies this as "flexibility for phased rollout" or
"charter-may-arrive-later."

**Consequence:** the D-4 same-tree invariant is dead. A schedule can
exist for an ungoverned entity. WI-14 settlement will resolve against
it. The federation's constitutional guarantee that "companies price,
members bound" collapses into "companies price, floors optional."

**Brief guard:** I-A is stated as a **construction, not a check**:
"registerSchedule MUST fail if... [T]he circuit verifies this against
the charter registry — no schedule for an ungoverned entity."
Additionally, test T2 (I-A negative) fails the entire suite if this
regresses.

**Guard strength:** STRONG. But the brief could be even more explicit
that "MUST fail" means REVERT and does not permit a "soft-fail with
warning event" interpretation. **Recommendation:** at dispatch-time,
add to the WI-13 executing prompt: *"MUST fail" in this brief means
circuit-level revert. No warning-event soft-fails.*

---

### F-2. Federation-gating leaf ops "for safety"

**The attack:** `retuneClass` (the leaf-op the brief explicitly leaves
un-gated) picks up a federation approval requirement "because
retunes could be adversarial." Implementer thinks they're being
defensive. Reviewer misses it because "more governance = safer" is a
common intuition.

**Consequence:** the constitutional preamble collapses. Companies
can't retune within floors without member approval. Members are now
setting prices, not bounds. The system becomes politically
unstable at scale (councils micromanaging operator business
decisions) or effectively frozen (councils don't have time to
approve every retune). Either way the "companies price" clause is
dead.

**Brief guard:** DO NOT list explicitly forbids federation-gating
`retuneClass`. Reasoning is stated ("companies get the leaves").
Constitutional preamble is in READ FIRST §1.

**Guard strength:** MEDIUM. Common failure mode of well-intentioned
implementers is to add "extra safety." **Recommendation:** in the
executing prompt, explicitly frame this as: *retuneClass is
permissionless-within-bounds by design; the SAFETY property is the
in-circuit floor check (I-B), not federation gating. Adding
federation gating REDUCES safety by collapsing the separation of
powers.*

---

### F-3. Contract-to-contract call to WI-13 charter registry

**The attack:** `registerSchedule` needs to verify the node is
chartered (I-A). The simplest way to do that "correctly" is to call
the charter registry contract directly. Implementer writes the
contract-to-contract call. It compiles. Everyone assumes it works.

**Consequence:** Compact forbids contract-to-contract calls. Either
the contract fails to deploy, OR (worse) the implementer works around
the compiler restriction with some MIP-0002-adjacent hack that
technically compiles but bypasses the event/keeper integration
pattern the rest of the system relies on.

**Brief guard:** invariant I-G names "no contract-to-contract calls
(WI-14 consumes via view + event)." Plan §0.2 standing discipline says
"no contract-to-contract calls (MIP-0002 event + keeper is the
integration pattern)." BOOTSTRAP-PROMPT reiterates it.

**Guard strength:** STRONG at the compile level. WEAKER at the
architectural level — the executing session needs to *understand* the
event/keeper pattern, not just avoid direct calls. **Recommendation:**
add to executing prompt: *if you find yourself wanting to check
charter state from inside a WI-13 circuit and it feels awkward, that
is because the circuit should be verifying a witness (a charter
existence proof) provided by the caller, NOT reading charter state
directly. The keeper mirrors charter state into a form the witness
can prove against.*

---

### F-4. `federationApproval` verified against wrong seat's attestor

**The attack:** `registerSchedule` and `registerLane` require a
`federationApproval` witness. The circuit verifies the signature. But
"correctly" — for the wrong `_attestors` entry. Off-by-one on which
tier's council is authoritative for this schedule's `nationRef`.
Compiles, passes happy-path tests, fails only under an adversarial
input.

**Consequence:** an attacker with control of one council can approve
schedules that should require another council. Cross-tier governance
capture becomes a one-council attack instead of a coordination attack.

**Brief guard:** I-D fail-closed clause: "attestorSignature MUST
verify against the appropriate seat's `_attestors` key AND MUST be for
a fresh action hash." Test T5 (I-D forgery) exercises this.

**Guard strength:** MEDIUM. T5 catches one wrong-seat case, but the
"which seat is appropriate for this nationRef" logic is where the
bug lives, and the brief doesn't spell out the mapping. **Recommendation:**
executing prompt should mandate that the schedule-to-seat mapping is
made explicit in `V1-DESIGN.md`, with a diagram, and that at least
two of the negative tests exercise different wrong-seat combinations
(not just "unregistered key").

---

### F-5. Sanity-band check on schedule registration but not on retune

**The attack:** `registerSchedule` correctly validates the sanity band
against `fiatValueAtMint` bounds. `retuneClass` recomputes floor
checks (I-B) but silently drops the sanity-band check because "the
schedule was band-checked at registration; the retune only changes
split bps, not band."

**Consequence:** a sequence of small retunes drifts a schedule past
the sanity band without ever failing a single retune. WI-14 later
mints coins that pass I-14-C (sum-to-10000) and I-14-E (immutability)
but whose `fiatValueAtMint` is now outside the band the CBK / trust
regulator was told about. Regulatory story quietly breaks; on-chain
state technically fine.

**Brief guard:** I-B mentions "sanity band from WI-06" as part of the
retune check. But the brief could be read as "the floor check is
mandatory; the sanity band is a WI-06 thing." Test T3 covers floor
negatives but the brief doesn't require a sanity-band retune
negative.

**Guard strength:** WEAK. **Recommendation:** amend WI-13 brief at
dispatch-time to require an explicit sanity-band retune negative test
(T3.5 or similar). Also make explicit in I-B: *sanity band re-checked
on every retune, not just at registration.*

---

### F-6. `resolvePath` returns cached/stale splits after retune

**The attack:** `resolvePath` is a read-only view that returns splits.
For performance or "consistency," implementer caches the resolved
splits per (scheduleId, path). A retune updates the schedule but
misses the cache invalidation. Downstream WI-14 settlements resolve
against stale splits.

**Consequence:** WI-14 mints splits from the pre-retune schedule.
Sum-to-10000 might still hold (if the retune preserved the sum), but
the individual lane amounts are wrong. Money routes to the wrong
places for a period of time between retune and cache eviction.

**Brief guard:** the brief doesn't discuss caching. Compact
semantics don't natively cache, so this is a non-issue at the
contract level — but if the executing session builds a keeper-side
mirror that WI-14 reads (per event/keeper pattern), the mirror IS a
cache and the invalidation logic lives there.

**Guard strength:** GAP. **Recommendation:** WI-13's design doc MUST
specify the keeper-mirror invalidation semantics explicitly. This is
technically in scope for WI-14's reader-side design, but the
publisher-side (WI-13) must define what event(s) fire on retune such
that a keeper can invalidate correctly. Add to executing prompt:
*every state-mutating circuit MUST emit an event sufficient for
downstream keepers to invalidate their view. Enumerate the events in
V1-DESIGN.md.*

---

### F-7. Epoch monotonicity implemented via wall clock

**The attack:** `EPOCH` is supposed to be monotone-increasing (I-E).
Implementer reads it from a witness ("current epoch is epoch") and
disclose()s. Witness could be lied to. Or the implementer uses a
block-time-derived epoch that isn't strictly monotone across reorgs.

**Consequence:** an attacker can register a schedule at epoch e-1
after epoch e schedules exist, backdating the schedule's validity.
`resolvePath` at epoch e-1 now returns the attacker's splits.

**Brief guard:** I-E states monotonicity; sealed `EPOCH` field in
`constructor()`. But the brief doesn't specify HOW `EPOCH`
increments — is it manual (advance-epoch circuit)? Automatic
(block-tied)? Externally attested?

**Guard strength:** WEAK. **Recommendation:** executing prompt must
require the epoch-advance mechanism to be a named circuit
(`advanceEpoch()`) with its own gating (federation approval,
timelock, or both). Explicitly forbid deriving `EPOCH` from block
time or from a witness disclosure.

---

### F-8. "While I'm in there" refactor of an adjacent contract

**The attack:** implementer, while writing WI-13, notices that
`multisig-federated-v1.compact` has a signature pattern that would
be cleaner if refactored slightly. Refactors it. Now the diff touches
a file not in DELIVERABLE.

**Consequence:** the reviewing session's mental model of "what this
PR does" is broken. A subtle behavioral change to
`multisig-federated-v1` slips through review because reviewers were
focused on `tariff-registry-v1.compact`.

**Brief guard:** DO NOT list forbids modifying `ebt/*`, `living-dividend/*`, `multisig/*`.
Escalation trigger 3 fires on "change wants to touch a file not
named in the brief."

**Guard strength:** STRONG in the brief; MEDIUM in enforcement (needs
the executing session to actually escalate rather than "help").
**Recommendation:** BOOTSTRAP-PROMPT already covers this ("if you
find yourself justifying a workaround, that is an escalation
trigger"). Reinforce at dispatch by making it the FIRST rule the
executing session acknowledges.

---

## Summary — brief amendments to make at dispatch time

Bundle these into the executing-session dispatch memo (not the brief
itself, so the brief stays canonical):

1. *"MUST fail" means revert, not warning event.* (F-1)
2. *retuneClass ungated is a safety feature; adding gating reduces safety.* (F-2)
3. *If checking charter state feels awkward, use witness+keeper, not direct read.* (F-3)
4. *Diagram schedule-to-seat mapping in V1-DESIGN.md; test at least two wrong-seat combos.* (F-4)
5. *Sanity band re-checked on every retune, not just registration; add T3.5 negative.* (F-5)
6. *Enumerate all state-change events for downstream keeper invalidation.* (F-6)
7. *EPOCH advance is a named circuit with gating, not derived from block time or witness disclosure.* (F-7)
8. *Escalation trigger 3 is the FIRST rule; acknowledge before writing any code.* (F-8)

## Guards to add to the brief itself (not just dispatch)

At next brief revision, incorporate:
- I-B explicit sanity-band re-check clause (from F-5).
- New invariant I-H: "EPOCH advance is a named circuit; never derived
  from witness or block time." (from F-7)
- New invariant I-I: "every state-mutating circuit emits an event
  sufficient for keeper-side view invalidation; events enumerated in
  V1-DESIGN.md." (from F-6)

Do NOT amend before this dispatch — the brief is already published in
PR #28 and the executing session should work against the version they
were dispatched with. Amendments land in the *next* brief version if
a re-dispatch happens.

---

## What this memo is NOT

- Not a critique of the brief. The brief is good enough to dispatch
  as-is with the dispatch-memo amendments above.
- Not exhaustive. It's the top-N failure modes a well-intentioned
  executing session might hit.
- Not a substitute for the second BIG review pass. §5.1 🏛 row still
  requires one BIG adversarial review; this memo is that review's
  starting checklist.

---

*Red-team pass authored 2026-07-14 by supervising session, per plan
§5.4 supervising-session checklist. To be read by the executing session
at dispatch and by the reviewing session before merge.*
