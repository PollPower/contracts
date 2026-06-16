# H-3 Finding: Unbounded Admin Set + Fixed Threshold (Governance Capture)

**Finding ID:** H-3 (High)
**Severity:** High — pre-mainnet must-fix. Not pilot-urgent (a single party
controls all five keys during the pilot).
**Contracts affected:** `multisig-v6-ed25519.compact` (PRODUCTION,
`f7192a50…62745c3a`) and `multisig-v6.1-ed25519.compact` (design artifact) —
identical governance logic.
**Reviewed against source:** 2026-06-16, deployed
`multisig-v6-ed25519.compact` (verified on Kenya settlement box, byte-identical
to the repo copy).
**Status:** OPEN — documented here; remediation (v6.2) staged for the
pre-mainnet hardening pass. See [Proposed fix](#proposed-fix-v62).

---

## The finding

`executeAddAdmin` grows the admin set without bound, while `_threshold` is a
fixed value set once at `initialize()` and never scales with the set size.
Together these let a one-time threshold-many compromise become **permanent,
self-entrenching control** of the council — and dilute every honest admin's
relative voting weight on the way.

This is a governance-capture vector, distinct from the H-2 single-admin issue
(v5) and from H-1 (pilot-mock keys). H-2 was about *missing* threshold
enforcement; H-3 is about threshold enforcement that is present but **does not
scale**, combined with an **uncapped** admin set.

---

## The mechanics (verified in source)

### 1. `executeAddAdmin` has no size cap

```compact
export circuit executeAddAdmin(
  newAdmin: Bytes<32>,
): [] {
  assert(_initialized, "Not initialized");

  const opSel = persistentHash<Bytes<32>>(pad(32, "v6:addAdmin"));
  const nextNonce = (_nonce.read() + 1 as Uint<64>) as Field as Bytes<32>;
  const actionHash = persistentHash<Vector<3, Bytes<32>>>([opSel, disclose(newAdmin), nextNonce]);

  assert(isApproved(actionHash), "addAdmin: not enough approvals");

  // Apply the change.
  _admins.insert(disclose(newAdmin));   // <-- no size bound

  _approvals.remove(actionHash);
  _nonce.increment(1);
}
```

The only gate is `isApproved(actionHash)` (threshold-many approvals). There is
no `assert(_admins.size() < N)`. The DESIGN docs describe the council as "up to
7" but the contract does not enforce any ceiling. The set can grow without
limit.

### 2. `_threshold` is fixed and never tracks set size

```compact
export ledger _threshold: Uint<8>;   // set once at initialize(), default 3
```

- `initialize()` sets `_threshold` and never lets it change except via
  `executeSetThreshold`.
- `executeAddAdmin` / `executeRemoveAdmin` do **not** touch `_threshold`.
- So `getApprovalCount(actionHash) >= _threshold` stays "≥ 3" no matter whether
  the set holds 5 admins or 50.

### 3. The init guard is hardcoded, not size-relative

```compact
assert(threshold <= 5 as Uint<8>, "Threshold must be <= initial admin count");
```

The `<= 5` is a literal tied to the (fixed) 5-arg `initialize()`. It encodes an
assumption — "threshold ≤ admin count" — as a constant. The assumption is fine;
hardcoding it as `5` is brittle and becomes meaningless once `N` can grow past 5.

### 4. `executeSetThreshold` exists but only bounds the *upper* side

```compact
assert((newThreshold as Uint<64>) <= _admins.size(), "Threshold > admin count");
```

A threshold change is gated to `1 ≤ newThreshold ≤ N`. There is **no lower
bound relative to a majority** of `N`. Even a deliberate `setThreshold` vote
cannot be forced to keep the threshold at a safe majority — and nothing
*requires* such a vote when the set grows. Threshold maintenance is entirely
optional and manual.

### What IS protected (for completeness)

- `executeAddAdmin` and `executeRemoveAdmin` both require threshold-many
  Ed25519 approvals (`isApproved`). A single admin cannot mutate the set (this
  is the v6 improvement over v5 / H-2).
- `executeRemoveAdmin` has a floor guard:
  `assert(_admins.size() > _threshold, "Would drop admin count below threshold")`.
  So an attacker cannot remove honest admins down to the point where they alone
  meet threshold. The capture vector is **addition**, not removal.

---

## The attack

The contract is safe against a *transient* threshold compromise — clear the
approvals, the attacker is locked out again. H-3 is about converting a
transient compromise into a **permanent** one.

1. An attacker achieves a one-time threshold capture: compromise or collude
   `_threshold` (= 3) of the council's rings, for one window. (In v6's threat
   model this is "game over for that window" — but the design intent is that
   the honest majority recovers once the window closes.)
2. While holding 3 approvals, the attacker calls `executeAddAdmin` repeatedly,
   inserting puppet keys they control. Each addition only needs the same 3
   approvals they already have.
3. Because `_threshold` never moves, every puppet they add is a *permanent*
   vote they own at the unchanged "3" bar. The honest admins' relative weight
   collapses:

   | Admin set | Threshold | Honest share to act |
   |---|---|---|
   | 5 admins (3 honest) | 3 | 3/5 = 60% |
   | 7 admins (3 honest + 2 puppets, started from 5) | 3 | honest 3 still meet it, but… |
   | 11 admins (3 honest + 8 puppets) | 3 | attacker's 8 puppets ≥ 3 ⇒ attacker acts unilaterally forever; honest 3 also still nominally ≥ 3 |

   The precise failure: once the attacker holds ≥ `_threshold` puppet keys, they
   can pass any future action — including `executeRemoveAdmin` of the honest
   admins (down to the floor guard) and `executeSetThreshold` — **without ever
   needing the honest admins again.** The transient capture is now permanent.
4. Even short of full takeover, unbounded growth + fixed threshold **dilutes**
   governance: a council that should require a *majority* of N now only ever
   requires a fixed 3, so the security margin silently erodes as the set grows.

The root cause is the decoupling of two invariants that should move together:
**set size** and **threshold**. v6 enforces "you need 3 approvals" but never
"3 must remain a majority," and never caps the set so that 3 stays meaningful.

---

## Proposed fix (v6.2)

Three coupled changes. All are in-circuit and cheap (no Poseidon-in-app cost
like M-2's v6.1 contractTag — these are all `_admins.size()` / `_threshold`
comparisons).

### Fix 1 — hard cap the admin set in `executeAddAdmin`

```compact
// bound dilution: the council is "up to MAX_ADMINS"
assert(_admins.size() < 7 as Uint<64>, "addAdmin: admin set at maximum");
_admins.insert(disclose(newAdmin));
```

Bounds the worst-case dilution to a known constant and matches the documented
"up to 7" intent. (Pick the ceiling deliberately — 7 keeps a 3-threshold below
majority-of-max, so Fix 2 still matters; see note below.)

### Fix 2 — couple threshold to size (the core fix)

Require the threshold to remain a strict majority of the set on **any** change
that alters `_admins.size()`. Two implementable variants:

**(a) Enforce majority in-circuit on every admin-set change** — simplest, no
extra vote needed:

```compact
// in executeAddAdmin AND executeRemoveAdmin, after the size change:
// require threshold to be a strict majority of the (new) admin count.
const n = _admins.size();
assert((_threshold as Uint<64>) * 2 as Uint<64> > n, "threshold must stay a majority");
```

The problem: `executeAddAdmin` doesn't itself change `_threshold`, so adding the
6th and 7th admin with threshold 3 would *fail* this assert (3*2=6 is not > 6,
and not > 7). That is arguably correct behavior — it forces the council to
raise the threshold (via `executeSetThreshold`) *before* it can grow past the
point where 3 stops being a majority. But it makes growth a two-step,
two-vote operation.

**(b) Bundle a threshold argument into the add/remove circuits** — atomic:

```compact
export circuit executeAddAdmin(
  newAdmin: Bytes<32>,
  newThreshold: Uint<8>,   // threshold to set atomically with the add
): [] {
  // … isApproved over a hash that ALSO binds newThreshold …
  _admins.insert(disclose(newAdmin));
  const n = _admins.size();
  assert((newThreshold as Uint<64>) * 2 as Uint<64> > n, "threshold must stay a majority");
  assert((newThreshold as Uint<64>) <= n, "threshold > admin count");
  _threshold = disclose(newThreshold);
  …
}
```

This makes "add an admin" and "set the new majority threshold" a single
approved action — the council votes on the resulting `(set, threshold)` pair,
which is what they actually care about. Recommended variant: **(b)**, because it
keeps the set/threshold invariant atomic and auditable in one actionHash.

### Fix 3 — make the init guard size-relative

```compact
// initialize() currently:
assert(threshold <= 5 as Uint<8>, "Threshold must be <= initial admin count");
// replace the literal 5 with the actual initial count, and add the majority floor:
assert(threshold <= 5 as Uint<8>, "threshold > initial admin count");      // 5 == the 5 admin args; keep but comment as count-derived
assert((threshold as Uint<64>) * 2 as Uint<64> > 5 as Uint<64>, "initial threshold must be a majority");  // forces >= 3 of 5
```

(With a fixed 5-arg `initialize()` the literal `5` is the true count, so the
upper guard is acceptable as-is once commented; the substantive addition is the
**majority floor** so a deploy can't start with a non-majority threshold.)

### Also consider — `executeSetThreshold` majority floor

`executeSetThreshold` should reject lowering the threshold below a majority of
the current set:

```compact
assert((newThreshold as Uint<64>) * 2 as Uint<64> > _admins.size(), "threshold must stay a majority");
```

Otherwise the same capture can be achieved by *lowering* the threshold rather
than adding puppets.

---

## Decision points for Garrett

1. **Patch now (v6.2) or document-only for the mainnet hardening pass?**
   Not pilot-urgent — Garrett currently controls all five keys, so the capture
   scenario has no adversary. But it is a genuine pre-mainnet must-fix, and the
   fix is small and in-circuit (cheap). Recommend: write v6.2 with Fixes 1–3 +
   the `setThreshold` floor, fold the deploy into the same ceremony as the H-2
   v6→production cutover and the H-1 Tangem ring swap (all three need fresh
   admin-tooling signatures anyway).

2. **Admin-set ceiling value.** "Up to 7" is the documented intent. Confirm 7
   (or pick another N). Note the interaction with Fix 2: if the ceiling is 7
   and threshold must stay a strict majority, the council can only grow to 7
   with threshold 4 — i.e. growth past 5 *requires* a threshold raise. That is
   the desired coupling.

3. **Variant (a) vs (b) for Fix 2.** (b) is atomic and recommended; it changes
   the `executeAddAdmin` / `executeRemoveAdmin` signatures (extra `newThreshold`
   arg, bound into the actionHash), which means an admin-tooling update
   (`actionHash.ts` op canonicalization). (a) needs no signature change but
   makes growth a two-vote dance and can surprise operators with a failed add.

---

## What this finding does NOT claim

- It does not claim the pilot is at risk. With one operator holding all keys
  there is no second party to collude with; the dilution math is hypothetical
  until the Tangem ring swap distributes keys to a real council.
- It does not overlap with H-2 (that was v5's *missing* threshold check; v6
  already requires threshold-many approvals). H-3 is specifically about the set
  being **uncapped** and the threshold being **fixed**.
- It does not require an off-chain or Poseidon-in-app change. Unlike M-2, every
  proposed fix is a plain integer comparison already available in-circuit.

---

*Reviewed 2026-06-16. Source verified against the deployed
`multisig-v6-ed25519.compact`. Remediation staged for the pre-mainnet hardening
pass (v6.2), to be bundled with the H-1 ring-swap and H-2 cutover ceremony.*
