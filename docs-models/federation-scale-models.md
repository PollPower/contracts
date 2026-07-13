# Federation Scale Models — Dilution, Throughput, DUST Budget (WI-19)

**Status:** MODELING DOC — order-of-magnitude inputs for calibration decisions.
Not a spec, not policy. Every number below is computed from the named
assumptions (A1, A2, …) by [`gen-scale-models.mjs`](./gen-scale-models.mjs);
change an assumption, rerun the script, and every table regenerates.

**Regenerate:** `node docs-models/gen-scale-models.mjs` (stdout is this
document's body, verbatim).

**Feeds:** CAL-9 (one national LD pool vs federated county pools — Part A
ends with the decision-ready comparison), operator-agreement modeling (B-4),
NATIONAL-ONBOARDING Phase-3 pacing (Parts B and C).

**Reads:** `FEDERATED-TARIFF-OPEN-QUESTIONS.md` B-3/B-4,
`NATIONAL-ONBOARDING-PROTOCOL.md` §3–§4, `living-dividend/DESIGN.md`,
`living-dividend/living-dividend-v2.2.1.compact` (bumpOnMint/claim cost
surface).

**No pilot financial figures are used anywhere** — the mint anchor (A1) is a
deliberately round modeling number; rescale by inspection.

---
### PART A ΓÇö Cross-operator Living Dividend dilution scenarios (B-4)

#### Assumptions (Part A)

| Tag | Assumption | Value | Justification |
| --- | --- | --- | --- |
| A1 | Pilot-scale mint anchor per operator per month (kWh EBT) | 100,000 | Modeling anchor only; a round number for legibility. NOT a pilot financial figure. Rescale by inspection. |
| A2 | LD slice fraction of mint routed to dividend pool | 0.0186 | DESIGN.md ┬º9 starting value (100% of solar-dividend slice = 1.86%). Governance-tunable later. |
| A3 | Operator counts modeled | 2, 5, 20 | WI-19 brief grid. |
| A4 | Members per operator modeled | 100, 1000, 10000, 100000 | WI-19 brief grid, spanning village-scale to county-scale rolls. |
| A5 | Mint-rate ratios modeled | symmetric 1:1; asymmetric 10:1; extreme 100:1 | WI-19 brief grid: symmetric, moderate asymmetry, extreme asymmetry. |
| A5c | Heavy-operator count within each asymmetric scenario | 1 | Sharpest lens on the race dynamic: a single dominant operator against NΓÇô1 lights. Symmetric case degenerates cleanly. |
| A6 | Light-operator member count in registration-race view | 10,000 | Fixes light ops at aggressive registration to isolate the race; heavy-op member count varies across the grid rows. |

#### Accumulator semantics (from `living-dividend-v2.2.1.compact`)

The contract computes `delta = amount * SCALE / totalLivingMembers` in `bumpOnMint` and adds `delta` to a global `_accPerShare`. Every *living* member accrues the same share per bump, regardless of which operator's mint triggered the bump. On `claim`, `owed = (accPerShare - checkpoint) / SCALE`. Pruned members' unclaimed accruals implicitly revert to the pool (checkpoint discarded, per-member share of remaining members grows on the next bump). This is the semantic the tables below encode.

These tables express dividends as **kWh of EBT per member per month**. All figures scale linearly with A1 ΓÇö halve A1 and every kWh number halves.

#### Table A.1 ΓÇö Symmetric baseline

**Table A.1 ΓÇö Per-member dividend (kWh/month), SYMMETRIC 1:1 case, uniform members-per-operator.**
Assumptions: A1, A2, A3, A4. Posture: identical for national and federated (all pools are identical, so aggregation doesn't matter).

| members/op Γåô / operators ΓåÆ | 2 ops | 5 ops | 20 ops |
| --- | --- | --- | --- |
| 100 | 18.6 | 18.6 | 18.6 |
| 1,000 | 1.86 | 1.86 | 1.86 |
| 10,000 | 0.186 | 0.186 | 0.186 |
| 100,000 | 0.019 | 0.019 | 0.019 |

#### Table A.2 ΓÇö Asymmetric mint, uniform member counts

**Table A.2 (national) ΓÇö Per-member dividend (kWh/month), ASYMMETRIC mint, uniform members-per-operator (one NATIONAL pool).**
Assumptions: A1, A2, A3, A4, A5, A5c. Heavy op = single dominant operator; light ops = the rest at 1├ù baseline. Uniform members-per-op isolates the pool-aggregation effect (row shows: heavy dividend / light dividend).

| ratio Γåô / (members/op, operators) ΓåÆ | 2ops┬╖100m | 2ops┬╖1,000m | 2ops┬╖10,000m | 2ops┬╖100,000m | 5ops┬╖100m | 5ops┬╖1,000m | 5ops┬╖10,000m | 5ops┬╖100,000m | 20ops┬╖100m | 20ops┬╖1,000m | 20ops┬╖10,000m | 20ops┬╖100,000m |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| symmetric 1:1 | 18.6 / 18.6 | 1.86 / 1.86 | 0.186 / 0.186 | 0.019 / 0.019 | 18.6 / 18.6 | 1.86 / 1.86 | 0.186 / 0.186 | 0.019 / 0.019 | 18.6 / 18.6 | 1.86 / 1.86 | 0.186 / 0.186 | 0.019 / 0.019 |
| asymmetric 10:1 | 102 / 102 | 10.2 / 10.2 | 1.02 / 1.02 | 0.102 / 0.102 | 52.1 / 52.1 | 5.21 / 5.21 | 0.521 / 0.521 | 0.052 / 0.052 | 27.0 / 27.0 | 2.70 / 2.70 | 0.270 / 0.270 | 0.027 / 0.027 |
| extreme 100:1 | 939 / 939 | 93.9 / 93.9 | 9.39 / 9.39 | 0.939 / 0.939 | 387 / 387 | 38.7 / 38.7 | 3.87 / 3.87 | 0.387 / 0.387 | 111 / 111 | 11.1 / 11.1 | 1.11 / 1.11 | 0.111 / 0.111 |

**Table A.2 (federated) ΓÇö Per-member dividend (kWh/month), ASYMMETRIC mint, uniform members-per-operator (FEDERATED per-operator pools).**
Assumptions: A1, A2, A3, A4, A5, A5c. Heavy op = single dominant operator; light ops = the rest at 1├ù baseline. Uniform members-per-op isolates the pool-aggregation effect (row shows: heavy dividend / light dividend).

| ratio Γåô / (members/op, operators) ΓåÆ | 2ops┬╖100m | 2ops┬╖1,000m | 2ops┬╖10,000m | 2ops┬╖100,000m | 5ops┬╖100m | 5ops┬╖1,000m | 5ops┬╖10,000m | 5ops┬╖100,000m | 20ops┬╖100m | 20ops┬╖1,000m | 20ops┬╖10,000m | 20ops┬╖100,000m |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| symmetric 1:1 | 18.6 / 18.6 | 1.86 / 1.86 | 0.186 / 0.186 | 0.019 / 0.019 | 18.6 / 18.6 | 1.86 / 1.86 | 0.186 / 0.186 | 0.019 / 0.019 | 18.6 / 18.6 | 1.86 / 1.86 | 0.186 / 0.186 | 0.019 / 0.019 |
| asymmetric 10:1 | 186 / 18.6 | 18.6 / 1.86 | 1.86 / 0.186 | 0.186 / 0.019 | 186 / 18.6 | 18.6 / 1.86 | 1.86 / 0.186 | 0.186 / 0.019 | 186 / 18.6 | 18.6 / 1.86 | 1.86 / 0.186 | 0.186 / 0.019 |
| extreme 100:1 | 1860 / 18.6 | 186 / 1.86 | 18.6 / 0.186 | 1.86 / 0.019 | 1860 / 18.6 | 186 / 1.86 | 18.6 / 0.186 | 1.86 / 0.019 | 1860 / 18.6 | 186 / 1.86 | 18.6 / 0.186 | 1.86 / 0.019 |

Reading A.2: under **national** posture, heavy and light per-member dividends are equal at every grid point (one pool, equal accrual). Under **federated** posture, the heavy operator's members receive a dividend proportional to the heavy mint rate; the light operators' members receive the baseline. The gap between postures widens with the mint ratio.

#### Table A.3 ΓÇö The registration race, visible

**Table A.3 ΓÇö Registration race (NATIONAL pool only). Light operators register A6 members each; heavy operator's roll varies. Rows: heavy op's registered members. Columns: (operators, mint ratio).**
Assumptions: A1, A2, A3, A5, A5c, A6. Cells: heavy-op-member kWh/mo / light-op-member kWh/mo (they're equal under the national pool ΓÇö that's the point). Also shows FUNDING SHARE of each cohort (heavy%/light%).

| heavy-op members Γåô | 2ops┬╖symmetric 1:1 | 2ops┬╖asymmetric 10:1 | 2ops┬╖extreme 100:1 | 5ops┬╖symmetric 1:1 | 5ops┬╖asymmetric 10:1 | 5ops┬╖extreme 100:1 | 20ops┬╖symmetric 1:1 | 20ops┬╖asymmetric 10:1 | 20ops┬╖extreme 100:1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 0.368/0.368 ┬╖ fund 50%/50% | 2.03/2.03 ┬╖ fund 91%/9% | 18.6/18.6 ┬╖ fund 99%/1% | 0.232/0.232 ┬╖ fund 20%/80% | 0.649/0.649 ┬╖ fund 71%/29% | 4.82/4.82 ┬╖ fund 96%/4% | 0.196/0.196 ┬╖ fund 5%/95% | 0.284/0.284 ┬╖ fund 34%/66% | 1.16/1.16 ┬╖ fund 84%/16% |
| 1,000 | 0.338/0.338 ┬╖ fund 50%/50% | 1.86/1.86 ┬╖ fund 91%/9% | 17.1/17.1 ┬╖ fund 99%/1% | 0.227/0.227 ┬╖ fund 20%/80% | 0.635/0.635 ┬╖ fund 71%/29% | 4.72/4.72 ┬╖ fund 96%/4% | 0.195/0.195 ┬╖ fund 5%/95% | 0.282/0.282 ┬╖ fund 34%/66% | 1.16/1.16 ┬╖ fund 84%/16% |
| 10,000 | 0.186/0.186 ┬╖ fund 50%/50% | 1.02/1.02 ┬╖ fund 91%/9% | 9.39/9.39 ┬╖ fund 99%/1% | 0.186/0.186 ┬╖ fund 20%/80% | 0.521/0.521 ┬╖ fund 71%/29% | 3.87/3.87 ┬╖ fund 96%/4% | 0.186/0.186 ┬╖ fund 5%/95% | 0.270/0.270 ┬╖ fund 34%/66% | 1.11/1.11 ┬╖ fund 84%/16% |
| 100,000 | 0.034/0.034 ┬╖ fund 50%/50% | 0.186/0.186 ┬╖ fund 91%/9% | 1.71/1.71 ┬╖ fund 99%/1% | 0.066/0.066 ┬╖ fund 20%/80% | 0.186/0.186 ┬╖ fund 71%/29% | 1.38/1.38 ┬╖ fund 96%/4% | 0.128/0.128 ┬╖ fund 5%/95% | 0.186/0.186 ┬╖ fund 34%/66% | 0.763/0.763 ┬╖ fund 84%/16% |

Note on reading: heavy and light per-member dividends are equal (one pool, equal accrual per living member ΓÇö accumulator semantics per DESIGN.md ┬º2). But *funding shares* diverge sharply. At ratio 100:1 the heavy op funds ~99% of the pool while its members collect the same per-head share as A6-registered light-op members. If the heavy op's members outnumber the light-op registrations, the heavy op is a net *contributor*; if the light ops out-register, they collect from a pool they barely funded. That gradient is the registration-race dynamic.

#### Table A.4 ΓÇö CAL-9 decision-ready comparison

**Table A.4 ΓÇö CAL-9 comparison. Per-member dividend (kWh/month) under NATIONAL vs FEDERATED pool posture, at the registration-race grid point (A6 light-op members, heavy-op members varied).**
Assumptions: A1, A2, A3, A5, A5c, A6.
Cells: NAT (single equal-per-member value) ┬╖ FED heavy / FED light. Under national posture, heavy and light members receive the same dividend. Under federated posture, each member draws only from their operator's own pool.

| heavy-op members Γåô | 2ops┬╖symmetric 1:1 | 2ops┬╖asymmetric 10:1 | 2ops┬╖extreme 100:1 | 5ops┬╖symmetric 1:1 | 5ops┬╖asymmetric 10:1 | 5ops┬╖extreme 100:1 | 20ops┬╖symmetric 1:1 | 20ops┬╖asymmetric 10:1 | 20ops┬╖extreme 100:1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | NAT 0.368 ┬╖ FED 18.6/0.186 | NAT 2.03 ┬╖ FED 186/0.186 | NAT 18.6 ┬╖ FED 1860/0.186 | NAT 0.232 ┬╖ FED 18.6/0.186 | NAT 0.649 ┬╖ FED 186/0.186 | NAT 4.82 ┬╖ FED 1860/0.186 | NAT 0.196 ┬╖ FED 18.6/0.186 | NAT 0.284 ┬╖ FED 186/0.186 | NAT 1.16 ┬╖ FED 1860/0.186 |
| 1,000 | NAT 0.338 ┬╖ FED 1.86/0.186 | NAT 1.86 ┬╖ FED 18.6/0.186 | NAT 17.1 ┬╖ FED 186/0.186 | NAT 0.227 ┬╖ FED 1.86/0.186 | NAT 0.635 ┬╖ FED 18.6/0.186 | NAT 4.72 ┬╖ FED 186/0.186 | NAT 0.195 ┬╖ FED 1.86/0.186 | NAT 0.282 ┬╖ FED 18.6/0.186 | NAT 1.16 ┬╖ FED 186/0.186 |
| 10,000 | NAT 0.186 ┬╖ FED 0.186/0.186 | NAT 1.02 ┬╖ FED 1.86/0.186 | NAT 9.39 ┬╖ FED 18.6/0.186 | NAT 0.186 ┬╖ FED 0.186/0.186 | NAT 0.521 ┬╖ FED 1.86/0.186 | NAT 3.87 ┬╖ FED 18.6/0.186 | NAT 0.186 ┬╖ FED 0.186/0.186 | NAT 0.270 ┬╖ FED 1.86/0.186 | NAT 1.11 ┬╖ FED 18.6/0.186 |
| 100,000 | NAT 0.034 ┬╖ FED 0.019/0.186 | NAT 0.186 ┬╖ FED 0.186/0.186 | NAT 1.71 ┬╖ FED 1.86/0.186 | NAT 0.066 ┬╖ FED 0.019/0.186 | NAT 0.186 ┬╖ FED 0.186/0.186 | NAT 1.38 ┬╖ FED 1.86/0.186 | NAT 0.128 ┬╖ FED 0.019/0.186 | NAT 0.186 ┬╖ FED 0.186/0.186 | NAT 0.763 ┬╖ FED 1.86/0.186 |

**CAL-9 inputs for Garrett's decision (not a recommendation):**

- **National posture** delivers uniform per-member dividends across the entire roll ΓÇö a solidarity property. It also creates the funding-share gradient visible in A.3: at ratio 100:1 the heavy op funds ~99% of the pool while collecting the same per-head share as light-op members. Whether that is *good* (network-level solidarity, a reason to onboard poorer counties fast) or *bad* (heavy operators subsidizing everyone else's members, an operator-agreement fault line) is a policy question, not a math question.
- **Federated posture** ties per-member dividend to per-operator mint. Heavy-op members collect a heavy dividend; light-op members collect a light one. The funding-share gradient goes away because each operator only funds its own members. But the flagship promise ("a consumer's EBT spends identically anywhere") is preserved on the *token* side; the dividend *rate* diverges regionally. Under 100:1 asymmetry, heavy-op members collect ~100├ù light-op members at the same member count ΓÇö that is a highly visible regional inequality.
- **Hybrid postures exist** (federated per-cluster pools under a constitutional floor) but are not modeled here ΓÇö the two endpoints bound the design space.
- **Registration-race dynamic**: only present under national posture. Federated pools structurally eliminate the race but at the cost of the solidarity property.
- **Sensitivity to A1**: none ΓÇö the *ratios* between grid cells are invariant to A1; only absolute kWh values scale. The decision structure Garrett faces is stable across mint-anchor choices.
- **Sensitivity to A2**: same ΓÇö LD slice fraction only scales the absolute kWh values.
- **Not modeled**: intra-national clearinghouse settlement effects (A-1), inter-operator credit risk (A-2). Those live in WI-01 and WI-02 and do not change the accumulator arithmetic.


### PART B ΓÇö National-scale claim and proof throughput

#### Assumptions (Part B)

| Tag | Assumption | Value | Justification |
| --- | --- | --- | --- |
| A8 | National adult population | 30,000,000 | Kenya-scale anchor per NATIONAL-ONBOARDING-PROTOCOL ┬º2/┬º3. Modeling assumption; rescale by inspection. |
| A9 | National adoption levels modeled | 1%, 5%, 20% | WI-19 brief: 1% / 5% / 20% of adult population. |
| A10 | Claim-cadence scenarios | monthly (12.00/yr/member); quarterly (4.00/yr/member); on-demand (30% MAU) (3.60/yr/member) | WI-19 brief: monthly, quarterly, on-demand-with-30%-MAU. |
| A11 | Epoch length (days) | 30 | Monthly accounting window matching in-app accrual visibility. Not on-chain constant; a framing choice. |
| A12 | Proof-generation time per proof, sensitivity range (seconds) | 2, 10, 30 | WI-19 brief: 2ΓÇô30s. Spans fast-GPU-relay to slow-CPU-relay; presented as a range, never a point estimate. |
| A13 | Relay proof-worker utilization (0ΓÇô1) | 0.5 | Reserves capacity for reorgs, retries, indexer catchup, and burst absorption. |
| A14 | Proof workers per relay host | 4 | Modest per-host parallelism; a single well-provisioned box can run more. |
| A15 | Bump throughput per operator per day, sensitivity range | 10, 100, 1000 | One bumpOnMint per settled DividendMinted event. Range spans pilot to national settlement rate. |

#### Cost surface (from the contract)

- Each `claim` call is O(1): one signature witness verify, one divmod, one map lookup on `_members`, one map insert to `_pendingClaims`, one map insert to `_claimLog`. All independent per member ΓÇö trivially parallel at the proof tier.
- Each `bumpOnMint` call is O(1): one divmod, one accumulator write, one set insert (salt). Also trivially parallel.
- Both share the same relay proof capacity. Table B.3 models claim demand; Table B.4 shows bump demand on the same fleet.

#### Table B.1 ΓÇö Claims per epoch

**Table B.1 ΓÇö Claims per epoch by adoption level and cadence.**
Assumptions: A8, A9, A10, A11. Epoch = A11 days. Claims/epoch = enrolled ├ù claims-per-year-per-member ├ù (A11 / 365).

| adoption Γåô / cadence ΓåÆ | monthly | quarterly | on-demand (30% MAU) |
| --- | --- | --- | --- |
| 1% (300.0k adults) | 295.89k | 98.63k | 88.77k |
| 5% (1.5M adults) | 1.48M | 493.15k | 443.84k |
| 20% (6.0M adults) | 5.92M | 1.97M | 1.78M |

#### Table B.2 ΓÇö Sustained claim rate driving the proof fleet

**Table B.2 ΓÇö Sustained claim rate (claims/sec) driving the proof fleet.**
Assumptions: A8, A9, A10, A11. claims/sec = claims-per-epoch / (A11 ├ù 86400).

| adoption Γåô / cadence ΓåÆ | monthly | quarterly | on-demand (30% MAU) |
| --- | --- | --- | --- |
| 1% | 0.1142 | 0.0381 | 0.0342 |
| 5% | 0.5708 | 0.1903 | 0.1712 |
| 20% | 2.283 | 0.7610 | 0.6849 |

#### Table B.3 ΓÇö Required relay fleet size (SENSITIVITY across proof time)

**Table B.3 ΓÇö Relay fleet size required (hosts) at each proof-time point, adoption ├ù cadence grid.**
Assumptions: A12, A13, A14. hosts = claims-per-sec ├ù proof-sec / (A13 ├ù A14). Proof time SENSITIVITY shown as a range (A12): [fast / mid / slow] seconds per proof.

| proof-sec (A12) Γåô / (adoption, cadence) ΓåÆ | 1%┬╖monthly | 1%┬╖quarterly | 1%┬╖on-demand | 5%┬╖monthly | 5%┬╖quarterly | 5%┬╖on-demand | 20%┬╖monthly | 20%┬╖quarterly | 20%┬╖on-demand |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2s | 0.1142 | 0.0381 | 0.0342 | 0.5708 | 0.1903 | 0.1712 | 2.3 | 0.7610 | 0.6849 |
| 10s | 0.5708 | 0.1903 | 0.1712 | 2.9 | 0.9513 | 0.8562 | 11.4 | 3.8 | 3.4 |
| 30s | 1.7 | 0.5708 | 0.5137 | 8.6 | 2.9 | 2.6 | 34.2 | 11.4 | 10.3 |

Note: relays are highly parallelizable (each claim proof is independent). A ΓÇ£hostΓÇ¥ here is A14=4 concurrent proof workers at A13=50% utilization; scale up cheaply. The purpose of the table is to show *where the workload starts requiring more than one box* and where it starts requiring dozens.

#### Table B.4 ΓÇö bumpOnMint load at the relay tier

**Table B.4 ΓÇö bumpOnMint load at the relay tier (bumps/sec) ΓÇö separate from claims, shares the same proof capacity.**
Assumptions: A15. Each active operator emits mint events at the A15 rate; each becomes one bumpOnMint tx. Kept independent of adoption because it scales with operator/settlement activity, not member count.

| mint rate (A15) Γåô | bumps/day (per op) | bumps/sec (per op) | at 100 ops (bumps/sec) |
| --- | --- | --- | --- |
| 10 | 10 | 1.16e-4 | 0.0116 |
| 100 | 100 | 0.0012 | 0.1157 |
| 1000 | 1000 | 0.0116 | 1.157 |

Note: bumps and claims both consume proof capacity from the same fleet. Table B.3 shows claim-only fleet sizing; the operator ought to add A15's demand to the same fleet when sizing. Bumps are O(1) per event (one divmod + one set insert + one accumulator write), so per-proof cost is comparable to claims.


### PART C ΓÇö DUST budget for county-scale Merkle-cohort rollout

#### Assumptions (Part C)

| Tag | Assumption | Value | Justification |
| --- | --- | --- | --- |
| A16 | County adult population target | 500,000 | Mid-size Kenyan-county anchor for per-county DUST modeling. |
| A17 | Cohort sizes modeled (members per Merkle root) | 1000, 10000, 100000 | Small (village registrar), medium (agent-network cohort), large (single-county batch). |
| A18 | DUST-per-tx sensitivity range | 0.5, 1, 5 | Modeling units ΓÇö DUST market pricing is a separate assumption we do not embed. Sensitivity shown across a plausible band. |
| A19 | Claim-uptake rates modeled | 10%, 30%, 50%, 80% | Fraction of registered adults who ever call claim within the modeling window. Sensitivity band. |
| A20 | Root txs per cohort, sensitivity range | 1, 2, 3 | 1 = pure post; 2ΓÇô3 = post + countersign + finalize under challenge-window design. |

#### Model

Under the Merkle-cohort model (NATIONAL-ONBOARDING-PROTOCOL ┬º2 Phase 3), a delegated registrar submits one Merkle root per cohort; individual members are proven into the roll only when they first claim. The on-chain cost is therefore:

```
on-chain txs = ceil(county-adults / cohort-size) ├ù rootTx-per-cohort
             + county-adults ├ù claim-uptake-rate
```

The naive alternative ΓÇö one `register()` tx per adult ΓÇö costs `county-adults + county-adults ├ù claim-uptake`, a strict superset. Members who never claim are FREE under the cohort model; they cost one full registration under the naive model.

#### Table C.1 ΓÇö On-chain tx count, cohort vs naive

**Table C.1 ΓÇö On-chain tx count for one county rollout (A16 adults), Merkle-cohort model vs naive one-registration-per-person.**
Assumptions: A16, A17, A19, A20. Cohort model: txs = ceil(A16 / cohortSize) ├ù A20-root-txs + A16 ├ù claim-uptake. Naive model: txs = A16 (registrations) + A16 ├ù claim-uptake.

| uptake Γåô / (cohort size, root txs) ΓåÆ | NAIVE | cohort 1,000┬╖rootTx=1 | cohort 1,000┬╖rootTx=2 | cohort 1,000┬╖rootTx=3 | cohort 10,000┬╖rootTx=1 | cohort 10,000┬╖rootTx=2 | cohort 10,000┬╖rootTx=3 | cohort 100,000┬╖rootTx=1 | cohort 100,000┬╖rootTx=2 | cohort 100,000┬╖rootTx=3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10% | 550.00k | 50.50k | 51.00k | 51.50k | 50.05k | 50.10k | 50.15k | 50.01k | 50.01k | 50.02k |
| 30% | 650.00k | 150.50k | 151.00k | 151.50k | 150.05k | 150.10k | 150.15k | 150.00k | 150.01k | 150.01k |
| 50% | 750.00k | 250.50k | 251.00k | 251.50k | 250.05k | 250.10k | 250.15k | 250.00k | 250.01k | 250.01k |
| 80% | 900.00k | 400.50k | 401.00k | 401.50k | 400.05k | 400.10k | 400.15k | 400.00k | 400.01k | 400.01k |

#### Table C.2 ΓÇö DUST budget, uptake ├ù DUST/tx sensitivity

**Table C.2 ΓÇö DUST budget (total DUST) per county rollout under Merkle-cohort model.**
Assumptions: A16, A17, A18, A19, A20. Uses mid cohort size (A17[1]) and mid rootTx (A20[1]) as anchor; DUST/tx SENSITIVITY across A18 range.
Anchor: cohort size = 10,000, rootTx per cohort = 2. County adults = 500,000.

| uptake Γåô / DUST/tx (A18) ΓåÆ | 0.5 DUST/tx | 1 DUST/tx | 5 DUST/tx |
| --- | --- | --- | --- |
| 10% | 25.05k DUST | 50.10k DUST | 250.50k DUST |
| 30% | 75.05k DUST | 150.10k DUST | 750.50k DUST |
| 50% | 125.05k DUST | 250.10k DUST | 1.25M DUST |
| 80% | 200.05k DUST | 400.10k DUST | 2.00M DUST |

Note: at low uptake the cost is dominated by the cohort roots (fixed regardless of who claims); at high uptake the cost tracks claim count linearly. The unclaimed population is *free* ΓÇö the Merkle-cohort model's dominant win over the naive registration-per-person model, and the one that pays off exactly when the roll is largest.

#### Table C.3 ΓÇö DUST sensitivity to cohort size

**Table C.3 ΓÇö DUST-cost sensitivity to COHORT SIZE at fixed uptake (30%, A19[1]).**
Assumptions: A16, A17, A18, A19, A20. Uses mid DUST/tx (A18[1]) and mid rootTx (A20[1]).
Uptake fixed at 30%. DUST/tx = 1. rootTx per cohort = 2.

| cohort size | # cohorts (county) | root txs | claim txs (30% uptake) | total txs | total DUST |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 500 | 1000 | 150k | 151.00k | 151.00k DUST |
| 10,000 | 50 | 100 | 150k | 150.10k | 150.10k DUST |
| 100,000 | 5 | 10 | 150k | 150.01k | 150.01k DUST |

Note: cohort size has bounded effect on total DUST because root cost is small vs claim cost at any nontrivial uptake. Optimize cohort size for *registrar operational fit* (how large a batch can one delegate reasonably verify + countersign), not DUST budget.

