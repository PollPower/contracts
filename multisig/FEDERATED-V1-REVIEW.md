# multisig-federated-v1 — self-adversarial review (2026-07-08)

Reviewer: Joi (author-adversarial pass; an independent audit is still required
before this leaves DEV — same bar as the 2026-06-10 Fable 5 audit of v5/v6).
Scope: `multisig-federated-v1.compact` rev 4 + tooling.
Method: attacker walkthrough per circuit; state-machine edge enumeration;
comparison against the v6.2 audit findings (H-3, M-2, L-2, L-3) and the
fractal-federation design doc §1/§4/§7/§8.

## Findings — fixed in rev 4

### F-1 (Medium): federating a seat was irreversible
`executeSetSeatAttestor` could convert a direct seat to a federation seat, but
nothing could convert it back. `_federated` entries persist across rotations
for the same id, so a seat id accidentally (or maliciously, via one approved
action) federated with attacker-controlled attestor could never sign directly
again; the "fix" would have required rotating the seat id itself out.
**Fix:** `executeClearSeatAttestor` (council-approved, symmetric preimage
`[opSel, self, seatId, nonce]`). Covered by 2 new smoke tests.

### F-2 (Medium): convene signature was replayable within an epoch window
The parent's convene message bound (domain, self, epoch, incoming, seed) but
NOT the convene time. A parent signature obtained once could be held and
submitted in ANY later dead-window of the same epoch — e.g. parent signs
during a legitimate outage, council recovers without rotating (epoch
unchanged), council later goes quiet again, and the stale convene lands with
seats chosen for a months-old context.
**Fix:** `currentTime` folded into the signed message (field 4). The signature
now attests to one exact convene moment; any replay needs a fresh parent
signature. Tooling `computeConveneMessage` updated to take `currentTime`.

## Findings — accepted risks (documented, not fixed)

### A-1 (Low): liveness clock can be aged by lazy timestamps
`touchCouncilClock` accepts any `currentTime` in `[lastCouncilActionTime,
blockTime]`. A council that persistently passes stale-but-monotonic times
under-advances its own clock, shortening the effective distance to the
convene deadline. Impact: the council can only hurt ITSELF (become
convene-able sooner); the parent gains nothing it couldn't get by waiting.
Honest ceremony tooling always passes wall-clock now. Accepted.

### A-2 (Low): approvals for never-executed actions accumulate forever
`_approvals` entries are only removed by the matching execute* or by epoch
turnover making them unreachable (key includes epoch). Unexecuted approvals
from the current epoch persist. Impact: unbounded-but-slow ledger growth, no
authorization impact (execution still requires threshold + nonce match).
Same behavior as v5/v6/v6.2. Accepted; rotation acts as a natural GC horizon.

### A-3 (Info): rotateSeats does not verify outgoing = COMPLETE current set
The 5 outgoing entries must each be current seats and the final set must be
exactly the 5 distinct incoming ids (resetToDefault + size assert), so the
outcome is always well-formed regardless. The outgoing vector is bound into
the approved actionHash for ceremony auditability, not enforcement. A quorum
approving rotation with a wrong-but-valid outgoing list is a quorum approving
rotation — same trust as any rotation. Accepted.

### A-4 (Info): duplicate outgoing ids pass membership checks
E.g. outgoing = [a,a,b,c,d] passes the 5 membership asserts. Harmless:
`resetToDefault()` wipes the set wholesale, so outgoing plays no role in the
resulting state (see A-3). The size==5 assert on incoming is the real guard.
Accepted.

### A-5 (Low): parent + authority key overlap is not prevented
Nothing stops `_parentAuthority == _constitutionalAuthority` (it is even the
documented configuration at the network root). At non-root tiers, an operator
error that sets both to the same key would concentrate recovery + referendum
power. Deploy ceremony checklist item, not an in-circuit rule (the root
configuration must remain legal). Documented for the runbook.

## Cross-checks against prior audit classes

| Prior finding | Status in federated-v1 |
|---|---|
| H-3 unbounded admin set | Structurally absent (fixed 5-seat, wholesale rotation) |
| M-2 cross-deployment replay | Closed in-circuit: kernel.self() in every actionHash AND every signing message |
| L-2 generic execute nonce-binding | Same residual as all versions; `computeGenericActionHash` convention binds self+nonce off-chain |
| L-3 timestamp validation | blockTimeGte + monotonicity on every execute*; convene additionally binds time into the parent sig (F-2) |
| v6.2 majority floors | Preserved (init, setThreshold), plus constitutional gate on top |

## Residual work before leaving DEV

1. Independent audit (this document is the author reviewing the author).
2. T-1: convene elapsed-period path on testnet (offline runtime pins block
   time at 0; the 30-day gate cannot be exercised offline).
3. Poll-gated constitutional authority service (production path; design in
   contract header).
4. Deploy-ceremony runbook: A-5 key-distinctness check, seed-commitment
   publication procedure, attestor key custody (Meter Authority pattern).
