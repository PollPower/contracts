#!/usr/bin/env node
// docs-services/eligibility-snapshot/index.mjs
//
// WI-18: Eligibility Snapshot Service — REFERENCE IMPLEMENTATION.
//
// Read-only aggregator that turns MOCK upstream state (from fixtures/) into
// a single canonical eligibility snapshot per multisig/SORTITION-TABLE-DESIGN
// §4 gate + §5.1 (WI-08 / PR #17) B-2 mitigation.
//
// STATUS: dev scaffold. Runs against fixture data only. See SPEC.md for the
// interface this service commits to; production is blocked on point-in-time
// reads from pollpower-v2-api + settlement-api (SPEC.md §7 open items).
//
// USAGE:
//   node index.mjs                                    # runs against ./fixtures/snapshot-input.json
//   node index.mjs path/to/snapshot-input.json        # explicit input path
//   node index.mjs --self-test                        # run built-in acceptance checks

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION CONSTANTS — every value here is Garrett's call per the
// FEDERATION-IMPLEMENTATION-PLAN §3 calibration register (CAL-3 and §5.1).
// This service NEVER picks these; they are typed as sentinel `TODO(...)`
// objects and threshold checks against a null value return `false` with
// a `todo` reason so downstream can see the gate is UNCALIBRATED.
//
// The self-test uses a LOCAL fixture-only calibration set (SELF_TEST_CAL
// further down) — those numbers are illustrative and MUST NOT be treated
// as anything but "values sufficient to exercise the fixture cases".
// ─────────────────────────────────────────────────────────────────────────────

const CAL_TODO = Object.freeze({
  // ── CAL-3: §4 gate conditions ──
  X_minDistinctSessions:       { value: null, todo: "CAL-3 (X distinct settlement sessions)" },
  Y_ldMaturityDays:            { value: null, todo: "CAL-3 (Y days LD maturity)" },
  minAccPerShareDelta:         { value: null, todo: "CAL-3 (§4: non-trivial accPerShare delta)" },

  // ── §5.1 (WI-08 / PR #17) B-2 mitigation ──
  S_cap:                       { value: null, todo: "§5.1 (per-operator session cap; must be < X)" },
  windowDays:                  { value: null, todo: "§5.1 (trailing-window over which sessions must accumulate)" },
  minCrossOperatorCount:       { value: null, todo: "§5.1 (min distinct operators across a member's gate-countable sessions)" },

  // ── §6 cooldown ──
  personalCooldownEpochs:      { value: null, todo: "§6 (last-epoch cooldown, per-tier)" },
  federationSeatCooldown:      false, // §6: federation seats exempt by default
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC constants (fixed, not calibration)
// ─────────────────────────────────────────────────────────────────────────────

const SPEC_VERSION = "pp:eligibility-snapshot:v1";
const OUTPUT_ROW_WEIGHT = 1; // §4 recommendation: equal-weight per eligible row
const SECONDS_PER_DAY = 86400;

// ─────────────────────────────────────────────────────────────────────────────
// Gate evaluation — pure function of MemberRecord + config.
// Returns { pass: boolean, reasons: string[] }.
// Every threshold read from `cal` is checked for `null` → produces a
// "TODO(calibration)" reason and DOES NOT pass.
// ─────────────────────────────────────────────────────────────────────────────

function evaluateGate(member, cal, config, t0Unix) {
  const reasons = [];

  // Federation-seat rows bypass the personal gate per SORTITION-TABLE-DESIGN
  // §6 (exempt from personal cooldown; not natural persons — sessions and
  // LD-maturity are not the right predicate). They still need to be "live"
  // in the sense of being an active lower-tier council.
  if (member.isFederationSeat) {
    if (!member.isLive) {
      reasons.push("federationSeat.notLive");
    }
    return { pass: reasons.length === 0, reasons };
  }

  // ── §4 condition 1: KYC (AND of off-chain + on-chain) ──
  if (!member.kycVerified) reasons.push("kyc.notVerified");

  // ── §4 condition 4: currently live ──
  if (!member.isLive) reasons.push("liveness.notLive");
  if (member.pruning?.hasPending) {
    // Pending prune does not itself flip the gate (grace window per LD §7),
    // but is surfaced so downstream policy can factor it in if needed.
    // For strict interpretation, uncomment the next line:
    // reasons.push("pruning.pending");
  }

  // ── §4 condition 3: ≥ Y days LD maturity + non-trivial accPerShare delta ──
  if (cal.Y_ldMaturityDays.value === null) {
    reasons.push(`maturity.tenureDays.uncalibrated:${cal.Y_ldMaturityDays.todo}`);
  } else {
    const tenureSeconds = t0Unix - member.ldRegisteredAt;
    const requiredSeconds = cal.Y_ldMaturityDays.value * SECONDS_PER_DAY;
    if (tenureSeconds < requiredSeconds) {
      reasons.push(`maturity.tenureDays<${cal.Y_ldMaturityDays.value}`);
    }
  }

  if (cal.minAccPerShareDelta.value === null) {
    reasons.push(`maturity.accPerShareDelta.uncalibrated:${cal.minAccPerShareDelta.todo}`);
  } else {
    const delta = BigInt(member.ldAccPerShareAtT0) - BigInt(member.ldAccPerShareCheckpoint);
    if (delta < BigInt(cal.minAccPerShareDelta.value)) {
      reasons.push("maturity.accPerShareDelta.trivial");
    }
  }

  // ── §4 condition 2: ≥ X distinct settlement sessions ──
  //     with §5.1 (per-operator cap, trailing-window, cross-operator count)
  const sessionsInWindow = filterSessionsToWindow(member.sessions, cal, t0Unix);
  const gateCountable = applyPerOperatorCap(sessionsInWindow, cal);

  if (cal.X_minDistinctSessions.value === null) {
    reasons.push(`sessions.distinctCount.uncalibrated:${cal.X_minDistinctSessions.todo}`);
  } else if (gateCountable.length < cal.X_minDistinctSessions.value) {
    reasons.push(`sessions.distinctCount<${cal.X_minDistinctSessions.value}`);
  }

  // §5.1 cross-operator requirement is only ACTIVE in multi-operator pool mode.
  // In single-operator pilots the constraint is INERT (per §5.1 rev-2 note).
  if (config.poolMode === "multi-operator") {
    if (cal.minCrossOperatorCount.value === null) {
      reasons.push(`sessions.crossOperatorCount.uncalibrated:${cal.minCrossOperatorCount.todo}`);
    } else {
      const opCount = new Set(gateCountable.map((s) => s.operatorId)).size;
      if (opCount < cal.minCrossOperatorCount.value) {
        reasons.push(`sessions.crossOperatorCount<${cal.minCrossOperatorCount.value}`);
      }
    }
  }

  // ── §6 cooldown ──
  if (member.servedInPreviousEpoch) {
    if (cal.personalCooldownEpochs.value === null) {
      reasons.push(`cooldown.uncalibrated:${cal.personalCooldownEpochs.todo}`);
    } else if (cal.personalCooldownEpochs.value >= 1) {
      // Simplification: with cooldownEpochs>=1 anyone who served last epoch
      // is ineligible now. Longer cooldowns would need served-in-any-of-last-N.
      reasons.push("cooldown.servedPreviousEpoch");
    }
  }

  return { pass: reasons.length === 0, reasons };
}

// §5.1 trailing-window: only sessions with timestampUnix >= t0 - windowDays
// count toward the gate. If windowDays is uncalibrated, we DO NOT drop any
// sessions here — the uncalibrated marker fires in evaluateGate() via the
// distinctCount reason chain; leaving sessions in place keeps the record
// full-fidelity for the auditor.
function filterSessionsToWindow(sessions, cal, t0Unix) {
  if (cal.windowDays.value === null) return [...sessions];
  const windowStart = t0Unix - cal.windowDays.value * SECONDS_PER_DAY;
  return sessions.filter((s) => s.timestampUnix >= windowStart);
}

// §5.1 per-operator cap: at most S_cap sessions per operator count toward
// the gate. If uncalibrated, cap is not applied (again, the uncalibrated
// marker fires via distinctCount).
function applyPerOperatorCap(sessions, cal) {
  if (cal.S_cap.value === null) return [...sessions];
  const perOperator = new Map();
  const kept = [];
  // Deterministic order: sort by (timestampUnix ASC, sessionId ASC) so which
  // sessions get "kept" under the cap is reproducible.
  const sorted = [...sessions].sort((a, b) => {
    if (a.timestampUnix !== b.timestampUnix) return a.timestampUnix - b.timestampUnix;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  for (const s of sorted) {
    const n = perOperator.get(s.operatorId) ?? 0;
    if (n < cal.S_cap.value) {
      kept.push(s);
      perOperator.set(s.operatorId, n + 1);
    }
  }
  return kept;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot builder — takes the mock upstream input and emits an artifact
// matching SPEC.md.
// ─────────────────────────────────────────────────────────────────────────────

function buildSnapshot(input, cal) {
  // Compute previousEpochOutgoing membership as a set for O(1) lookup
  const previousSeats = new Set(input.previousSeats ?? []);

  // §1.3 determinism: sort members by memberAddr bytes ascending (hex sort is
  // lex-equivalent for equal-length lowercase hex strings, which is what
  // Bytes<32> is when serialized as "0x…")
  const sortedInputMembers = [...input.members].sort((a, b) => {
    if (a.memberAddr < b.memberAddr) return -1;
    if (a.memberAddr > b.memberAddr) return 1;
    return 0;
  });

  const memberRecords = sortedInputMembers.map((raw) => {
    // Session order determinism: sort by (timestampUnix, sessionId) ascending
    const sortedSessions = [...(raw.sessions ?? [])].sort((a, b) => {
      if (a.timestampUnix !== b.timestampUnix) return a.timestampUnix - b.timestampUnix;
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    });

    const record = {
      memberAddr: raw.memberAddr,

      // ── §4 condition 1 ──
      kycVerified: !!(raw.kyc?.verifiedOffChain && raw.kyc?.onChainAttestationSeen),
      kycProviderTag: raw.kyc?.providerTag ?? "unknown",

      // ── §4 condition 2 + §5.1 attribution ──
      sessions: sortedSessions.map((s) => ({
        sessionId: s.sessionId,
        operatorId: s.operatorId,
        timestampUnix: s.timestampUnix,
        settlementApiRef: s.settlementApiRef,
      })),

      // ── §4 condition 3 ──
      ldRegisteredAt: raw.ld.registeredAt,
      ldAccPerShareCheckpoint: String(raw.ld.accPerShareAtCheckpoint),
      ldAccPerShareAtT0: String(input.globalLdState.accPerShareAtT0),

      // ── §4 condition 4 ──
      isLive: raw.ld.isLive,
      lastSeenUnix: raw.ld.lastSeen,
      pruning: {
        hasPending: !!raw.pruning?.hasPending,
        proposedAtUnix: raw.pruning?.proposedAtUnix ?? null,
      },

      // ── §6 cooldown input ──
      servedInPreviousEpoch: previousSeats.has(raw.memberAddr),

      // ── §1 row-shape hint ──
      isFederationSeat: !!raw.isFederationSeat,
    };

    // ── gate.pass / gate.reasons computed by this service ──
    record.gate = evaluateGate(
      record,
      cal,
      { poolMode: input.config?.poolMode ?? "multi-operator", globalLdState: input.globalLdState },
      input.t0Unix
    );

    return record;
  });

  // Build output.rows in the WI-15 build-table input format. WI-15 is
  // responsible for canonical sort by memberAddr per SORTITION-TABLE-DESIGN
  // §1.2 — we emit in the same order as members[] (which is already sorted
  // by memberAddr per §1.3 determinism), and WI-15 will re-check.
  const outputRows = memberRecords
    .filter((m) => m.gate.pass)
    .map((m) => ({
      memberAddr: m.memberAddr,
      weight: OUTPUT_ROW_WEIGHT,
      // Only emit isFederationSeat when true, per SPEC.md §1.1's "optional,
      // default false".
      ...(m.isFederationSeat ? { isFederationSeat: true } : {}),
    }));

  return {
    specVersion: SPEC_VERSION,
    epoch: input.epoch,
    tierId: input.tierId,
    t0: input.t0,
    t0Unix: input.t0Unix,
    sources: input.sources,
    config: {
      poolMode: input.config?.poolMode ?? "multi-operator",
      gateThresholds: {
        X_minDistinctSessions: cal.X_minDistinctSessions,
        Y_ldMaturityDays: cal.Y_ldMaturityDays,
        minAccPerShareDelta: cal.minAccPerShareDelta,
        S_cap: cal.S_cap,
        windowDays: cal.windowDays,
        minCrossOperatorCount: cal.minCrossOperatorCount,
      },
      cooldownEpochs: {
        personalCooldownEpochs: cal.personalCooldownEpochs,
        federationSeatCooldown: cal.federationSeatCooldown,
      },
    },
    members: memberRecords,
    output: {
      epoch: input.epoch,
      rows: outputRows,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test — exercises every fixture case with a LOCAL fixture-only
// calibration set. These numbers are illustrative only.
// ─────────────────────────────────────────────────────────────────────────────

const SELF_TEST_CAL = Object.freeze({
  // NOTE: THESE ARE NOT CAL-3 / §5.1 VALUES. They are fixture-exercise
  // numbers chosen only so the self-test can distinguish pass from fail.
  // Real values come from Garrett per FEDERATION-IMPLEMENTATION-PLAN §3.
  X_minDistinctSessions:       { value: 3, todo: null },
  Y_ldMaturityDays:            { value: 30, todo: null },
  minAccPerShareDelta:         { value: "100", todo: null },
  S_cap:                       { value: 2, todo: null },
  windowDays:                  { value: 60, todo: null },
  minCrossOperatorCount:       { value: 2, todo: null },
  personalCooldownEpochs:      { value: 1, todo: null },
  federationSeatCooldown:      false,
});

function selfTest() {
  const inputPath = join(__dirname, "fixtures", "snapshot-input.json");
  const input = JSON.parse(readFileSync(inputPath, "utf8"));

  const snap = buildSnapshot(input, SELF_TEST_CAL);

  // Expected per-fixture verdicts
  const expected = {
    "0x1111111111111111111111111111111111111111111111111111111111111111": { pass: true,  because: "clear pass" },
    "0x2222222222222222222222222222222222222222222222222222222222222222": { pass: false, because: "fail on sessions count" },
    "0x3333333333333333333333333333333333333333333333333333333333333333": { pass: false, because: "fail on maturity" },
    "0x4444444444444444444444444444444444444444444444444444444444444444": { pass: false, because: "not live" },
    "0x5555555555555555555555555555555555555555555555555555555555555555": { pass: false, because: "§5.1 cross-operator (all one operator)" },
    "0x6666666666666666666666666666666666666666666666666666666666666666": { pass: true,  because: "federation seat" },
  };

  let failed = 0;
  console.log("SELF-TEST — gate verdicts per fixture case");
  console.log("");
  for (const m of snap.members) {
    const exp = expected[m.memberAddr];
    if (!exp) {
      console.error(`  UNEXPECTED MEMBER ${m.memberAddr}`);
      failed++;
      continue;
    }
    const actual = m.gate.pass;
    const ok = actual === exp.pass;
    console.log(
      `  ${ok ? "OK  " : "FAIL"}  ${m.memberAddr.slice(0, 10)}…  ` +
        `expected pass=${exp.pass} (${exp.because})  ` +
        `actual pass=${actual}  reasons=${JSON.stringify(m.gate.reasons)}`
    );
    if (!ok) failed++;
  }

  console.log("");
  console.log("OUTPUT ROWS (WI-15 build-table input format):");
  console.log(JSON.stringify(snap.output, null, 2));

  // Acceptance check: the all-one-operator fixture MUST fail with reason
  // matching /crossOperatorCount/ under multi-operator pool mode (SPEC.md
  // acceptance criterion).
  const allOneOp = snap.members.find((m) => m.memberAddr.startsWith("0x555"));
  const cop = allOneOp?.gate?.reasons?.some((r) => r.includes("crossOperatorCount")) ?? false;
  if (!cop) {
    console.error("");
    console.error("ACCEPTANCE FAIL: all-one-operator fixture did not fail on crossOperatorCount");
    failed++;
  }

  // Acceptance check: output.epoch == top-level epoch
  if (snap.output.epoch !== snap.epoch) {
    console.error("ACCEPTANCE FAIL: output.epoch != snap.epoch");
    failed++;
  }

  // Acceptance check: every output row has the WI-15 shape
  for (const row of snap.output.rows) {
    if (typeof row.memberAddr !== "string" || row.weight !== 1) {
      console.error(`ACCEPTANCE FAIL: bad output row shape: ${JSON.stringify(row)}`);
      failed++;
    }
  }

  console.log("");
  if (failed > 0) {
    console.error(`SELF-TEST FAILED (${failed} check(s))`);
    process.exit(1);
  } else {
    console.log("SELF-TEST OK");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    selfTest();
    return;
  }

  const inputPath = args[0]
    ? resolve(args[0])
    : join(__dirname, "fixtures", "snapshot-input.json");

  const input = JSON.parse(readFileSync(inputPath, "utf8"));

  // Production run uses CAL_TODO — will produce members with uncalibrated
  // reasons rather than silently picking values. That's the point.
  const snap = buildSnapshot(input, CAL_TODO);

  process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
}

// Only run if invoked directly
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("index.mjs")) {
  main();
}

export { buildSnapshot, evaluateGate, CAL_TODO, SPEC_VERSION };
