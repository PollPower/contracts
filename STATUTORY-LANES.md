# Statutory Lanes — Government Taxation in the Tariff Tree

**Status:** DESIGN DRAFT — spec only, no contract code. Not deployed, not audited.
**Layer:** Post-pilot. Nothing here is on the pilot's critical path.
**Companion to:** [`FEDERATED-TARIFF-ARCHITECTURE.md`](./FEDERATED-TARIFF-ARCHITECTURE.md)
(the tariff tree, split policies, and cascading floors this document extends) and
[`FEDERATED-TARIFF-OPEN-QUESTIONS.md`](./FEDERATED-TARIFF-OPEN-QUESTIONS.md)
(adversarial findings against the same architecture).

## 0. What this document is

A design for incorporating government taxation and statutory levies directly
into the federated tariff architecture — and the strategic argument for why
this converts government from regulatory threat into a stakeholder whose
revenue grows with network growth.

The pitch in one line:

> **Every kWh the network onboards becomes money in the treasury, collected at
> zero enforcement cost, visible in real time — while the government
> constitutionally gets a lane and a window, never a lever.**

## 1. The observation that makes this natural

A Kenyan electricity bill is *already a tariff tree with a statutory split*.
A Kenya Power invoice stacks: the base energy charge, fuel cost charge, forex
adjustment, inflation adjustment, EPRA levy, REP (Rural Electrification
Programme) levy, WARMA levy, and 16% VAT. Each named lane has a defined rate
and a defined recipient.

That *is* a split policy — a statutory one. Government already conceptualises
electricity pricing as a stack of lanes. This design does not ask regulators to
learn a new model; it shows them their own model, executed cryptographically,
with remittance and audit built into the settlement event itself.

## 2. The mechanism — a `statutoryLanes` lane class

The `SplitPolicy` (defined in
[`FEDERATED-TARIFF-ARCHITECTURE.md`](./FEDERATED-TARIFF-ARCHITECTURE.md) §3.2)
gains one new lane class, sibling to the constitutional floors:

```
SplitPolicy {
  // ...existing lanes: producerShareBps, ldShareBps, opsShareBps,
  //    daoShareBps, operatorMarginBps...
  statutoryLanes: [
    StatutoryLane {
      leviedBy        // "KRA", "EPRA", "REP", "WARMA", county-id, ...
      kind            // "VAT" | "levy" | "cess" | "duty"
      rateBps         // set by statute, not by the operator
      remitAddress    // the authority's address, or a licensed
                      // remittance escrow that converts to fiat
      basis           // what the rate applies to (pre-tax energy charge,
                      // full retail price, etc. — statute-defined)
      applicability   // per-tariff-class exemption/reduction rules (see §2.2)
      statuteRef      // human-readable citation of the enabling law
      effectiveEpoch  // never retroactive (invariant I-4)
    }
  ]
}
```

### 2.1 Properties

- **Cascades like a floor, but is sourced from statute.** Operators cannot
  dodge, tune, or waive a statutory lane. It is not theirs. The
  registration-time validator (§4 of the tariff architecture) enforces every
  statutory lane on every path through the schedule, using exactly the same
  machinery as the LD/ops floors. One new lane class; zero new architecture.

- **Remitted atomically at settlement.** The statutory share routes to
  `remitAddress` at the same atomic moment the rest of the split divides.
  There is no "collection" step to enforce, no arrears to chase, no filing to
  reconcile. Compliance is a protocol invariant: **the mint does not happen
  unless the statutory lane is satisfied** (invariant I-2 extended — the jar
  must contain the tax before the token drops).

- **Epoch-bound like everything else.** A tax-rate change activates at the
  next epoch boundary, never retroactively, and every minted EBT records which
  statutory-lane version applied (invariant I-4). Finance-act changes map to
  epoch transitions with a full audit trail.

- **Devolution-ready.** National lanes (KRA VAT, EPRA levy) and county lanes
  (cess) coexist in the same array. Kenya's devolved government structure maps
  directly onto the nested tree — a county is simply another `leviedBy` at the
  appropriate scope. Other nations' federal/state/municipal structures map the
  same way.

### 2.2 Per-class applicability — where the tree earns its keep

Tax law is not flat. Lifeline/social tariff classes are VAT-exempt or reduced
in many regimes; commercial classes are not; agricultural classes sometimes
have their own treatment. A flat pricing model cannot express this without
bolted-on exception tables.

The tariff tree expresses it natively: **tax applicability attaches at the
tariff-class level** — exactly where the tree already resolves prices. A
statutory lane's `applicability` rule declares, per class or class-pattern,
whether the lane applies in full, reduced, or not at all. The
registration-time validator checks that the operator's schedule honors the
statutory applicability rules the same way it checks floors.

This is a genuine capability argument for the architecture: the tree is not
complexity for its own sake; it is the exact shape of the fiscal reality it
must represent.

### 2.3 Fiat remittance path

Authorities want KES, not EBT. Two options, choose per authority:

1. **Direct fiat remittance:** the statutory lane's fiat share never mints —
   it is carved out of the consumer's payment at the fiat door and remitted
   through the existing licensed fiat rails (the same M-Pesa/B2C machinery
   that pays producers). Simplest; the authority never touches the chain.
2. **On-chain lane + licensed conversion:** the lane accrues on-chain to
   `remitAddress` (full public auditability), and a licensed remittance escrow
   converts to fiat on a schedule. More transparent; requires the authority
   (or its agent) to be a restricted fiat-door participant.

Option 1 is the pragmatic default; option 2 is the offer on the table when an
authority wants real-time on-chain visibility badly enough to operate an
address. Both preserve the invariant: the statutory share is separated at the
settlement event, not collected after the fact.

## 3. Why a government wants this (their priority order, not ours)

1. **Tax that collects itself, at zero collection cost.** The informal energy
   economy — diesel gensets, unlicensed mini-grids, cash sales — contributes
   approximately nothing today. Every operator onboarded moves revenue from
   the invisible economy onto a rail where evasion is structurally impossible.
   Revenue authorities spend enormous sums on enforcement; this offers
   compliance as a physical property of the settlement rail.

2. **Real-time revenue visibility.** Treasury sees energy-sector receipts
   accrue live instead of in quarterly filings it must audit. Per-coin path
   metadata makes every shilling of levy traceable to a settlement, a tariff
   class, a county. The chain *is* the audit.

3. **The REP-levy story writes itself.** The Rural Electrification Programme
   levy exists to fund exactly what this network does. "The REP levy collected
   on our network funds rural electrification, and our network *is* rural
   electrification — with cryptographic proof of every kWh delivered" is a
   press conference, not a compliance meeting.

4. **Formalization statistics as a by-product.** Every operator onboarded =
   businesses formalized, households on metered clean energy, shillings of new
   tax base. These are ministerial KPIs; the network generates them
   automatically.

5. **Climate/NDC reporting for free.** Paris Agreement accounting needs
   verified renewable generation and consumption data. Hardware-signed meter
   records provide it at a quality level national statistics offices cannot
   currently buy.

## 4. The boundaries — a lane and a window, never a lever

This section is the constitution of the relationship, and it must be drawn
**before** the first ministry meeting, because it is far harder to draw after.

- **B-1. Government sets rates inside its statutory lane only.** It does not
  get mint authority, a kill switch, or any write access to the token
  semantics (I-1), the mint rule (I-2), the LD floor, the ops floor, or any
  other participant's lanes. *You tax the flow; you do not control the pipe.*

- **B-2. The protocol is the rail, not the tax police.** It remits what
  statute says. It does not report individuals, chase arrears, or adjudicate
  disputes. Enforcement remains the state's job, using the state's processes.

- **B-3. Privacy is split by aggregation level.** Aggregate lane flows —
  VAT by county by day — are fully visible to the authority. Individual
  consumption patterns are shielded. The dashboard shows revenue, not
  "what time a household cooks." (Same opposite-privacy-postures principle as
  the cross-border layer: private at the retail edge, auditable at the
  institutional edge.) This protects the network politically as much as it
  protects consumers.

- **B-4. Statutory lanes are per-nation by construction.** A lane is scoped to
  its `nationRef`. No cross-border statutory reach; a Kenyan lane cannot touch
  a Tanzanian settlement, structurally.

## 5. The sweetener — LD infrastructure as subsidy delivery

The strongest offer in the government conversation is not the tax lane; it is
the Living Dividend machinery **as a subsidy-delivery rail**.

Lifeline and social energy subsidies leak badly through conventional
distribution chains. The LD stack already provides: KYC-verified unique
membership, self-pruning of ghosts and the deceased, O(1) proportional
distribution, claim-on-demand, and per-shilling public auditability.

A national or county government wanting to subsidise energy access could fund
a **targeted top-up pool** running on LD-pattern infrastructure: government
money in, KYC-verified beneficiaries out, zero ghost leakage, every shilling
traceable. The network becomes *the best subsidy-delivery mechanism the
government has ever had* — which is a materially better opening position than
"taxable entity requesting regulatory approval."

Design note: a government top-up pool would be a **separate contract instance**
from the network's own LD (separate funding source, separate governance,
possibly separate eligibility), sharing the mechanism but not the pool. The
constitutional LD remains funded by the mint and governed by the federation;
the subsidy pool is funded by the state and parameterised by the state, within
the same B-1 boundary (they parameterise their pool, not the protocol).

## 6. Risks and honest limits

- **R-1. Critical-infrastructure capture.** Once treasury revenue flows
  through the rail, the network is critical infrastructure. Protective (the
  state cannot let it fail) and dangerous (the state cannot let it *leave*,
  and a hostile administration inherits the relationship). Mitigations: the
  federation's multi-operator structure (no single company to capture), B-1
  drawn constitutionally before integration, and per-nation scoping (B-4) so
  capture in one jurisdiction does not propagate.

- **R-2. The rate-hike ratchet.** A statutory lane makes raising energy taxes
  operationally frictionless, which may make raising them politically easier.
  The protocol cannot and should not prevent fiscal policy; what it can do is
  make every rate change **maximally visible** (epoch-stamped, publicly
  logged, per-coin recorded) so the political cost of a hike stays where it
  belongs — with the legislature that enacted it.

- **R-3. Statute-to-lane fidelity.** Someone must translate finance acts into
  lane parameters, and mistakes are live money. Lane changes should require
  the same class of governance ceremony as floor changes (multisig +
  published statute citation + epoch delay), giving operators a review window
  between enactment-on-chain and effect.

- **R-4. Exemption gaming.** Per-class applicability (§2.2) creates an
  incentive to misclassify customers into exempt classes. The
  `eligibilityRule` attestation machinery already contemplated for tariff
  classes carries the load here; statutory exemptions simply raise its
  stakes. Flagged as a shared open item with the tariff architecture (see
  companion findings doc).

- **R-5. Don't lead with taxes.** Sequencing matters: the network should
  demonstrate pilot-scale value *first* and offer the statutory lane as part
  of the formalization conversation, not build tax remittance before there is
  revenue worth remitting. This document is the design-ahead, not a build
  order.

## 7. Open calibration items (Garrett's call)

- Which authorities/lanes to model first (KRA VAT + EPRA levy are the obvious
  Kenyan pair; REP levy is the narrative one).
- Option 1 vs option 2 remittance (§2.3) as the default posture.
- The governance ceremony for statute-to-lane changes (R-3): quorum, review
  window, publication requirements.
- Whether the subsidy-pool offer (§5) leads or follows the tax-lane offer in
  government conversations.
- Engagement sequencing per R-5 — what pilot evidence threshold unlocks the
  first ministry conversation.

## 8. One sentence

> Statutory taxes and levies become a protocol-enforced lane class in the
> existing split architecture — set by statute, cascaded like floors, remitted
> atomically at settlement, exemption-aware per tariff class, epoch-bound and
> publicly auditable — making the government a revenue stakeholder in network
> growth while constitutionally denying it any lever over the token, the mint,
> or the dividend.

---

*DESIGN DRAFT, 2026-07-11. Spec/policy only — zero contract code. Post-pilot
layer; the pilot runs a single operator, a single flat rate, and flat
Multisig v7.*
