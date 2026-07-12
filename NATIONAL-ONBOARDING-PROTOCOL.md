# National Onboarding Protocol — Bringing a Population onto the Living Dividend

**Status:** DESIGN DRAFT — spec only, no contract code. Not deployed, not audited.
**Layer:** Post-pilot, post-government-MOU. Furthest-out document in the
federation series. Nothing here is on the pilot's critical path.
**Companion to:** [`STATUTORY-LANES.md`](./STATUTORY-LANES.md) (the government
relationship this protocol presumes),
[`FEDERATED-TARIFF-OPEN-QUESTIONS.md`](./FEDERATED-TARIFF-OPEN-QUESTIONS.md)
(findings A-2, B-3, C-4 directly constrain this design),
[`FEDERATED-TARIFF-ARCHITECTURE.md`](./FEDERATED-TARIFF-ARCHITECTURE.md),
and [`living-dividend/README.md`](./living-dividend/README.md) /
[`living-dividend/DESIGN.md`](./living-dividend/DESIGN.md) (the mechanism
being scaled).

## 0. What this document is

The protocol for taking a national government partnership (as framed in
STATUTORY-LANES) one step further: enrolling a nation's population into the
Living Dividend roll so that, over time, everyone in the country accrues the
dividend.

The mechanics turn out to be the easy half. The hard half is **dividend
physics** (dilution) and **political safety** (identity as a lever). This
document covers both, and takes a position: **population coverage is the
outcome of network growth, not a day-one stunt.**

## 1. The constitutional rule first

Everything below is governed by one separation of powers, fixed before any
technical integration begins:

> **The state attests persons. The federation admits members. The mint pays
> dividends. Three powers, never in the same hands.**

Concretely:

- The state's identity system becomes **a KYC attestation provider** — one of
  several, never the only one, and never the gatekeeper of the roll.
- Registration authority (who actually enters the roll) stays
  **federation-governed**, exercised through the multisig/delegated-registrar
  machinery below.
- **No one can be unregistered by identity revocation.** Removal happens only
  through the LD's own liveness mechanism (self-pruning) or explicit
  federation process. The state can attest that you exist; it cannot attest
  that you have stopped existing.

This is the B-1 boundary from STATUTORY-LANES ("a lane and a window, never a
lever") extended to identity. Without it, a state that controls the ID system
controls who counts as a person — deny an ID, deny the dividend. That
dissident-starving lever must never be built. With multiple KYC doors and
federation-held admission, the state ID is *a* door, not *the* door.

## 2. The protocol, in phases

### Phase 0 — The MOU with boundaries pre-drawn

Before anything technical: the §1 separation of powers goes into the
government agreement alongside the STATUTORY-LANES boundaries. Drawn before
integration, because it is far harder to draw after.

### Phase 1 — National ID as an added KYC provider

The LD's KYC uniqueness key is already vendor-agnostic:
`hash(providerTag, jobIdHash)`. Government onboarding means adding
`providerTag: "XX-NationalID"` with the national ID registry as attestor.

Kenya specifically is unusually good soil: very high adult national-ID
coverage plus M-Pesa penetration means the identity and payment rails already
reach nearly the whole adult population.

**Prerequisite fix — cross-provider uniqueness (finding C-4).** The current
per-vendor key catches same-vendor duplicates only; the same human attested by
two providers (e.g., SmileID during pilot, national ID at scale) yields two
memberships. Adding a second high-coverage provider makes this hole
population-sized. Before national scale, uniqueness must bind to a **canonical
person identifier** (e.g., a salted commitment over the national ID number, or
a cross-provider dedup attestation from the KYC pipeline), not a per-vendor
job hash. This is the one LD-contract-adjacent change Phase 1 requires.

### Phase 2 — Wallet distribution at population scale

Self-custody is the standing commitment (ADR-006: no custodial intermediary),
but "generate a Midnight wallet locally" assumes a smartphone. A national
rollout needs tiers:

1. **Smartphone app** — the existing path, unchanged.
2. **USSD / SIM-toolkit tier** — custody-light wallets via telco partnership
   for feature phones. Key material on SIM or telco-secured element;
   relayed-submission signing. A custody compromise to be designed carefully
   against the ADR-006 line — flagged as an open design item, not a settled
   answer.
3. **Assisted registration at agent points** — the mobile-money agent network
   (hundreds of thousands of agents who already perform KYC-adjacent work
   daily) as the physical channel for wallet ceremonies, with the member
   leaving in possession of their own key material (paper backup + phone
   import), not the agent.

The existing relayed-submission rail already solves the "get DUST to every
member" problem; the agent tier solves the key-ceremony problem.

**Dependency:** the custody architecture interacts with finding **A-2**
(where the backing fiat lives). The escrow decision should precede or
accompany the wallet-tier design.

### Phase 3 — Cohort registration (the B-3 fix becomes mandatory)

One-at-a-time, multisig-gated `register()` does not survive contact with tens
of millions of adults; a 3-of-5 human ceremony per person is the bottleneck on
the exact metric that matters. National scale forces the contract evolution
already flagged in finding B-3:

**Cohort registration.** A delegated registrar (scoped per county, per agent
network, or per operator; federation-granted and federation-revocable)
submits a **Merkle root of a verified cohort**, countersigned by the
federation. Members are then proven into the roll on demand against the root
(membership proof at first claim/touch), rather than individually written at
registration time.

Properties:

- Registration throughput goes from ceremony-per-person to
  ceremony-per-cohort.
- On-chain cost collapses to roots + claims-on-demand: **members who never
  claim never touch the chain individually.** This is beautifully compatible
  with the LD's claim-on-demand semantics — the unclaimed population is free
  until they show up, which is exactly the right cost profile for a national
  roll.
- The federation countersignature preserves §1: registrars propose cohorts;
  the federation admits them.
- Registrar delegation is quota-bounded and auditable (same trust-shape as
  ProducerRegistry gating, one level down), limiting the blast radius of a
  corrupt registrar to its quota and making cohort roots publicly
  contestable during a challenge window.

This is the single biggest LD-contract change national onboarding requires.

### Phase 4 — Liveness at national scale

The existing 180-day touch model shines here, unchanged in principle:

- **Claiming is touching.** Anyone who collects their dividend stays live
  automatically. No separate attendance ritual.
- The dead, the emigrated, and the disengaged **self-prune** through the
  existing two-phase (propose → 30-day grace → execute) mechanism. No death
  oracle.
- Government death records may serve as a **hint feed** for `proposePrune` —
  raising prune proposals earlier than organic discovery would. But the
  grace-period mechanism remains the authority: a live member's touch cancels
  the prune regardless of what any registry claims. Records hint; the
  mechanism decides. (§1 again.)

### Phase 5 — Roll expansion paced to the mint

See §3. The roll grows county-by-county / operator-by-operator as the network
footprint grows — not nation-at-once.

## 3. Dividend physics — the dilution problem

The LD splits the mint across all living members. Registering an entire
nation against a pilot-scale mint makes each member's dividend dust — and
makes the flagship promise *feel* like a lie at the moment of maximum
political visibility. Three postures:

1. **Roll follows footprint (RECOMMENDED).** Register populations as the
   network reaches them — county by county, operator by operator, paced so
   the per-member dividend stays meaningful. Growth is legible: new counties
   see neighbors receiving real dividends before they join. The dividend is
   the marketing.

2. **Big-bang roll.** Everyone in on day one; dividend starts as a trickle
   and grows with the mint. Honest, maximally inclusive, politically fragile:
   "I got 0.4 shillings this month" is a headline risk that can kill the
   program before the mint catches up.

3. **Staged cohorts by statute** (e.g., lifeline-tariff households first).
   Targets need, but reintroduces exactly the means-testing politics the LD
   was designed to avoid, and hands the state a prioritisation lever §1
   exists to deny.

Posture 1 is recommended. Posture 3 should be resisted even when offered as
a "pragmatic compromise" — it quietly converts the dividend from a right of
membership into a benefit of classification.

**Related fault line — finding B-4 (dilution races), national edition.** When
the roll spans regions whose operators mint at very different rates, the
"who funds vs who collects" tension becomes regional politics. The federated
national-LD-pool structure (tariff architecture §7.4) already contemplates
nesting; whether a nation runs one pool or federated county pools under a
constitutional floor is a policy decision that should be made *before* the
first inter-regional grievance, not after.

## 4. Throughput and cost — the boring problem that kills projects

Tens of millions of on-chain registrations = tens of millions of Set-inserts
plus proof generation: months of sustained chain load and real DUST, even
batched. The §2 Phase-3 Merkle-cohort design is the answer — on-chain cost
becomes (cohort roots) + (claims actually made). Combined with
roll-follows-footprint pacing, chain load tracks *actual network adoption*
rather than paper enrollment.

Order-of-magnitude modeling (claims per epoch at various adoption levels,
proof-generation capacity at the relay tier, DUST budget per county rollout)
is an open item — flagged for whoever builds the Phase-3 spec.

## 5. What can go wrong (adversarial register)

- **W-1. Identity-lever capture.** Covered by §1; the mitigations (multiple
  providers forever, federation-held admission, no revocation-based removal)
  are load-bearing, not optional.
- **W-2. Registrar corruption.** A delegated registrar stuffs cohorts with
  fake or duplicate persons. Mitigated by: canonical-person uniqueness
  (Phase 1 fix), quota-bounded delegation, federation countersignature,
  public challenge window on cohort roots, and revocability. Residual risk
  is bounded by quota size.
- **W-3. Ghost-claim farming.** Fake members are only valuable if someone can
  claim for them; claims require member-held keys and KYC-unique
  registration. The claim-on-demand structure means unclaimed ghosts cost
  the attacker their registration effort and yield nothing until a key
  claims — and clawback-free pruning recycles their accruals to the living.
- **W-4. Dividend-as-patronage optics.** If the roll expands county-by-county,
  *which* county goes next is a political prize. The expansion criterion must
  be mechanical and published (e.g., operator-footprint thresholds), not
  discretionary — or the network becomes an instrument of regional favoritism
  and W-1 returns through the side door.
- **W-5. Emigration/diaspora edges.** Citizens abroad, refugees, stateless
  residents: is the roll citizenship-based or residence-based? The LD
  mechanism is agnostic (any KYC door works); the *policy* is a federation
  decision with real humanitarian stakes. Flagged, not answered here.

## 6. Open calibration items (Garrett's call)

- The canonical-person-identifier scheme for cross-provider uniqueness
  (Phase 1 / C-4 fix) — privacy-preserving commitment design needed.
- USSD/custody-light tier: how far it may bend ADR-006, and the recovery
  story for SIM-held keys.
- Cohort size, registrar quota, and challenge-window length (Phase 3).
- The mechanical roll-expansion criterion (W-4) — what footprint threshold
  admits a county.
- One national pool vs federated county pools under a floor (§3).
- Citizenship vs residence basis for the roll (W-5).
- Whether death-record hint feeds are worth the integration surface at all,
  given self-pruning already works without them.

## 7. One sentence

> A nation joins the Living Dividend by adding its identity system as one
> attestation door among several, distributing self-custody wallets through
> the channels people already trust, admitting members in federation-
> countersigned Merkle cohorts whose cost is deferred until first claim, and
> expanding the roll mechanically with the network's real footprint so the
> dividend stays meaningful — under a constitution where the state attests
> persons, the federation admits members, and the mint pays dividends, three
> powers never held by the same hand.

---

*DESIGN DRAFT, 2026-07-12. Spec/policy only — zero contract code. The
furthest-out document in the federation series; presumes a merged
STATUTORY-LANES relationship and resolution of findings A-2 and B-3.*
