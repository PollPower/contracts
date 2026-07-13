#!/usr/bin/env node
// gen-scale-models.mjs
//
// WI-19 generator: emits every results table in federation-scale-models.md
// from the assumption values below. Change an assumption, re-run, tables
// update. No number in the doc should exist without a traceable A-tag here.
//
// Usage:
//   node docs-models/gen-scale-models.mjs                # print all tables
//   node docs-models/gen-scale-models.mjs partA          # only PART A tables
//   node docs-models/gen-scale-models.mjs partB
//   node docs-models/gen-scale-models.mjs partC
//   node docs-models/gen-scale-models.mjs assumptions    # dump A1..An
//
// The doc's committed tables MUST match this script's output. If they drift,
// re-run and paste. There is no "hand-edited number" allowed in the doc.
//
// Conventions:
//   - Every knob is a named constant with an A-tag comment.
//   - Every table function is pure over those constants.
//   - Formatters print numbers with fixed precision so diffs are stable.
//   - No pilot-confidential figures. Every kWh/DUST value is a labelled
//     modeling assumption.

// ─── ASSUMPTIONS ──────────────────────────────────────────────────────
// Each assumption has an A-tag, a value, and a justification. The doc
// renders these into an ASSUMPTIONS TABLE per part. NEVER hardcode a
// derived value here — derive it in the table functions.

// ── PART A — Dilution ─────────────────────────────────────────────────

// A1: Pilot-scale mint anchor (EBT/kWh minted per operator per month).
// A modeling anchor, NOT a pilot financial figure. Choose a round number
// so the reader can rescale by inspection.
const A1_PILOT_MINT_EBT_PER_OP_PER_MONTH = 100_000; // kWh EBT / operator / month

// A2: LD slice of mint routed to dividend pool. Matches DESIGN.md §9
// starting value (100% of solar-dividend slice = 1.86% of throughput).
const A2_LD_SLICE_FRACTION = 0.0186;

// A3: Operator counts modeled in the grid.
const A3_OPERATOR_COUNTS = [2, 5, 20];

// A4: Members per operator modeled in the grid.
const A4_MEMBERS_PER_OP = [100, 1_000, 10_000, 100_000];

// A5: Mint-rate ratios modeled: symmetric, 10:1 asymmetric, 100:1 extreme.
// Ratio R means "highest-throughput operator mints R× the lowest".
// A5b: within an asymmetric case we model TWO cohorts of operators — a
// "heavy" cohort at multiplier R and a "light" cohort at multiplier 1×.
// A5c: heavy-cohort fraction = 1/N (a single dominant operator) for the
// registration-race view. This is the sharpest case; symmetric is R=1.
const A5_MINT_RATIOS = [
  { label: "symmetric 1:1",  ratio: 1 },
  { label: "asymmetric 10:1", ratio: 10 },
  { label: "extreme 100:1",  ratio: 100 },
];
const A5c_HEAVY_COUNT = 1; // single dominant heavy operator per scenario

// A6: Registration-race member split. In the race view we fix the "light"
// operators at a low member count and the "heavy" operator at a matching
// grid value, so the same table row shows who funds vs who collects.
// This is the modeling posture that makes the race visible: light
// operators register aggressively; heavy operator does not.
const A6_LIGHT_OP_MEMBERS = 10_000; // members each light operator registers

// A7: Pool posture — ONE national pool (all mint aggregated, per-member
// accrual across the whole roll) vs FEDERATED (each pool serves only its
// operator's members). This is the CAL-9 decision variable; we compute
// both for the comparison table.

// ── PART B — Throughput ───────────────────────────────────────────────

// A8: National adult population — used for national-scale adoption grids.
// Anchored to Kenya-scale for readability; NOT a pilot figure.
const A8_NATIONAL_ADULT_POPULATION = 30_000_000;

// A9: Adoption levels modeled.
const A9_ADOPTION_LEVELS = [0.01, 0.05, 0.20];

// A10: Claim cadence scenarios.
//   monthly:   every member claims once per month
//   quarterly: every member claims once per quarter
//   ondemand:  30% of members are monthly-active claimers (the "MAU-30")
const A10_CADENCES = [
  { label: "monthly",                    claimsPerYearPerMember: 12 },
  { label: "quarterly",                  claimsPerYearPerMember: 4 },
  { label: "on-demand (30% MAU)",        claimsPerYearPerMember: 12 * 0.30 },
];

// A11: Epoch length. LD's checkpointing is not tied to a fixed epoch,
// but the doc frames throughput "per epoch". We use a monthly epoch as
// the canonical accounting window (matches accrual visibility in-app).
const A11_EPOCH_DAYS = 30;

// A12: Proof-generation time per claim proof, at the relay tier. The
// sensitivity range spans slow-CPU-relay to fast-GPU-relay estimates.
// Present as a RANGE, not a point estimate. Values in seconds.
const A12_PROOF_SECONDS_RANGE = [2, 10, 30];

// A13: Effective proof throughput per relay: seconds of proof compute
// per relay per second of wall time. Well under 1.0 to leave headroom
// for reorgs, retries, and non-proof work (indexer catchup, batching).
const A13_RELAY_UTILIZATION = 0.5;

// A14: Relay parallelism per box — a single relay host with N proof
// workers. Sensitivity: single core to well-provisioned server.
const A14_RELAY_PARALLELISM = 4;

// A15: Bump throughput — mint events per operator per day. Every settled
// consumption session emits a `DividendMinted` event that the keeper
// turns into a `bumpOnMint` tx. This is separate from claim throughput
// but shares the same relay tier. Range = pilot rate to national rate.
const A15_BUMPS_PER_OP_PER_DAY_RANGE = [10, 100, 1000];

// ── PART C — DUST budget for Merkle-cohort rollout ────────────────────

// A16: County adult population target (e.g., a mid-size Kenyan county).
const A16_COUNTY_ADULT_POPULATION = 500_000;

// A17: Cohort sizes modeled (members proven under one Merkle root).
const A17_COHORT_SIZES = [1_000, 10_000, 100_000];

// A18: DUST cost per on-chain tx, sensitivity range. DUST is Midnight's
// fee unit; we do NOT dollarize because DUST market pricing is a
// separate assumption. Present a plausible RANGE and let the doc show
// sensitivity. Values are illustrative modeling units.
const A18_DUST_PER_TX_RANGE = [0.5, 1.0, 5.0]; // DUST / tx (parametric)

// A19: Claim-uptake rates over the rollout horizon — fraction of
// registered adults who ever call `claim` within the modeling window.
const A19_CLAIM_UPTAKE_RATES = [0.10, 0.30, 0.50, 0.80];

// A20: Cohort-root txs per cohort. Base = 1 root submission; if the
// challenge window costs extra tx surface (a countersign + a finalize),
// that raises the constant. Sensitivity kept explicit.
const A20_ROOT_TX_PER_COHORT_RANGE = [1, 2, 3];

// ─── FORMATTERS ───────────────────────────────────────────────────────

function fmt(n, digits = 2) {
  if (!isFinite(n)) return "n/a";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(digits) + "k";
  if (Math.abs(n) >= 1)   return n.toFixed(digits);
  if (Math.abs(n) >= 0.001) return n.toFixed(4);
  return n.toExponential(2);
}

function fmtInt(n) {
  if (!isFinite(n)) return "n/a";
  return Math.round(n).toLocaleString("en-US");
}

function fmtKWh(n) {
  // Dividends stay in kWh; keep two decimals below 100 kWh and integers above.
  if (!isFinite(n)) return "n/a";
  if (n === 0) return "0";
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toExponential(2);
}

function tableRow(cells) {
  return "| " + cells.join(" | ") + " |";
}

// ─── PART A TABLES ────────────────────────────────────────────────────

// Compute per-member monthly dividend under a pool posture.
//   posture: "national" (one pool spans all operators) or "federated"
//            (each operator's pool serves only its members).
//   nOps:       operator count in the scenario
//   membersPerOp: members registered per operator (uniform in symmetric case)
//   heavyMintMultiplier: heavy operator mints heavyMintMultiplier×
//                       the light operators; light = 1×.
//                       symmetric case: heavyMintMultiplier = 1.
//   heavyMembers: members registered under the heavy operator
//                 (only used in registration-race view; else = membersPerOp)
//   lightMembers: members per light operator
// Returns { heavyDividend, lightDividend }.
function perMemberMonthlyKWh({
  posture,
  nOps,
  heavyCount = A5c_HEAVY_COUNT,
  heavyMintMultiplier,
  heavyMembers,
  lightMembers,
}) {
  const lightCount = nOps - heavyCount;
  const perOpBaseMint = A1_PILOT_MINT_EBT_PER_OP_PER_MONTH; // kWh/op/mo (light)
  const perOpHeavyMint = perOpBaseMint * heavyMintMultiplier;
  const lightPoolMonthly = perOpBaseMint * A2_LD_SLICE_FRACTION;   // kWh/mo per light op → pool
  const heavyPoolMonthly = perOpHeavyMint * A2_LD_SLICE_FRACTION;  // kWh/mo per heavy op → pool

  if (posture === "national") {
    const totalPool = heavyCount * heavyPoolMonthly + lightCount * lightPoolMonthly;
    const totalMembers = heavyCount * heavyMembers + lightCount * lightMembers;
    const perMember = totalMembers > 0 ? totalPool / totalMembers : 0;
    return { heavyDividend: perMember, lightDividend: perMember };
  }
  if (posture === "federated") {
    const heavyDividend = heavyMembers > 0 ? heavyPoolMonthly / heavyMembers : 0;
    const lightDividend = lightMembers > 0 ? lightPoolMonthly / lightMembers : 0;
    return { heavyDividend, lightDividend };
  }
  throw new Error("unknown posture: " + posture);
}

// Table A.1 — Symmetric (heavyMintMultiplier=1). One row per members-per-op;
// one column per operator count. Uniform members. Shows the baseline
// per-member kWh/month with zero asymmetry — the "no-race" reference.
function tableSymmetricPerMember() {
  const lines = [];
  lines.push("**Table A.1 — Per-member dividend (kWh/month), SYMMETRIC 1:1 case, uniform members-per-operator.**");
  lines.push("Assumptions: A1, A2, A3, A4. Posture: identical for national and federated (all pools are identical, so aggregation doesn't matter).");
  lines.push("");
  lines.push(tableRow(["members/op ↓ / operators →", ...A3_OPERATOR_COUNTS.map(n => `${n} ops`)]));
  lines.push(tableRow(["---", ...A3_OPERATOR_COUNTS.map(() => "---")]));
  for (const m of A4_MEMBERS_PER_OP) {
    const row = [fmtInt(m)];
    for (const n of A3_OPERATOR_COUNTS) {
      const { heavyDividend } = perMemberMonthlyKWh({
        posture: "national",
        nOps: n,
        heavyMintMultiplier: 1,
        heavyMembers: m,
        lightMembers: m,
      });
      row.push(fmtKWh(heavyDividend));
    }
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

// Table A.2 — Asymmetric mint (heavy = R× light), UNIFORM members-per-op.
// One table per posture (national vs federated), one row per (mint ratio,
// members-per-op), one column per operator count. This isolates the
// pool-aggregation effect from the registration race.
function tableAsymmetricUniformMembers(posture) {
  const lines = [];
  const postureLabel = posture === "national" ? "one NATIONAL pool" : "FEDERATED per-operator pools";
  lines.push(`**Table A.2 (${posture}) — Per-member dividend (kWh/month), ASYMMETRIC mint, uniform members-per-operator (${postureLabel}).**`);
  lines.push("Assumptions: A1, A2, A3, A4, A5, A5c. Heavy op = single dominant operator; light ops = the rest at 1× baseline. Uniform members-per-op isolates the pool-aggregation effect (row shows: heavy dividend / light dividend).");
  lines.push("");
  lines.push(tableRow(["ratio ↓ / (members/op, operators) →", ...A3_OPERATOR_COUNTS.flatMap(n =>
    A4_MEMBERS_PER_OP.map(m => `${n}ops·${fmtInt(m)}m`)
  )]));
  lines.push(tableRow(["---", ...A3_OPERATOR_COUNTS.flatMap(() => A4_MEMBERS_PER_OP.map(() => "---"))]));
  for (const { label, ratio } of A5_MINT_RATIOS) {
    const row = [label];
    for (const n of A3_OPERATOR_COUNTS) {
      for (const m of A4_MEMBERS_PER_OP) {
        const { heavyDividend, lightDividend } = perMemberMonthlyKWh({
          posture,
          nOps: n,
          heavyMintMultiplier: ratio,
          heavyMembers: m,
          lightMembers: m,
        });
        row.push(`${fmtKWh(heavyDividend)} / ${fmtKWh(lightDividend)}`);
      }
    }
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

// Table A.3 — Registration-race view. Light operators register A6 members
// each; heavy operator's membership varies across the grid rows. This is
// the "who funds vs who collects" table. National posture only, because
// the race is a national-pool phenomenon — under federated pools each
// operator's members can only draw from that operator's mint, so the
// race dynamic doesn't exist (that's the whole CAL-9 tradeoff).
function tableRegistrationRaceNational() {
  const lines = [];
  lines.push("**Table A.3 — Registration race (NATIONAL pool only). Light operators register A6 members each; heavy operator's roll varies. Rows: heavy op's registered members. Columns: (operators, mint ratio).**");
  lines.push("Assumptions: A1, A2, A3, A5, A5c, A6. Cells: heavy-op-member kWh/mo / light-op-member kWh/mo (they're equal under the national pool — that's the point). Also shows FUNDING SHARE of each cohort (heavy%/light%).");
  lines.push("");
  const cols = [];
  const colSpec = [];
  for (const n of A3_OPERATOR_COUNTS) {
    for (const { label, ratio } of A5_MINT_RATIOS) {
      cols.push(`${n}ops·${label}`);
      colSpec.push({ n, ratio });
    }
  }
  lines.push(tableRow(["heavy-op members ↓", ...cols]));
  lines.push(tableRow(["---", ...cols.map(() => "---")]));
  for (const heavyMembers of A4_MEMBERS_PER_OP) {
    const row = [fmtInt(heavyMembers)];
    for (const { n, ratio } of colSpec) {
      const { heavyDividend, lightDividend } = perMemberMonthlyKWh({
        posture: "national",
        nOps: n,
        heavyMintMultiplier: ratio,
        heavyMembers,
        lightMembers: A6_LIGHT_OP_MEMBERS,
      });
      // Funding shares: heavy op's mint contribution / total mint contribution
      const heavyMint = ratio; // relative units
      const lightMint = (n - A5c_HEAVY_COUNT) * 1;
      const heavyShare = heavyMint / (heavyMint + lightMint);
      const lightShare = lightMint / (heavyMint + lightMint);
      row.push(`${fmtKWh(heavyDividend)}/${fmtKWh(lightDividend)} · fund ${(heavyShare*100).toFixed(0)}%/${(lightShare*100).toFixed(0)}%`);
    }
    lines.push(tableRow(row));
  }
  lines.push("");
  lines.push(`Note on reading: heavy and light per-member dividends are equal (one pool, equal accrual per living member — accumulator semantics per DESIGN.md §2). But *funding shares* diverge sharply. At ratio 100:1 the heavy op funds ~99% of the pool while its members collect the same per-head share as A6-registered light-op members. If the heavy op's members outnumber the light-op registrations, the heavy op is a net *contributor*; if the light ops out-register, they collect from a pool they barely funded. That gradient is the registration-race dynamic.`);
  return lines.join("\n");
}

// Table A.4 — CAL-9 decision-ready comparison. For each grid point:
// national-posture per-member kWh vs federated-posture heavy-member kWh
// vs federated-posture light-member kWh. This is the input Garrett needs.
// NOT a recommendation.
function tableCAL9Comparison() {
  const lines = [];
  lines.push("**Table A.4 — CAL-9 comparison. Per-member dividend (kWh/month) under NATIONAL vs FEDERATED pool posture, at the registration-race grid point (A6 light-op members, heavy-op members varied).**");
  lines.push("Assumptions: A1, A2, A3, A5, A5c, A6.");
  lines.push("Cells: NAT (single equal-per-member value) · FED heavy / FED light. Under national posture, heavy and light members receive the same dividend. Under federated posture, each member draws only from their operator's own pool.");
  lines.push("");
  const cols = [];
  const colSpec = [];
  for (const n of A3_OPERATOR_COUNTS) {
    for (const { label, ratio } of A5_MINT_RATIOS) {
      cols.push(`${n}ops·${label}`);
      colSpec.push({ n, ratio });
    }
  }
  lines.push(tableRow(["heavy-op members ↓", ...cols]));
  lines.push(tableRow(["---", ...cols.map(() => "---")]));
  for (const heavyMembers of A4_MEMBERS_PER_OP) {
    const row = [fmtInt(heavyMembers)];
    for (const { n, ratio } of colSpec) {
      const nat = perMemberMonthlyKWh({
        posture: "national",
        nOps: n,
        heavyMintMultiplier: ratio,
        heavyMembers,
        lightMembers: A6_LIGHT_OP_MEMBERS,
      });
      const fed = perMemberMonthlyKWh({
        posture: "federated",
        nOps: n,
        heavyMintMultiplier: ratio,
        heavyMembers,
        lightMembers: A6_LIGHT_OP_MEMBERS,
      });
      row.push(`NAT ${fmtKWh(nat.heavyDividend)} · FED ${fmtKWh(fed.heavyDividend)}/${fmtKWh(fed.lightDividend)}`);
    }
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

// ─── PART B TABLES ────────────────────────────────────────────────────

function tableClaimsPerEpoch() {
  const lines = [];
  lines.push("**Table B.1 — Claims per epoch by adoption level and cadence.**");
  lines.push("Assumptions: A8, A9, A10, A11. Epoch = A11 days. Claims/epoch = enrolled × claims-per-year-per-member × (A11 / 365).");
  lines.push("");
  lines.push(tableRow(["adoption ↓ / cadence →", ...A10_CADENCES.map(c => c.label)]));
  lines.push(tableRow(["---", ...A10_CADENCES.map(() => "---")]));
  for (const p of A9_ADOPTION_LEVELS) {
    const enrolled = p * A8_NATIONAL_ADULT_POPULATION;
    const row = [`${(p*100).toFixed(0)}% (${fmt(enrolled, 1)} adults)`];
    for (const c of A10_CADENCES) {
      const claimsPerEpoch = enrolled * c.claimsPerYearPerMember * (A11_EPOCH_DAYS / 365);
      row.push(fmt(claimsPerEpoch, 2));
    }
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

function tableClaimsPerSecond() {
  // Sustained claim rate = claims/epoch / seconds-per-epoch. This is what
  // the proof-generation fleet must keep up with in steady state.
  const lines = [];
  lines.push("**Table B.2 — Sustained claim rate (claims/sec) driving the proof fleet.**");
  lines.push("Assumptions: A8, A9, A10, A11. claims/sec = claims-per-epoch / (A11 × 86400).");
  lines.push("");
  lines.push(tableRow(["adoption ↓ / cadence →", ...A10_CADENCES.map(c => c.label)]));
  lines.push(tableRow(["---", ...A10_CADENCES.map(() => "---")]));
  for (const p of A9_ADOPTION_LEVELS) {
    const enrolled = p * A8_NATIONAL_ADULT_POPULATION;
    const row = [`${(p*100).toFixed(0)}%`];
    for (const c of A10_CADENCES) {
      const claimsPerEpoch = enrolled * c.claimsPerYearPerMember * (A11_EPOCH_DAYS / 365);
      const rate = claimsPerEpoch / (A11_EPOCH_DAYS * 86400);
      row.push(fmt(rate, 3));
    }
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

function tableRelayFleetSize() {
  const lines = [];
  lines.push("**Table B.3 — Relay fleet size required (hosts) at each proof-time point, adoption × cadence grid.**");
  lines.push("Assumptions: A12, A13, A14. hosts = claims-per-sec × proof-sec / (A13 × A14). Proof time SENSITIVITY shown as a range (A12): [fast / mid / slow] seconds per proof.");
  lines.push("");
  const cadenceCols = [];
  for (const p of A9_ADOPTION_LEVELS) {
    for (const c of A10_CADENCES) {
      cadenceCols.push({ p, c });
    }
  }
  lines.push(tableRow(["proof-sec (A12) ↓ / (adoption, cadence) →", ...cadenceCols.map(({ p, c }) =>
    `${(p*100).toFixed(0)}%·${c.label.split(' ')[0]}`
  )]));
  lines.push(tableRow(["---", ...cadenceCols.map(() => "---")]));
  for (const proofSec of A12_PROOF_SECONDS_RANGE) {
    const row = [`${proofSec}s`];
    for (const { p, c } of cadenceCols) {
      const enrolled = p * A8_NATIONAL_ADULT_POPULATION;
      const claimsPerEpoch = enrolled * c.claimsPerYearPerMember * (A11_EPOCH_DAYS / 365);
      const rate = claimsPerEpoch / (A11_EPOCH_DAYS * 86400); // claims/sec
      const hosts = (rate * proofSec) / (A13_RELAY_UTILIZATION * A14_RELAY_PARALLELISM);
      row.push(fmt(hosts, 1));
    }
    lines.push(tableRow(row));
  }
  lines.push("");
  lines.push(`Note: relays are highly parallelizable (each claim proof is independent). A “host” here is A14=${A14_RELAY_PARALLELISM} concurrent proof workers at A13=${A13_RELAY_UTILIZATION*100}% utilization; scale up cheaply. The purpose of the table is to show *where the workload starts requiring more than one box* and where it starts requiring dozens.`);
  return lines.join("\n");
}

function tableBumpLoad() {
  // Bumps happen on every mint (per DividendMintedEntry stream). This
  // shows the *other* load on the relay tier that shares proof capacity
  // with claims. Bump proofs are structurally similar cost surfaces.
  const lines = [];
  lines.push("**Table B.4 — bumpOnMint load at the relay tier (bumps/sec) — separate from claims, shares the same proof capacity.**");
  lines.push("Assumptions: A15. Each active operator emits mint events at the A15 rate; each becomes one bumpOnMint tx. Kept independent of adoption because it scales with operator/settlement activity, not member count.");
  lines.push("");
  lines.push(tableRow(["mint rate (A15) ↓", "bumps/day (per op)", "bumps/sec (per op)", "at 100 ops (bumps/sec)"]));
  lines.push(tableRow(["---", "---", "---", "---"]));
  for (const b of A15_BUMPS_PER_OP_PER_DAY_RANGE) {
    const perSec = b / 86400;
    const at100 = perSec * 100;
    lines.push(tableRow([`${b}`, fmt(b, 0), fmt(perSec, 4), fmt(at100, 3)]));
  }
  lines.push("");
  lines.push("Note: bumps and claims both consume proof capacity from the same fleet. Table B.3 shows claim-only fleet sizing; the operator ought to add A15's demand to the same fleet when sizing. Bumps are O(1) per event (one divmod + one set insert + one accumulator write), so per-proof cost is comparable to claims.");
  return lines.join("\n");
}

// ─── PART C TABLES ────────────────────────────────────────────────────

function tableOnChainTxs() {
  const lines = [];
  lines.push("**Table C.1 — On-chain tx count for one county rollout (A16 adults), Merkle-cohort model vs naive one-registration-per-person.**");
  lines.push("Assumptions: A16, A17, A19, A20. Cohort model: txs = ceil(A16 / cohortSize) × A20-root-txs + A16 × claim-uptake. Naive model: txs = A16 (registrations) + A16 × claim-uptake.");
  lines.push("");
  const cols = [];
  const colSpec = [];
  for (const size of A17_COHORT_SIZES) {
    for (const rootTx of A20_ROOT_TX_PER_COHORT_RANGE) {
      cols.push(`cohort ${fmtInt(size)}·rootTx=${rootTx}`);
      colSpec.push({ size, rootTx });
    }
  }
  lines.push(tableRow(["uptake ↓ / (cohort size, root txs) →", "NAIVE", ...cols]));
  lines.push(tableRow(["---", "---", ...cols.map(() => "---")]));
  for (const uptake of A19_CLAIM_UPTAKE_RATES) {
    const claims = A16_COUNTY_ADULT_POPULATION * uptake;
    const naive = A16_COUNTY_ADULT_POPULATION + claims;
    const row = [`${(uptake*100).toFixed(0)}%`, fmt(naive, 2)];
    for (const { size, rootTx } of colSpec) {
      const cohorts = Math.ceil(A16_COUNTY_ADULT_POPULATION / size);
      const cohortTotal = cohorts * rootTx + claims;
      row.push(fmt(cohortTotal, 2));
    }
    lines.push(tableRow(row));
  }
  return lines.join("\n");
}

function tableDustBudget() {
  const lines = [];
  lines.push("**Table C.2 — DUST budget (total DUST) per county rollout under Merkle-cohort model.**");
  lines.push("Assumptions: A16, A17, A18, A19, A20. Uses mid cohort size (A17[1]) and mid rootTx (A20[1]) as anchor; DUST/tx SENSITIVITY across A18 range.");
  lines.push(`Anchor: cohort size = ${fmtInt(A17_COHORT_SIZES[1])}, rootTx per cohort = ${A20_ROOT_TX_PER_COHORT_RANGE[1]}. County adults = ${fmtInt(A16_COUNTY_ADULT_POPULATION)}.`);
  lines.push("");
  const cohortSize = A17_COHORT_SIZES[1];
  const rootTx = A20_ROOT_TX_PER_COHORT_RANGE[1];
  const cohorts = Math.ceil(A16_COUNTY_ADULT_POPULATION / cohortSize);
  lines.push(tableRow(["uptake ↓ / DUST/tx (A18) →", ...A18_DUST_PER_TX_RANGE.map(d => `${d} DUST/tx`)]));
  lines.push(tableRow(["---", ...A18_DUST_PER_TX_RANGE.map(() => "---")]));
  for (const uptake of A19_CLAIM_UPTAKE_RATES) {
    const claims = A16_COUNTY_ADULT_POPULATION * uptake;
    const txs = cohorts * rootTx + claims;
    const row = [`${(uptake*100).toFixed(0)}%`];
    for (const dustPerTx of A18_DUST_PER_TX_RANGE) {
      row.push(fmt(txs * dustPerTx, 2) + " DUST");
    }
    lines.push(tableRow(row));
  }
  lines.push("");
  lines.push("Note: at low uptake the cost is dominated by the cohort roots (fixed regardless of who claims); at high uptake the cost tracks claim count linearly. The unclaimed population is *free* — the Merkle-cohort model's dominant win over the naive registration-per-person model, and the one that pays off exactly when the roll is largest.");
  return lines.join("\n");
}

function tableCohortSensitivity() {
  const lines = [];
  lines.push("**Table C.3 — DUST-cost sensitivity to COHORT SIZE at fixed uptake (30%, A19[1]).**");
  lines.push("Assumptions: A16, A17, A18, A19, A20. Uses mid DUST/tx (A18[1]) and mid rootTx (A20[1]).");
  lines.push(`Uptake fixed at ${(A19_CLAIM_UPTAKE_RATES[1]*100).toFixed(0)}%. DUST/tx = ${A18_DUST_PER_TX_RANGE[1]}. rootTx per cohort = ${A20_ROOT_TX_PER_COHORT_RANGE[1]}.`);
  lines.push("");
  const uptake = A19_CLAIM_UPTAKE_RATES[1];
  const dustPerTx = A18_DUST_PER_TX_RANGE[1];
  const rootTx = A20_ROOT_TX_PER_COHORT_RANGE[1];
  lines.push(tableRow(["cohort size", "# cohorts (county)", "root txs", "claim txs (30% uptake)", "total txs", "total DUST"]));
  lines.push(tableRow(["---", "---", "---", "---", "---", "---"]));
  for (const size of A17_COHORT_SIZES) {
    const cohorts = Math.ceil(A16_COUNTY_ADULT_POPULATION / size);
    const rootTxs = cohorts * rootTx;
    const claims = A16_COUNTY_ADULT_POPULATION * uptake;
    const total = rootTxs + claims;
    lines.push(tableRow([
      fmtInt(size),
      fmt(cohorts, 0),
      fmt(rootTxs, 0),
      fmt(claims, 0),
      fmt(total, 2),
      fmt(total * dustPerTx, 2) + " DUST",
    ]));
  }
  lines.push("");
  lines.push("Note: cohort size has bounded effect on total DUST because root cost is small vs claim cost at any nontrivial uptake. Optimize cohort size for *registrar operational fit* (how large a batch can one delegate reasonably verify + countersign), not DUST budget.");
  return lines.join("\n");
}

// ─── DRIVER ───────────────────────────────────────────────────────────

const assumptionsList = [
  { tag: "A1",  name: "Pilot-scale mint anchor per operator per month (kWh EBT)", value: A1_PILOT_MINT_EBT_PER_OP_PER_MONTH.toLocaleString("en-US"), just: "Modeling anchor only; a round number for legibility. NOT a pilot financial figure. Rescale by inspection." },
  { tag: "A2",  name: "LD slice fraction of mint routed to dividend pool", value: A2_LD_SLICE_FRACTION, just: "DESIGN.md §9 starting value (100% of solar-dividend slice = 1.86%). Governance-tunable later." },
  { tag: "A3",  name: "Operator counts modeled", value: A3_OPERATOR_COUNTS.join(", "), just: "WI-19 brief grid." },
  { tag: "A4",  name: "Members per operator modeled", value: A4_MEMBERS_PER_OP.join(", "), just: "WI-19 brief grid, spanning village-scale to county-scale rolls." },
  { tag: "A5",  name: "Mint-rate ratios modeled", value: A5_MINT_RATIOS.map(r => r.label).join("; "), just: "WI-19 brief grid: symmetric, moderate asymmetry, extreme asymmetry." },
  { tag: "A5c", name: "Heavy-operator count within each asymmetric scenario", value: A5c_HEAVY_COUNT, just: "Sharpest lens on the race dynamic: a single dominant operator against N–1 lights. Symmetric case degenerates cleanly." },
  { tag: "A6",  name: "Light-operator member count in registration-race view", value: A6_LIGHT_OP_MEMBERS.toLocaleString("en-US"), just: "Fixes light ops at aggressive registration to isolate the race; heavy-op member count varies across the grid rows." },
  { tag: "A8",  name: "National adult population", value: A8_NATIONAL_ADULT_POPULATION.toLocaleString("en-US"), just: "Kenya-scale anchor per NATIONAL-ONBOARDING-PROTOCOL §2/§3. Modeling assumption; rescale by inspection." },
  { tag: "A9",  name: "National adoption levels modeled", value: A9_ADOPTION_LEVELS.map(p => (p*100).toFixed(0)+"%").join(", "), just: "WI-19 brief: 1% / 5% / 20% of adult population." },
  { tag: "A10", name: "Claim-cadence scenarios", value: A10_CADENCES.map(c => `${c.label} (${c.claimsPerYearPerMember.toFixed(2)}/yr/member)`).join("; "), just: "WI-19 brief: monthly, quarterly, on-demand-with-30%-MAU." },
  { tag: "A11", name: "Epoch length (days)", value: A11_EPOCH_DAYS, just: "Monthly accounting window matching in-app accrual visibility. Not on-chain constant; a framing choice." },
  { tag: "A12", name: "Proof-generation time per proof, sensitivity range (seconds)", value: A12_PROOF_SECONDS_RANGE.join(", "), just: "WI-19 brief: 2–30s. Spans fast-GPU-relay to slow-CPU-relay; presented as a range, never a point estimate." },
  { tag: "A13", name: "Relay proof-worker utilization (0–1)", value: A13_RELAY_UTILIZATION, just: "Reserves capacity for reorgs, retries, indexer catchup, and burst absorption." },
  { tag: "A14", name: "Proof workers per relay host", value: A14_RELAY_PARALLELISM, just: "Modest per-host parallelism; a single well-provisioned box can run more." },
  { tag: "A15", name: "Bump throughput per operator per day, sensitivity range", value: A15_BUMPS_PER_OP_PER_DAY_RANGE.join(", "), just: "One bumpOnMint per settled DividendMinted event. Range spans pilot to national settlement rate." },
  { tag: "A16", name: "County adult population target", value: A16_COUNTY_ADULT_POPULATION.toLocaleString("en-US"), just: "Mid-size Kenyan-county anchor for per-county DUST modeling." },
  { tag: "A17", name: "Cohort sizes modeled (members per Merkle root)", value: A17_COHORT_SIZES.join(", "), just: "Small (village registrar), medium (agent-network cohort), large (single-county batch)." },
  { tag: "A18", name: "DUST-per-tx sensitivity range", value: A18_DUST_PER_TX_RANGE.join(", "), just: "Modeling units — DUST market pricing is a separate assumption we do not embed. Sensitivity shown across a plausible band." },
  { tag: "A19", name: "Claim-uptake rates modeled", value: A19_CLAIM_UPTAKE_RATES.map(u => (u*100).toFixed(0)+"%").join(", "), just: "Fraction of registered adults who ever call claim within the modeling window. Sensitivity band." },
  { tag: "A20", name: "Root txs per cohort, sensitivity range", value: A20_ROOT_TX_PER_COHORT_RANGE.join(", "), just: "1 = pure post; 2–3 = post + countersign + finalize under challenge-window design." },
];

function renderAssumptions(filterTags = null) {
  const rows = filterTags
    ? assumptionsList.filter(a => filterTags.includes(a.tag))
    : assumptionsList;
  const lines = [];
  lines.push(tableRow(["Tag", "Assumption", "Value", "Justification"]));
  lines.push(tableRow(["---", "---", "---", "---"]));
  for (const a of rows) {
    lines.push(tableRow([a.tag, a.name, String(a.value), a.just]));
  }
  return lines.join("\n");
}

function partA() {
  const out = [];
  out.push("### PART A — Cross-operator Living Dividend dilution scenarios (B-4)");
  out.push("");
  out.push("#### Assumptions (Part A)");
  out.push("");
  out.push(renderAssumptions(["A1","A2","A3","A4","A5","A5c","A6"]));
  out.push("");
  out.push("#### Accumulator semantics (from `living-dividend-v2.2.1.compact`)");
  out.push("");
  out.push("The contract computes `delta = amount * SCALE / totalLivingMembers` in `bumpOnMint` and adds `delta` to a global `_accPerShare`. Every *living* member accrues the same share per bump, regardless of which operator's mint triggered the bump. On `claim`, `owed = (accPerShare - checkpoint) / SCALE`. Pruned members' unclaimed accruals implicitly revert to the pool (checkpoint discarded, per-member share of remaining members grows on the next bump). This is the semantic the tables below encode.");
  out.push("");
  out.push("These tables express dividends as **kWh of EBT per member per month**. All figures scale linearly with A1 — halve A1 and every kWh number halves.");
  out.push("");
  out.push("#### Table A.1 — Symmetric baseline");
  out.push("");
  out.push(tableSymmetricPerMember());
  out.push("");
  out.push("#### Table A.2 — Asymmetric mint, uniform member counts");
  out.push("");
  out.push(tableAsymmetricUniformMembers("national"));
  out.push("");
  out.push(tableAsymmetricUniformMembers("federated"));
  out.push("");
  out.push("Reading A.2: under **national** posture, heavy and light per-member dividends are equal at every grid point (one pool, equal accrual). Under **federated** posture, the heavy operator's members receive a dividend proportional to the heavy mint rate; the light operators' members receive the baseline. The gap between postures widens with the mint ratio.");
  out.push("");
  out.push("#### Table A.3 — The registration race, visible");
  out.push("");
  out.push(tableRegistrationRaceNational());
  out.push("");
  out.push("#### Table A.4 — CAL-9 decision-ready comparison");
  out.push("");
  out.push(tableCAL9Comparison());
  out.push("");
  out.push("**CAL-9 inputs for Garrett's decision (not a recommendation):**");
  out.push("");
  out.push("- **National posture** delivers uniform per-member dividends across the entire roll — a solidarity property. It also creates the funding-share gradient visible in A.3: at ratio 100:1 the heavy op funds ~99% of the pool while collecting the same per-head share as light-op members. Whether that is *good* (network-level solidarity, a reason to onboard poorer counties fast) or *bad* (heavy operators subsidizing everyone else's members, an operator-agreement fault line) is a policy question, not a math question.");
  out.push("- **Federated posture** ties per-member dividend to per-operator mint. Heavy-op members collect a heavy dividend; light-op members collect a light one. The funding-share gradient goes away because each operator only funds its own members. But the flagship promise (\"a consumer's EBT spends identically anywhere\") is preserved on the *token* side; the dividend *rate* diverges regionally. Under 100:1 asymmetry, heavy-op members collect ~100× light-op members at the same member count — that is a highly visible regional inequality.");
  out.push("- **Hybrid postures exist** (federated per-cluster pools under a constitutional floor) but are not modeled here — the two endpoints bound the design space.");
  out.push("- **Registration-race dynamic**: only present under national posture. Federated pools structurally eliminate the race but at the cost of the solidarity property.");
  out.push("- **Sensitivity to A1**: none — the *ratios* between grid cells are invariant to A1; only absolute kWh values scale. The decision structure Garrett faces is stable across mint-anchor choices.");
  out.push("- **Sensitivity to A2**: same — LD slice fraction only scales the absolute kWh values.");
  out.push("- **Not modeled**: intra-national clearinghouse settlement effects (A-1), inter-operator credit risk (A-2). Those live in WI-01 and WI-02 and do not change the accumulator arithmetic.");
  out.push("");
  return out.join("\n");
}

function partB() {
  const out = [];
  out.push("### PART B — National-scale claim and proof throughput");
  out.push("");
  out.push("#### Assumptions (Part B)");
  out.push("");
  out.push(renderAssumptions(["A8","A9","A10","A11","A12","A13","A14","A15"]));
  out.push("");
  out.push("#### Cost surface (from the contract)");
  out.push("");
  out.push("- Each `claim` call is O(1): one signature witness verify, one divmod, one map lookup on `_members`, one map insert to `_pendingClaims`, one map insert to `_claimLog`. All independent per member — trivially parallel at the proof tier.");
  out.push("- Each `bumpOnMint` call is O(1): one divmod, one accumulator write, one set insert (salt). Also trivially parallel.");
  out.push("- Both share the same relay proof capacity. Table B.3 models claim demand; Table B.4 shows bump demand on the same fleet.");
  out.push("");
  out.push("#### Table B.1 — Claims per epoch");
  out.push("");
  out.push(tableClaimsPerEpoch());
  out.push("");
  out.push("#### Table B.2 — Sustained claim rate driving the proof fleet");
  out.push("");
  out.push(tableClaimsPerSecond());
  out.push("");
  out.push("#### Table B.3 — Required relay fleet size (SENSITIVITY across proof time)");
  out.push("");
  out.push(tableRelayFleetSize());
  out.push("");
  out.push("#### Table B.4 — bumpOnMint load at the relay tier");
  out.push("");
  out.push(tableBumpLoad());
  out.push("");
  return out.join("\n");
}

function partC() {
  const out = [];
  out.push("### PART C — DUST budget for county-scale Merkle-cohort rollout");
  out.push("");
  out.push("#### Assumptions (Part C)");
  out.push("");
  out.push(renderAssumptions(["A16","A17","A18","A19","A20"]));
  out.push("");
  out.push("#### Model");
  out.push("");
  out.push("Under the Merkle-cohort model (NATIONAL-ONBOARDING-PROTOCOL §2 Phase 3), a delegated registrar submits one Merkle root per cohort; individual members are proven into the roll only when they first claim. The on-chain cost is therefore:");
  out.push("");
  out.push("```");
  out.push("on-chain txs = ceil(county-adults / cohort-size) × rootTx-per-cohort");
  out.push("             + county-adults × claim-uptake-rate");
  out.push("```");
  out.push("");
  out.push("The naive alternative — one `register()` tx per adult — costs `county-adults + county-adults × claim-uptake`, a strict superset. Members who never claim are FREE under the cohort model; they cost one full registration under the naive model.");
  out.push("");
  out.push("#### Table C.1 — On-chain tx count, cohort vs naive");
  out.push("");
  out.push(tableOnChainTxs());
  out.push("");
  out.push("#### Table C.2 — DUST budget, uptake × DUST/tx sensitivity");
  out.push("");
  out.push(tableDustBudget());
  out.push("");
  out.push("#### Table C.3 — DUST sensitivity to cohort size");
  out.push("");
  out.push(tableCohortSensitivity());
  out.push("");
  return out.join("\n");
}

const arg = process.argv[2];
if (arg === "partA") {
  console.log(partA());
} else if (arg === "partB") {
  console.log(partB());
} else if (arg === "partC") {
  console.log(partC());
} else if (arg === "assumptions") {
  console.log(renderAssumptions());
} else {
  console.log(partA());
  console.log("");
  console.log(partB());
  console.log("");
  console.log(partC());
}
