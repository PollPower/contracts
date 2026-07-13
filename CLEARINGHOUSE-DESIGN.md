# Intra-National Clearinghouse — Inter-Operator Netting (A-1 resolution)

**Status:** DESIGN DRAFT — spec/policy only, no contract code. Not deployed,
not audited.
**Layer:** Post-pilot. Required before a *second* operator onboards; the
single-operator pilot has no inter-operator flow.
**Work item:** WI-02 of [`FEDERATION-IMPLEMENTATION-PLAN.md`](./FEDERATION-IMPLEMENTATION-PLAN.md).
**Resolves:** finding **A-1** ("interoperability implies an intra-national
clearinghouse") from
[`FEDERATED-TARIFF-OPEN-QUESTIONS.md`](./FEDERATED-TARIFF-OPEN-QUESTIONS.md).
**Depends on:** [`NATIONAL-ESCROW-DESIGN.md`](./NATIONAL-ESCROW-DESIGN.md)
(WI-01) — A-1's own note: "the clearinghouse design depends on where the fiat
sits." It sits in the national e-money trust (D-6), and that fact collapses
most of A-1.

## 0. What this document is

A-1 observed that token portability creates money movement the architecture
never described: a consumer earns EBT on Operator A's grid and spends it at a
merchant on Operator B's grid; the merchant redeems to KES paid out of B, while
A holds the original consumer payment — an **inter-operator receivable** with
credit risk, multiplied across every operator pair.

**WI-01 largely dissolves this.** Because all backing fiat lives in **one
national e-money trust** (D-6), not on operator balance sheets, there is no
"A holds the payment while B pays out" — *the trust holds every payment and the
trust makes every payout.* The inter-operator **credit risk** A-1 feared does
not arise, because operators never hold the float to be owed against.

What remains is not credit risk but **attribution accounting**: the trust needs
to know, for solvency and for fair funding of the shared pools (LD/ops), *which
operator's throughput backs which outstanding EBT* — so that when redemption
draws on the pooled trust, the books still attribute correctly. That residual
is what this document specifies.

### 0.1 One-sentence contract

> Because the national e-money trust holds all fiat and makes all payouts,
> inter-operator settlement is not a credit-risk netting problem but an
> **attribution-accounting** one: EBT is redeemed at a pooled rate from the
> trust, and a periodic **netting-and-true-up** reconciles each operator's
> fiat-in against the redemptions and shared-pool obligations attributable to
> its throughput — with the trust, not any operator, always the counterparty.

---

## 1. What WI-01 already settled (so A-1 shrinks)

| A-1 worry | Status under WI-01 |
|-----------|--------------------|
| "A holds the consumer payment" | ✗ Gone — the **trust** holds it (D-6). No operator holds float. |
| "B pays the merchant from B's fiat" | ✗ Gone — the **trust** pays redemption (WI-01 §4.3), pooled. |
| Inter-operator **credit risk** | ✗ Gone — no operator is ever owed by another; the trust is always the counterparty. |
| "who carries the inter-operator book" | The **trust/licensee** carries it — a single book, not a web of bilateral receivables. |
| Netting/true-up still needed? | ✓ Yes — but as **attribution accounting**, not credit settlement (§2–§3). |

So A-1 downgrades from "must-solve credit-risk clearinghouse with inter-operator
counterparty exposure" to "the trust's internal attribution ledger + a periodic
reconciliation." That is a meaningfully smaller, safer problem, and it is the
direct payoff of the D-1 decision to pool the float.

---

## 2. The attribution ledger (what the trust must track)

The trust already knows, per WI-01 §3, that fiat entered on a settlement
attestation carrying an **operator id** (the §3.2 operator-status gate reads
it). The clearinghouse extends this into a running attribution book:

```
per operator, continuously:
  fiatIn[op]        = Σ consumer payments originated by op into the trust
  ebtMinted[op]     = Σ EBT minted from op's settlements (= fiatIn[op] at 1:1 backing)
  sharedOwed[op]    = Σ op's LD + ops + statutory slices routed to the shared pools
  redeemedAgainst[op] (see §3 — attribution of pooled redemptions)
```

`fiatIn` and `ebtMinted` are already implied by WI-01's solvency invariant
(D-8); the clearinghouse adds the **operator dimension** so the single national
solvency figure decomposes per operator. This is a read/derivation over
existing on-chain settlement data plus the trust's attested balance — not a new
custody mechanism.

---

## 3. Redemption — D-10: energy-denominated fungibility (fungible on kWh, floating on fiat)

**Decision D-10 (Garrett, 2026-07-13):** EBT is fungible **on the energy axis**
(the axis that matters and where all real activity happens) and its fiat face
is allowed to **float per coin**. This supersedes the earlier P1-vs-P2 framing,
which was a fiat-brained question — it assumed the fiat axis was the one whose
fungibility had to be defended. In an energy-denominated economy it is not.

### 3.1 The reframing that dissolves B-1

The project's end-state (Garrett): businesses price goods and services **in EBT
(= kWh)**, not in fiat. Energy is the denominator; fiat is a shrinking legacy
exit ramp. Under that model there are two redemption axes, and they are not
symmetric:

- **Energy redemption (the primary path).** Spend EBT for kWh, or spend EBT for
  goods/services **priced in EBT**. On this axis every EBT is **identical**
  (I-1: 1 EBT = 1 kWh, always). A merchant pricing bread at 2 kWh accepts any
  2 EBT without inspection, because they are thinking in energy, where the
  coins do not differ. **Gresham's Law never fires here** — there is no
  cash-out motive on the energy axis, so no "good coin / bad coin" selection
  can occur. This is where essentially all transaction volume lives.

- **Fiat redemption (the peripheral exit ramp).** Cash out EBT to KES. On this
  axis coins **do** differ: each coin redeems for the fiat recorded in its own
  backing metadata (the honest per-coin value — the former "P2" instinct, now
  simply correct). Fiat fungibility is **explicitly not preserved**, because
  fiat is not the denominating unit and its relevance shrinks as the EBT
  economy thickens.

### 3.2 Why the old B-1 crack closes instead of widening

The B-1 Gresham worry assumed actors transact on the **fiat** axis (a merchant
discounting a low-backed coin). But in an energy-denominated economy the
merchant transacts on the **energy** axis, where coins are identical, so the
discount never happens. The fiat spread only matters to someone cashing out to
the old currency — a peripheral, self-limiting act (the more the economy
denominates in energy, the less a fiat spread is worth chasing). The one
remaining leak — redemption arbitrage (buy low-fiat EBT, redeem high-fiat EBT)
— is **bounded by the sanity band** (architecture §7.2), which caps how far
per-coin fiat backing can diverge in the first place. Bounded slide, not wild.

### 3.3 Attribution consequence for the trust

Because fiat redemption is **per-coin from its own recorded backing**, the
attribution question the earlier P1/P2 framing agonized over largely evaporates:
a fiat redemption draws down exactly the backing that coin recorded, which
traces to the operator that minted it. `redeemedAgainst[op]` (§2) is therefore
not a *policy* choice — it is simply *the sum of that operator's coins that were
fiat-redeemed*. Energy redemptions do not draw fiat at all (they consume EBT
against delivered kWh), so they never touch the fiat attribution book. This is
simpler than either former policy: no pooling math, no origin-tracing heuristic
— the coin's own metadata is authoritative for the (increasingly rare) fiat
exit.

### 3.4 What this preserves and what it lets go

- **Preserved (absolutely):** energy fungibility (I-1). This is the thesis and
  it never bends. Every EBT is 1 kWh everywhere, forever.
- **Let go (deliberately):** fiat fungibility. Coins differ in KES cash-out
  value; that is acceptable and correct because fiat is not the unit. The
  per-coin backing metadata (WI-06 §2) becomes the **fiat redemption value**,
  not merely an audit artifact.
- **Bounded:** the fiat divergence between coins, by the sanity band (§7.2).

---

## 4. The periodic netting-and-true-up

A-1's "net continuously in EBT terms, true-up the fiat residual periodically"
ports down cleanly, but the counterparty is the **trust**, never another
operator:

### 4.1 What nets (continuously, in EBT/attribution terms)

Between reconciliations, everything is a running attribution (§2). No fiat
moves *between operators* — ever. EBT circulates; the trust holds the fiat; the
attribution book records who backs what. This is the "net continuously in EBT
terms" leg — and here it is free, because pooling already did it.

### 4.2 What trues-up (periodically, in fiat)

On a `TODO(calibration)` cadence, the trust reconciles each operator's position:

```
for each operator op:
  contributed   = fiatIn[op]                 // what op's consumers paid in
  drawn         = redeemedAgainst[op]         // pooled redemptions attributed (§3 policy)
                + sharedOwed[op]              // op's LD/ops/statutory obligations
                + producerPayouts[op]         // op's producer-slice payouts
  residual[op]  = contributed - drawn
```

`residual[op]` is **not** an inter-operator debt — it is `op`'s standing balance
*within the trust*. A positive residual is fiat still held for `op`'s ecosystem
(un-redeemed EBT backing); a negative residual would indicate `op` drew more
than it contributed, which under D-10 per-coin fiat redemption cannot occur
beyond rounding (a coin redeems only for what it recorded) and is an **alarm**
(it would mean redemptions exceeded backing — a solvency breach, caught by D-8's
published invariant before it can grow).

### 4.3 Who carries the book

The **licensee/trustee** (WI-01 §2) — a single national clearing function,
regulated as part of the e-money license, not a new counterparty. A-1's
"protocol-operated vs a licensed role" question resolves to: **the licensed
e-money trustee is the clearing function.** No separate clearinghouse entity is
required; clearing is an accounting responsibility of the entity already
holding the float.

---

## 5. Why there is no inter-operator credit risk (the key result)

A-1's core fear was credit risk: A owes B, B might not get paid if A is
insolvent. Under WI-01 that chain does not exist:

- No operator ever holds another operator's money.
- No operator ever owes another operator.
- Every payout comes from the trust; every payment goes to the trust.
- An operator's insolvency (WI-01 §5.3) cannot default an inter-operator
  receivable **because there are none** — its EBT stays backed in the trust,
  its members stay in the pool, and its `residual` is simply frozen and settled
  in the wind-down (WI-01 §5.2 / C-9).

The clearinghouse is therefore a **solvency-attribution and reconciliation**
function, not a credit-clearing one. This is the single most important
simplification A-1 gains from D-1, and it should be stated plainly to any
regulator: **pooling the float removes inter-operator counterparty risk by
construction.**

---

## 6. Cross-border note (defers to §7.3-architecture)

A-1 observed its problem is "structurally identical to the cross-border problem
§7.3 solves, except inside the nation." The relationship inverts cleanly:
*inside* a nation the pooled trust removes credit risk entirely (§5); *across*
nations, different e-money trusts in different currencies mean the credit-risk
and FX questions **do** return, and are handled by the architecture's §7.3
energy-for-energy settlement + licensed-desk model, not here. This document is
strictly intra-national. Cross-border clearing is a separate, later work item
(architecture §7.3, R-1 net-imbalance book).

---

## 7. Acceptance criteria / what a WI-13/WI-14 implementer inherits

The clearinghouse is mostly **accounting + reconciliation over WI-01/WI-14
data**, so its "implementation" is largely reporting + a reconciliation
process, not a new custody circuit. An implementation MUST:

1. Decompose the D-8 national solvency figure **per operator** (§2 attribution
   ledger) from on-chain settlement data + attested trust balance.
2. Apply D-10 redemption semantics: energy redemptions consume EBT against
   delivered kWh and draw no fiat; fiat redemptions pay **per-coin from the
   coin's own recorded backing** (no pooling math, no origin-tracing heuristic).
3. Produce the periodic `residual[op]` reconciliation (§4.2), with a negative
   residual raising a **solvency alarm** (never silently netted).
4. Treat the trust as the sole counterparty — **no artifact may represent an
   inter-operator debt** (§5); if the design ever produces one, it is a bug.
5. Freeze-and-settle an exiting/failed operator's residual per WI-01 §5, not
   strand or transfer it.

---

## 8. Open items

### 8.1 Calibration (`TODO(calibration)`, Garrett's call)

| # | Parameter | Section |
|---|-----------|---------|
| ~~CAL-REDEEM~~ | RESOLVED by D-10 — energy-denominated fungibility: fungible on the kWh axis, per-coin fiat redemption on the peripheral fiat axis; no pooling-vs-origin fork remains | resolved |
| CAL-RECON | True-up reconciliation cadence | §4.2 |

### 8.2 Legal (`TODO(legal)`)

- Confirm the e-money trustee may lawfully act as the national clearing
  function under the CBK license (§4.3) — expected yes (it is inherent to
  holding pooled float), but confirm.

---

## 9. One sentence

> Pooling all backing fiat in one national e-money trust (WI-01) removes
> inter-operator credit risk by construction, so the intra-national
> clearinghouse A-1 demanded reduces to an **attribution ledger** that
> decomposes national solvency per operator plus a **periodic fiat true-up** of
> each operator's standing balance *within the trust* — pooled redemption
> (per-coin, D-10) keeps energy fungibility absolute while letting fiat float, the licensed
> trustee is the single clearing counterparty, and no artifact anywhere
> represents one operator owing another.

---

*DESIGN DRAFT, 2026-07-13. Spec/policy only — zero contract code. Resolves
finding A-1; depends on WI-01's escrow design. Intra-national only; cross-border
clearing defers to architecture §7.3. Post-pilot.*
