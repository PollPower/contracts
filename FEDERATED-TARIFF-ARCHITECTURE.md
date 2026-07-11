# Federated Tariff Architecture

**Status:** DESIGN DRAFT — spec only, no contract code. Not deployed, not audited.
**Layer:** Post-pilot. The pilot runs a single operator, a single flat rate, and flat
Multisig v7. Nothing in this document is on the pilot's critical path.
**Related:** [`multisig/SORTITION-TABLE-DESIGN.md`](./multisig/SORTITION-TABLE-DESIGN.md)
and the "Governance: the Fractal Federation" section of the root
[`README.md`](./README.md) (same nested-enterprise structure, expressed here for
pricing rather than governance); [`living-dividend/README.md`](./living-dividend/README.md)
(the LD floor this document treats as a constitutional minimum);
`ADR-001` (rate immutability — generalized here to the whole tariff tree);
`ADR-013` (tariff classes and the capacity slice).

## 0. What this document is

An architecture for scaling PollPower from **one operator** to **many companies
within a nation** to **many nations**, without:

- flattening the local economic reality of each operator, or
- breaking the fungibility of the EBT token.

It answers three connected questions raised in design discussion (2026-07-11):

1. How do we prioritise onboarding the entities that mint fastest?
2. How do we let many companies — and many *lines of business within* a company —
   codify their own tariff structures and their own LD/ops/DAO/margin splits,
   while staying interoperable on one shared token?
3. How does this work across national borders and currencies?

It is deliberately written as one continuous argument, because it is one:
*how a values-anchored energy protocol scales without either homogenising local
conditions or fragmenting the token.*

The design principle throughout is **Ostrom's**: durable commons match their
rules to local conditions, set by the people affected, nested under broader
agreements. A good model reflects the complexity it represents rather than
simplifying it away. The tariff tree below is as complex as the economic
geography it describes, because a simpler model would be lying about the
territory.

---

## 1. The invariants — the thin waist that never varies

No matter how deep the tariff tree grows or how many nations join, four things
are universal and non-negotiable. Everything else is local, plural, and
company-defined. This separation — **rigid spine, flexible body** — is the whole
architecture.

**I-1. 1 EBT = 1 kWh.** A unit commitment, everywhere, forever. This is what
makes the token fungible across every operator and every border. No company, no
nation, no line of business can alter it. If any actor could redefine what an EBT
*means*, a consumer on Operator A's grid could no longer spend EBT on Operator
B's — and the network effect (portable energy value) dies.

**I-2. Mint-after-payment.** Fiat must sit in the settlement pool *before* any EBT
is minted. The jar has the money before the token drops. Universal. This is the
moral and regulatory spine: EBT is never an inflation source, a subsidy, or a
debt instrument — it is a receipt for energy already paid for.

**I-3. Constitutional floors — LD floor and ops floor.** A minimum fraction of
every settlement is routed to the Living Dividend pool (`LD_FLOOR_BPS`) and to
network operations (`OPS_FLOOR_BPS`). These are set at the national level, *by the
Fractal Federation* (not by any operator, and not unilaterally by
PollPower-the-key), and they can only be **tightened** as you descend the tree,
never loosened (see §4). The LD floor is the single most important parameter in
the system: if an operator could zero it, the "your power pays you back" promise
becomes a lie and the network becomes just another billing rail.

**I-4. Epoch-bound, versioned, never retroactive.** Any tariff change or split
change takes effect at the next epoch boundary, never mid-flight and never
backdated. Every minted EBT records which tariff/split version backed it. This is
`ADR-001` rate-immutability, generalised from a single rate to the entire tariff
tree. It is what makes the whole structure auditable and closes the front-running
surface (an operator cannot mint cheap and then raise the LD share retroactively).

Between these four invariants, everything is free.

---

## 2. The core primitive — per-coin backing metadata

The mechanism that makes plural tariffs possible on one token is **not a market
model**. It is a plain accounting fact:

> Each minted EBT carries, in its datum, a record of how much fiat backed it and
> which tariff path produced it.

Two companies can charge different prices for the same physical kWh. Both mint
**1 EBT per kWh** (I-1 holds). The difference in their prices shows up as
**different backing-fiat recorded per EBT**, not as a different token. The
expensive-tariff company's EBT carries more backing-fiat in its metadata; the
cheaper company's carries less. Same fungible unit, different fiat memory.

This is a bookkeeping property of the coin, independent of any pricing theory. It
is what lets the tariff tree in §3 have unlimited local complexity while the token
stays singular and portable.

---

## 3. The tariff tree — nested authority, faithful to local reality

Tariff authority is genuinely hierarchical. Forcing it into one flat national
table would impose the capital city's conditions on a rural mini-grid — an Ostrom
anti-pattern. The honest structure is a tree, and it is the *same tree* as the
Fractal Federation governance tree. The federation that governs a cluster also
codifies that cluster's tariffs, under the same constitutional floor. Governance
and pricing are two projections of one nested structure.

```
NATION            reference band + constitutional floors (federation-set)
  └─ COMPANY       registers its own tariff schedule
       └─ LINE OF BUSINESS    B2B / B2C / agricultural / institutional …
            └─ TARIFF CLASS   time-of-use / lifeline / commercial-peak …
                 └─ the actual rate a given customer pays
```

Each layer sets policy for the layers beneath it and is **bounded by the layer
above it**.

### 3.1 The registered object: `TariffSchedule`

A company does not register one tariff. It registers a *schedule* — a subtree of
lines and classes — as first-class on-chain policy.

```
TariffSchedule {
  operatorId
  nationRef                    // which national band + floors it lives under
  lines: [
    LineOfBusiness {
      lineId                   // "B2C-residential", "B2B-commercial", "agri-irrigation"
      splitPolicyId            // THIS LINE's split (see §3.2)
      tariffClasses: [
        TariffClass {
          classId              // "lifeline", "standard", "peak", "commercial-3phase"
          rateFiatPerKwh       // the actual price the customer pays
          eligibilityRule      // who qualifies — off-chain attested, on-chain committed
          effectiveEpoch       // when it activates; never retroactive (I-4)
        }
      ]
    }
  ]
}
```

### 3.2 Split attaches at the *line* level, not just the company

This is the key flexibility answer. A single company can run **different splits on
different lines of business**:

```
SplitPolicy {
  lineId
  producerShareBps       // to the generating producer
  ldShareBps             // to the Living Dividend pool   (>= cascaded LD floor)
  opsShareBps            // to network operations         (>= cascaded ops floor)
  daoShareBps            // to the operator's own local DAO / treasury
  operatorMarginBps      // the operator's business cut
  // sum == 10000
}
```

A company's **B2B line** might route less to LD (corporate customers, thinner
margins, price-sensitive procurement); its **B2C line** might route more (community-
facing, brand-driven generosity, retention story). Different splits, same company,
same interoperable EBT out the other end.

### 3.3 A price is a governed *path* through the tree

The rate a customer actually pays is resolved as a path:

```
nation → company → line → class → rateFiatPerKwh
```

At settlement, the operator's gateway references the full path. The consumer pays
fiat at `class.rateFiatPerKwh` (I-2), that fiat mints 1 EBT/kWh (I-1), and the
fiat is divided by `line.splitPolicy` (§3.2). Every minted EBT records its full
path in its backing metadata (§2), so the entire division is auditable back to
which class, which line, which company, which nation produced it.

---

## 4. The cascading-floor invariant — monotone down the tree

The rule that lets unlimited local complexity coexist with hard network minimums:

> **A lower layer may be *more* generous than the layer above requires. It may
> never be less. Floors tighten monotonically as you descend; they never loosen.**

Concretely:

- The **nation** sets `LD_FLOOR_BPS` and `OPS_FLOOR_BPS` (federation-governed).
- A **company** may set its own higher internal floors (a values-driven co-op may
  mandate LD ≥ 10% across all its lines) but may never drop below the national
  floor.
- A **line** must satisfy every floor cascaded down to it from nation and company.
- A **class** inherits its line's floors.

At **registration time**, a validator checks that *every path* through the schedule
satisfies *every cascaded floor*. A schedule with any floor-violating leaf is
rejected whole. This is the same discipline as the sortition service-reward design:
you may tilt generosity upward locally, but you may never breach the shared
minimum.

This is what makes the constitutional floor (I-3) real rather than aspirational:
it is enforced structurally at the point of registration, not trusted at the point
of settlement.

---

## 5. Freedom at the leaves, permission at the branches

Onboarding speed and network integrity pull in opposite directions. The resolution:

- **Leaves are permissionless.** A registered company may add, retune, or retire
  its own **tariff classes** and adjust its **line splits** freely (within the
  cascaded floors, effective next epoch). It does not need to ask anyone to reprice
  its lifeline class or shift its B2B margin. This keeps operators fast and
  self-sovereign.

- **Branches are permissioned.** *Claiming a new line of business*, *registering as
  a company under a nation*, or *establishing a new national presence* is
  **federation-gated** — multisig/governance-approved, the same way Living Dividend
  member registration and ProducerRegistry meter registration are multisig-gated.
  You cannot unilaterally declare yourself a new national operator, or spin up an
  unvetted new line, without the relevant federation seat approving the branch.

Freedom where iteration should be cheap; permission where network structure is at
stake.

---

## 6. Mint-velocity onboarding — who to prioritise

Priority target = **entities that can drive the most fiat-paid consumption through
the rail per unit of onboarding effort**, because mint velocity funds everything
downstream (the LD pool, network ops, the local DAOs). An entity that mints fast
makes the network real fast.

Mint rate ≈ (metered kWh consumed) × (consumers paying fiat) × (settlement
frequency). The entities that mint fastest already have metered load under
management, an existing fiat-collection relationship with those consumers, and
density (many consumers per onboarding action).

Ranked:

1. **Mini-grid operators — highest velocity by far.** They already own generation
   *and* a fleet of metered, paying consumers consuming daily. Onboard one operator
   and you inherit hundreds of active meters at once. You are not creating demand;
   you are wrapping demand that already exists. Every kWh their village already
   consumes becomes a mint event on day one.

2. **PAYGo SHS fleets (large latent capacity, one structural catch).** Millions of
   metered units and existing fiat-collection rails — enormous latent mint capacity.
   Catch: their metering is typically appliance-level daily-fee, not kWh-metered
   consumption, and it decays after unit payoff (customer owns the kit, stops
   paying). High in *count*, needs a metering bridge to map onto kWh-per-EBT, and
   the relationship must be restructured so consumption (not payoff) drives mint.

3. **C&I / captive generators (high kWh, low consumer density).** A factory with
   rooftop solar mints a lot of kWh through one meter and one payer. Strong EBT
   *volume*, weak consumer *density* — a poorer fit for the LD/retail flywheel, a
   better fit for future producer-side wholesale settlement.

**The onboarding weapon is the Living Dividend, pointed at the operator's own
customers.** When an operator routes settlement through the rail, every kWh their
villagers already consume mints EBT, and the LD-floor slice flows back to *those
same villagers*. The operator markets this as "your electricity now pays you a
dividend" — a retention/ARPU mechanism they cannot build themselves, funded by
their own throughput, and guaranteed by the constitutional floor rather than the
operator's goodwill.

The multi-tenant split registry (§3) is what makes this an easy "yes": the operator
keeps their own tariff structure and their own margin. They are not asked to give
up their economics — only to route through a rail that *adds* the dividend story on
top, while the LD floor (small enough to be a rounding error against margin,
universal enough to make the network mean something) does the rest.

---

## 7. Across borders and currencies

Cross-border hides three genuinely different problems. The architecture keeps them
separate on purpose.

### 7.1 The token is national in *color*, universal in *meaning*

Each country runs its own EBT **color**: EBT-KE, EBT-TZ, EBT-UG. Each is
minted-after-payment in its own currency and maintains its own retail peg to its
own national reference band (§7.2). Within a country everything above works
unchanged.

Colors are national — not fused into one global token — because **the peg is
national**. 1 EBT-KE is backed by Kenyan retail value in KES; 1 EBT-TZ by Tanzanian
retail value in TZS. Fusing them would silently claim those national energy prices
are equal, which they are not, and which regulators on both sides would correctly
reject. Same *unit meaning* (1 kWh), different *fiat backing*. Peg honesty is
preserved by keeping the color national.

### 7.2 The national reference band — a reference, not a price control

Clarifying the layer-1 point: the national peg is an **anchor**, not a mandate.

- The **retail tariff** — what a company charges its customers per kWh — is
  per-company and per-class, and lives in the Tariff Schedule (§3). Companies price
  freely.
- The **national reference band** is the anchor the network uses to keep 1 EBT
  honest as roughly one kWh of retail value *in that currency*. It is the
  denominator for the solvency invariant and the reference for cross-border energy
  math. It is **not** a price everyone must charge.

Guardrail: a **sanity band** around the reference. A company cannot charge, say,
50× the reference and still call it 1 EBT/kWh — that is a mint-inflation attack
dressed as a premium tariff. Within the band, tariff is free; on breach, the
schedule is flagged at registration. Soft bound, same discipline as the split
floor.

### 7.3 Cross-border settles in *energy*, not FX — FX is pushed to the edge

The usual assumption is that crossing currencies requires an FX rate. It does not,
because EBT-KE and EBT-TZ **already share a physical referent: 1 kWh**. They are not
really different currencies; they are the same energy unit with different fiat
backing attached. So a cross-border *energy* trade needs an **energy-for-energy
settlement**, not a currency conversion:

```
TZ producer delivers X kWh   →  X EBT-TZ extinguished on the TZ side
KE buyer consumes X kWh       →  X EBT-KE minted on the KE side (consumer paid KES, I-2 intact)
```

The two sides balance in **kWh**, not in currency. No FX rate touches the
transaction. The KE consumer paid KES (mint rule intact), the TZ producer earned
against TZS on their side (their peg intact), and the cross-border leg is a **1:1
kWh conservation swap**. This mirrors how real power pools (EAPP, ENTSO-E) settle:
net *energy flows* continuously, true-up the *residual financial imbalance* rarely.

FX reappears at exactly two points, and only two:

1. **The net-energy imbalance.** If one zone chronically exports more kWh than it
   imports, the residual must eventually be trued up in money — and *that residual*
   is FX-exposed. But because most flows net out, the residual is a fraction of
   gross, i.e. a working-capital-sized problem, not a gross-volume problem.

2. **Fiat cash-out across borders** — a TZ member wanting KES in hand. That is a
   genuine FX event and genuine money-transmission.

**The clean architectural line — and the participant restriction:**

> **Energy-for-energy cross-border settlement is open** (no FX, 1:1 kWh, conserved,
> permissionless within the network).
> **Fiat-for-fiat cross-border cash-out and residual true-up is restricted** (FX,
> KYC'd, rate-limited, regulated as money-transmission, confined to a small set of
> licensed participants — producers, treasury, market-makers).

This single distinction:

- kills the "shadow remittance rail" risk (a random consumer cannot move money
  across a border — only conserve energy);
- removes FX from the large majority of cross-border activity (the energy trades);
- confines FX and money-transmission compliance to a small, licensed, auditable set;
- keeps the story clean: **the network moves energy; only licensed desks move
  money.**

Architecturally, the **border-swap / true-up contract is a deliberately separate
contract** from the national settlement contract, so a regulator can bless the
clean energy-mint layer without having to bless the FX layer, and vice versa.

### 7.4 The Living Dividend goes fractal across borders

Ship **national LD pools, federated**: each country runs its own LD pool, funded by
its own mint, paying its own members in its own EBT color. A Kenyan consumes → the
Kenyan LD pays Kenyans in EBT-KE. Honest, regulatorily clean (redistribution stays
inside each currency and tax regime), and a 1:1 map onto the fractal governance:
each nation is a nested LD, the Fractal Federation is the parent that sets the
constitutional LD floor every national pool must honor.

A thin **continental LD** (a symbolic slice of national ops fees paid to all members
network-wide) is a *later, governance-gated* possibility — the "we are one network"
primitive — not a v1 commitment.

Note: because the floors are expressed in **basis points of the split**, not in
absolute currency, they travel across currency zones cleanly with no conversion.
The bps-based split design is, conveniently, already currency-agnostic.

---

## 8. Honest limits and open risks

Elegant ideas deserve adversarial review. These are the load-bearing risks.

**R-1. Someone holds the net-imbalance FX book.** Energy-for-energy conservation
removes FX from individual trades, but a chronically *directional* trade flow
accumulates a residual that must be funded in real currency, and its FX risk
accrues to whoever carries the imbalance (treasury or the licensed desk). Smaller
than gross, but non-zero and structurally directional if trade is unbalanced. Model
who holds it and how it is hedged or spread before promising anything.

**R-2. Energy conservation assumes physical deliverability.** "Energy-for-energy"
only holds where a producer's kWh can actually reach the consumer via
interconnection / wheeling / open-access. Where there is no interconnector, it
becomes a fiction and you are back to financial (FX) settlement. So this works
*inside a synchronised power pool* and degrades to FX *outside* it. The map of
"energy-swap-works vs. needs-FX" follows the transmission grid, not the network.
East Africa is building exactly this interconnection, which is why the model is
timely — but do not claim it where the wires do not exist.

**R-3. Tariff-tree depth is a fraud and legibility surface.** The deeper the tree,
the more places an operator can hide a mispriced class or a floor-dodging split.
Two mitigations are mandatory, not optional: (a) a registration-time validator that
checks the *whole path* against *every cascaded floor* (§4); (b) a human-legible
"explain this tariff" rendering — an operator and a regulator must each be able to
read a company's tariff tree and understand it on one screen. Ostrom's own test:
rules that participants cannot understand do not hold. Faithful-but-illegible fails
that test as surely as oversimplified does.

**R-4. Split/tariff mutability is a replay/front-running surface.** Mitigated by
I-4 (epoch-bound, versioned, never retroactive) — but it must actually be enforced
in-circuit, the same way rate-immutability is, not merely documented here.

**R-5. Regulatory multiplicity.** Every border roughly doubles the compliance
surface (national energy regulator + national central bank on each side, because
cross-border value movement is money-transmission-adjacent). The *token* is
jurisdiction-neutral; *the operator of the border-swap is not*. Keeping the mint
layer and the swap layer as separate contracts (§7.3) is what lets each
jurisdiction reason about them independently.

**R-6. Privacy posture is opposite at the two layers.** Midnight's shielding is a
feature for consumers at the national mint layer and a liability at the
cross-border swap layer (an unlicensed anonymous remittance rail is a legal
hazard). The two zones need deliberately opposite privacy postures: private at the
retail edge, auditable and KYC'd at the border.

---

## 9. Open calibration items (Garrett's call)

Left as flagged TODOs, matching the discipline of the sortition design docs:

- **`LD_FLOOR_BPS` and `OPS_FLOOR_BPS`** — the constitutional minimums. Federation-
  governed; the single most consequential parameters in the system. §1 / §4.
- **Sanity-band width** around the national reference (how far above/below the
  reference a company may price before a schedule is flagged). §7.2.
- **Tariff-tree depth limit** — max lines per company, max classes per line — to
  bound the fraud/legibility surface. §3 / R-3.
- **Branch-permission quorum** — which federation seat approves a new company /
  new line / new national presence. §5.
- **Cross-border residual true-up cadence and licensed-participant criteria.** §7.3.
- **Whether/when to enable the continental LD**, and its slice size. §7.4.
- **Hedging / inventory-limit policy** for whoever carries the net-imbalance book.
  R-1.

---

## 10. The whole architecture in one sentence

> Every company registers a nested Tariff Schedule — lines of business, each with
> its own split and its own tariff classes — as first-class on-chain policy under a
> national reference band; the price a customer pays is a governed path through
> nation → company → line → class; four invariants (1 EBT = 1 kWh, mint-after-
> payment, constitutional LD/ops floors, epoch-bound-never-retroactive) form a thin
> universal waist while everything between them is local and plural; floors cascade
> monotonically down the tree and may be tightened locally but never loosened;
> leaves are permissionless and branches are federation-permissioned; and value
> crosses borders as conserved energy (1:1 kWh, no FX) with FX and money-
> transmission confined to a small licensed edge — a model as complex as the
> economy it represents, exactly as Ostrom demands, on a token that stays singular
> and portable no matter how many companies or nations join.

---

*DESIGN DRAFT, 2026-07-11. Spec/policy only — zero contract code, per the standing
discipline for the federation-layer design work. Nothing here is on the pilot's
critical path; the pilot runs a single operator, a single flat rate, and flat
Multisig v7. This layer is post-pilot.*
