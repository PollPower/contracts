# National Escrow — Custody of Backing Fiat (A-2 resolution)

**Status:** DESIGN DRAFT — spec/policy only, no contract code. Not deployed,
not audited. Contains **regulatory and legal positions that require the legal
team's confirmation** — it is a design-ahead, not legal advice.
**Layer:** Post-pilot. The pilot runs a single operator holding its own float;
this document is the multi-operator custody model that must exist before a
*second* operator onboards.
**Work item:** WI-01 of [`FEDERATION-IMPLEMENTATION-PLAN.md`](./FEDERATION-IMPLEMENTATION-PLAN.md).
**Resolves:** finding **A-2** ("where does the jar live?") from
[`FEDERATED-TARIFF-OPEN-QUESTIONS.md`](./FEDERATED-TARIFF-OPEN-QUESTIONS.md).
**Prerequisite for:** WI-02 (A-1 clearinghouse), WI-14 (settlement redemption
semantics), NATIONAL-ONBOARDING Phase 2 (wallet tiers), C-9 (operator wind-down).
**Implements decision D-1** (protocol-controlled national escrow pool; operators
never own the float) and the WI-01 decisions taken 2026-07-13 (D-5..D-9 below).

## 0. What this document is

D-1 set the *direction*: backing fiat lives in a protocol-controlled national
escrow pool, not on operator balance sheets. This document is the *how* — the
legal wrapper, the money-movement authorization, the solvency invariant, and
the operator lifecycle (de-federation and voluntary exit) — resolved to the
decisions Garrett took on 2026-07-13. It builds **for the full vision**: EBT is
redeemable for **both KES and kWh**. There is no prepaid-credit fallback; dual
redemption is load-bearing to the project thesis, so the design treats CBK
e-money authorization as a prerequisite the legal team clears, not a constraint
to design around.

### 0.1 Decisions taken (2026-07-13, Garrett) — the spine of this doc

- **D-5 (framing + license):** EBT is **regulated e-money**, redeemable for
  **both cash (KES) and energy (kWh)**. CBK e-money regime governs; EPRA governs
  the energy side. **Prepaid-energy-credit framing is rejected** — dual
  redemption is critical to the thesis. Launch waits on the e-money authorization
  path, it does not ship a cash-less compromise.
- **D-6 (custody wrapper):** the pool is a **regulated e-money float**, held on
  the M-Pesa model — a **trust account holding the float for the benefit of
  token holders**, operated by a licensed e-money issuer (PollPower as licensee,
  or a licensed partner). Operators never own the float.
- **D-7 (instruction authority):** fiat is released from the pool on the
  **same attestation that mints EBT** — one authorization, atomically tying
  fiat-out to EBT-mint against a single replay-guarded settlement proof. No
  separate release authorization.
- **D-8 (solvency):** a **published on-chain solvency invariant** — outstanding
  EBT × recorded backing == attested pool balance — verifiable by anyone, not
  merely audited.
- **D-9 (operator lifecycle):** de-federation revokes **future** mint/instruct
  authority only; in-flight settlements complete via a **drain window**;
  voluntary exit uses a **fixed notice period**. Minted EBT is always safe
  (always backed in the pool); members are always safe (they belong to the
  network, not the operator).

---

## 1. The invariant everything protects

> **Minted EBT is always backed, and members always belong to the network.**

Two consequences that make the operator lifecycle (§5) simple:

- Because the pool (not the operator) holds the float, **no operator action —
  failure, ejection, or exit — can strand or drain backing.** The fiat behind an
  EBT is in the trust the moment the EBT was minted (I-2, mint-after-payment).
- Because members are individuals in the national LD pool (D-3), **no operator
  leaving takes its people with it.** An operator's departure changes only
  *future authorization*, never *existing value* or *membership*.

Everything below is machinery in service of this one invariant.

---

## 2. The custody wrapper (D-5 / D-6)

### 2.1 Structure

The backing fiat sits in a **trust account**, held for the benefit of EBT
holders, operated by a **licensed e-money issuer**. This is the M-Pesa model:
Safaricom holds customer float in trust accounts under CBK's e-money regulations
and cannot treat it as its own capital. PollPower's national pool is the same
shape:

- The **licensee** (PollPower or a licensed partner e-money institution) is the
  legal operator of the float.
- The **beneficiaries** are the EBT holders, collectively.
- The **protocol** is the instructing party: it directs releases per §3, but the
  licensee executes them within its regulated obligations.
- **Operators** originate consumer payments *into* the trust and instruct splits
  *out* of it; they never hold, own, or commingle the float.

### 2.2 Regulatory posture (LEGAL-TEAM-CONFIRM)

- **CBK e-money** is the governing regime (dual redemption ⇒ stored value ⇒
  e-money, unavoidably). The licensee needs an e-money issuer authorization or a
  licensed-partner arrangement. `TODO(legal)`: license path — PollPower-as-issuer
  vs partner-issuer.
- **EPRA** governs the energy-delivery side (the kWh redemption leg and the
  producer/meter relationships), not the float.
- **The two regulators see different legs:** CBK sees the cash float + cash
  redemption; EPRA sees energy delivery. The pool's design keeps them separable
  (a cash leg and an energy leg on the same backed unit) so each regulator
  reasons about its own domain. `TODO(legal)`: confirm this separation holds
  under both regimes.

### 2.3 Dual redemption (the thesis-critical property)

An EBT holder may redeem **either**:

- **for kWh** — spend at any meter, the direct energy path (EPRA leg); or
- **for KES** — cash out through the licensed fiat rails (CBK e-money leg),
  paid from the trust.

Both draw on the same backed unit; §4's solvency invariant covers both. The
cash-redemption door is §4.3; the automation path is the existing M-Pesa B2C
rail PollPower already runs for producer payouts (D-5 / question #5).

---

## 3. Money movement — release on the mint attestation (D-7)

### 3.1 One authorization, atomically tied

The pool releases fiat **on the same attestation that mints EBT**. There is no
second authorization step. The settlement already produces a signed,
meter-attested, replay-guarded event (the EBT `settle()` path); the trust
releases the split against **that exact event**:

```
settlement attestation (signed, meter-attested, session-replay-guarded)
   │
   ├──► EBT mint (on-chain, per the split resolved from the tariff schedule)
   └──► fiat release from trust (producer payout, LD slice, ops, DAO, statutory)
        — gated on the SAME attestation, consumed once
```

Because fiat-out and mint are tied to one consumed proof, there is no window in
which they disagree: you cannot mint without releasing the backed split, and you
cannot release twice (the session replay guard — the same `_settledSessions`
mechanism EBT already uses — consumes the attestation).

### 3.2 The operator-status gate (the one new piece of plumbing)

The release check adds **one predicate** to the existing settlement validation:
**is the originating operator currently federated + authorized?** The pool reads
operator status (set by the federation governance act — charter, de-federation,
exit) and releases only for a currently-authorized operator. This is the single
mechanism that makes §5's lifecycle enforceable: revoking authorization is just
flipping this predicate.

`TODO`: whether the operator-status source is an on-chain registry read
(preferred — auditable) or an attestation the settlement carries. Leans on-chain
registry, same shape as ProducerRegistry.

---

## 4. Solvency — published, not merely audited (D-8)

### 4.1 The invariant

> At every instant: **Σ (outstanding EBT × recorded backing-fiat) == attested
> trust balance.**

Each EBT records its backing fiat in its datum (WI-06 §2 per-coin backing
metadata). The sum of outstanding backing is the pool's *obligation*; the trust
balance is its *reserve*. Solvency is obligation == reserve.

### 4.2 Published verification

- **Obligation side** is on-chain and public: anyone can sum outstanding EBT ×
  backing from ledger state.
- **Reserve side** is the trust balance, published as a **signed attestation**
  (the licensee/trustee attests the balance on a cadence, `TODO(calibration)`
  cadence). A future enhancement can bring the reserve on-chain via a
  bank-API/oracle attestation, but v1 is a signed periodic attestation.
- **The check is public:** obligation (on-chain, continuous) vs reserve
  (attested, periodic). A divergence is visible to anyone — the token's
  cross-operator trustworthiness rests on this being *checkable*, not on
  trusting any operator. This is the D-8 "published not just audited" choice.

### 4.3 Redemption draws on the pool, not the originating operator (B-1 tie-in)

A merchant/holder redeeming EBT→KES is paid **from the trust**, not from
whichever operator first took the consumer's payment. This is the concrete
money-movement A-1 (WI-02 clearinghouse) nets across operators. It also fixes
the B-1 fungibility stance: **redemption value is pooled at the national trust**
(per-coin backing metadata is an *audit* artifact; redemption pays the pooled
rate), so EBT is economically fungible at the cash door regardless of which
operator minted it. WI-02 handles the inter-operator true-up that this pooling
implies.

---

## 5. Operator lifecycle (D-9)

The through-line (§1): **only future authorization ever changes.** Minted EBT
stays backed; members stay in the network.

### 5.1 De-federation (the federation ejects an operator)

A governance act (federation multisig) that flips the operator's status gate
(§3.2) to unauthorized. Effects:

- **Future mint/instruct authority: revoked immediately.** No new settlements
  accepted from that operator (the §3.2 predicate fails).
- **In-flight settlements: drain window (D-9).** Settlements already submitted
  and already backed by fiat in the trust **complete normally** within a bounded
  drain window (`TODO(calibration)` length); no *new* ones are accepted. No
  stranded money, bounded exposure.
- **Existing minted EBT: unaffected.** It is backed, in the trust, and stays
  fully spendable and redeemable (§1). A de-federated operator's EBT "flies
  around just fine" (Garrett's phrase, question #4) — correct, because the token
  never depended on the operator's federation status.
- **The operator's members: unaffected.** They are individuals in the national
  LD pool, not the operator's property. They keep membership, keep accruing,
  keep claiming. **The operator cannot take its people with it** — this protects
  members *from* a rogue operator, and is worth stating as a member-protection
  feature, not just a mechanic.
- **The operator's past DAO/margin slices: not clawed back.** Already theirs,
  already split per past settlements.
- **Re-federation: permitted.** Through a fresh charter petition (WI-20), with a
  fresh standing review. De-federation is a state, not a death sentence.

### 5.2 Voluntary exit / wind-down (the operator chooses to leave — C-9)

Distinct from ejection: the operator initiates. Uses a **fixed notice period**
(D-9, `TODO(calibration)` length):

- **Notice announced** (publicly + to the operator's members). The operator
  keeps settling normally *during* notice — orderly, not abrupt.
- **At notice end, mint/instruct authority lapses** (same status-gate flip as
  §5.1, but scheduled rather than punitive).
- **Members: stay in the national LD pool.** Not stranded, not de-registered.
- **EBT backing: stays in the trust.** Exit does not — cannot — withdraw
  backing, precisely because the operator never held the float (this is the
  concrete payoff of D-1). Existing EBT stays backed and redeemable.
- **Meters: deregistered from ProducerRegistry** at notice end, going forward
  only; previously minted EBT unaffected.
- **Wind-down runbook (C-9):** the operational checklist (notify members, close
  the settlement stream, deregister meters, confirm no in-flight residual) is a
  runbook artifact downstream of this structure — flagged, to be written against
  §2's legal wrapper once the licensee arrangement is fixed.

### 5.3 Operator *failure* (insolvency) — the isolation property

Neither ejection nor voluntary — the operator simply collapses. Handled by the
same invariant: because the operator never held the float, **its insolvency
cannot make its EBT worthless** (A-2's original motivation). In-flight
settlements drain (§5.1); minted EBT stays backed; members stay in the pool.
Operator credit quality is decoupled from EBT backing quality — which is the
whole point of putting the float in the trust rather than on operator balance
sheets.

---

## 6. Dependencies this unblocks / shapes

- **WI-02 (A-1 clearinghouse):** §4.3's pooled redemption *is* the inter-operator
  receivable A-1 nets. WI-02 can now begin: "where the fiat sits" is answered
  (the national trust), and "who pays redemption" is answered (the trust, pooled).
- **WI-14 (settlement):** consumes §3's release-on-mint-attestation model and
  §3.2's operator-status gate; implements §4.3's pooled redemption door.
- **NATIONAL-ONBOARDING Phase 2 (wallet tiers):** the custody wrapper (§2) is the
  A-2 dependency that the wallet-tier / USSD custody design was waiting on.
- **C-9 wind-down runbook:** §5.2 gives it its skeleton.

---

## 7. Open items

### 7.1 Legal-team confirmations (`TODO(legal)`)

- CBK e-money license path: PollPower-as-issuer vs licensed-partner-issuer (§2.2).
- Confirm the CBK-cash-leg / EPRA-energy-leg separation holds under both regimes
  (§2.2).
- Trust structure specifics: trustee identity, beneficiary definition, the
  ring-fence mechanics that survive licensee insolvency (§2.1).
- Cross-border implications deferred to the §7.3-architecture / WI-02 layer.

### 7.2 Calibration (`TODO(calibration)`, Garrett's call)

| # | Parameter | Section |
|---|-----------|---------|
| CAL-DRAIN | De-federation drain-window length | §5.1 |
| CAL-NOTICE | Voluntary-exit fixed notice period | §5.2 |
| CAL-SOLV | Trust-balance attestation cadence | §4.2 |

### 7.3 Design follow-ons

- Operator-status source: on-chain registry (preferred) vs settlement-carried
  attestation (§3.2).
- Reserve-side on-chain oracle (bank-API attestation) as a post-v1 solvency
  enhancement (§4.2).

---

## 8. One sentence

> Backing fiat lives in a CBK-regulated e-money **trust** (M-Pesa model) that
> holds the float for EBT holders and no operator ever owns; fiat releases on
> the **same replay-guarded attestation that mints EBT**, gated by a single
> operator-status predicate; solvency is a **publicly checkable** invariant
> (outstanding-EBT-backing == attested trust balance); EBT redeems for **both
> KES and kWh**; and because the trust — not the operator — holds the money and
> members belong to the network, an operator's ejection (drain window), exit
> (fixed notice), or failure changes only *future authorization*, never the
> backing of already-minted EBT or the standing of its members.

---

*DESIGN DRAFT, 2026-07-13. Spec/policy only — zero contract code. Contains
regulatory positions requiring legal-team confirmation. WI-01 of the Federation
Implementation Plan; resolves finding A-2. Post-pilot.*
