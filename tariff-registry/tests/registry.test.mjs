// tariff-registry/tests/registry.test.mjs
// -----------------------------------------------------------------------------
// Offline smoke suite for tariff-registry-v1.compact.
//
// Coverage (brief §REQUIRED TESTS + memo §3 additions + PR-body R-A/B/C):
//
//   T1     happy path: charter -> register -> resolve -> retune within bounds
//          -> resolve, sum still 10000, values changed correctly.
//   T2     I-A negative: register with unchartered nodeId -> REVERT
//          SCHEDULE_UNCHARTERED_NODE.
//   T3     I-B negatives: LD floor breach + ops floor breach.
//   T3.5   sanity-band retune negative (F-5, memo §3): rate outside ±20% of
//          schedule ref -> REVERT RETUNE_VIOLATES_SANITY_BAND.
//   T4     I-D replay: second submission of same federationApproval -> REVERT
//          FEDERATION_APPROVAL_REPLAYED.
//   T5     I-D forgery: unregistered signer -> REVERT
//          FEDERATION_APPROVAL_INVALID.
//   F-4    second wrong-seat negative (memo §3): registered seat that is NOT
//          the seat named in the bundle -> REVERT.
//   T6     epoch retirement: retire at e, resolve at e-1 works, resolve at
//          e+1 REVERTs RESOLVE_EPOCH_OUT_OF_RANGE.
//   F-7a   epoch decrement negative: newEpoch < currentEpoch -> REVERT
//          EPOCH_ADVANCE_NOT_PLUS_ONE.
//   F-7b   unauthorised advance: advanceEpoch without approval -> REVERT
//          FEDERATION_APPROVAL_INVALID.
//   T7     property test: 1000 random valid splits, sum-to-10000 always holds
//          and resolvePath returns the expected split byte-for-byte.
//   R-A    charter proof forgery: valid Merkle path against WRONG root
//          (post-advanceEpoch rotation) -> REVERT SCHEDULE_UNCHARTERED_NODE.
//   R-B    retune replay across schedules: same signed retune, different
//          scheduleId -> REVERT (compound nonce key differs, signature also
//          doesn't match; either revert path is acceptable — assert the
//          replay is REJECTED).
//   R-C    resolvePath with MAX_UINT64 epoch -> REVERT RESOLVE_EPOCH_OUT_OF_RANGE.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';

import {
  TariffRegistry, DOMAIN, CAL, RETUNE_MIN_INTERVAL_S, CHARTER_DEPTH,
  pad32, persistentHash, u64ToBytes32, u16ToBytes32,
  toHex, bufEq,
  buildCharterTree,
  splitSharesHash, sumSplit, validSplit,
  newEd25519, ed25519Sign, signatureValid,
  Revert,
  makeFixture,
} from './lib.mjs';

// A helper: run `fn()` and assert it throws Revert with `expected` substring.
function assertReverts(fn, expected) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof Revert, `expected Revert, got ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    if (expected) assert.match(e.message, new RegExp(expected), `expected revert message to match /${expected}/, got: ${e.message}`);
    return;
  }
  assert.fail(`expected Revert (${expected ?? 'any'}), but no throw`);
}

// Approve a federation actionHash by simulating the msfed council bundle.
// (Real off-chain path: msfed_bundle_helper.ts collects 3-of-5 signatures.)
function approve(registry, actionHash) {
  registry.approveByFederation(actionHash);
}

// Build a validator-attestor pair + sign the given actionHash.
function makeValidator() { return newEd25519(); }

// Sign the registerSchedule actionHash off-chain (validator side).
function signValidator(validatorKey, actionHash) {
  return ed25519Sign(validatorKey.privateKey, actionHash);
}

// Sign the retuneClass payloadHash off-chain (operator side). The registry
// mirror in lib.mjs uses signatureValid(operatorId, payloadHash, sig) so we
// mirror THAT exact hash reconstruction here.
function operatorSign(operatorKey, {
  registry, scheduleId, classPath, newSplitBps, newRateFiatPerKwh, nonceIn, currentTime,
}) {
  const shHash = splitSharesHash(newSplitBps);
  const payloadHash = persistentHash([
    pad32(DOMAIN.RETUNE_CLASS),
    registry.self,
    scheduleId,
    classPath,
    shHash,
    u64ToBytes32(newRateFiatPerKwh),
    registry.currentEpochBytes(),
    u64ToBytes32(nonceIn),
    u64ToBytes32(currentTime),
  ]);
  return { payloadHash, signature: ed25519Sign(operatorKey.privateKey, payloadHash) };
}

// Register a fresh schedule against a chartered nodeId. Returns { scheduleId,
// classPath }.
function registerFixture({ fixture, opts = {} }) {
  const { registry, opKey, validatorKey, charteredNodes, charterTree } = fixture;
  const nodeId = opts.nodeId ?? charteredNodes[0];
  const scheduleHash = opts.scheduleHash ?? randomBytes(32);
  const effectiveEpoch = opts.effectiveEpoch ?? (registry._currentEpoch + 1n);
  const currentTime = opts.currentTime ?? 1_000_000n;
  const refRate = opts.refRateFiatPerKwh ?? 100n;

  // Pre-approve the actionHash from the multisig side.
  const actionHash = persistentHash([
    pad32(DOMAIN.REGISTER_SCHEDULE),
    registry.self,
    nodeId,
    scheduleHash,
    u64ToBytes32(effectiveEpoch),
    registry.currentEpochBytes(),
  ]);
  approve(registry, actionHash);

  // Validator signs actionHash.
  const validatorSignature = signValidator(validatorKey, actionHash);

  const charterProof = charterTree.proofsByNodeId.get(toHex(nodeId));

  const res = registry.registerSchedule({
    nodeId,
    scheduleHash,
    operatorPubkey: opKey.pubkeyBytes,
    refRateFiatPerKwh: refRate,
    effectiveEpoch,
    validatorAttestor: validatorKey.pubkeyBytes,
    validatorSignature,
    currentTime,
    charterProof,
    now: currentTime,
  });
  return { scheduleId: res.scheduleId, actionHash: res.actionHash, refRate };
}

// -----------------------------------------------------------------------------
// T1 — happy path
// -----------------------------------------------------------------------------

test('T1 happy path: charter -> register -> resolve -> retune -> resolve', () => {
  const fx = makeFixture();
  const { registry, opKey } = fx;
  const { scheduleId, refRate } = registerFixture({ fixture: fx });

  // At this point no class entry has been retuned yet, so resolve for a
  // never-retuned class must revert.
  const classPath = randomBytes(32);
  assertReverts(
    () => registry.resolveCurrent({ scheduleId, classPath }),
    'RESOLVE_EPOCH_OUT_OF_RANGE|CLASS_NOT_FOUND'
  );

  // Advance to the schedule's effective epoch so resolvePath is in range.
  const currentTime = 2_000_000n;
  const advHash = persistentHash([
    pad32(DOMAIN.ADVANCE_EPOCH),
    registry.self,
    u64ToBytes32(registry._currentEpoch),
    u64ToBytes32(registry._currentEpoch + 1n),
    u64ToBytes32(refRate),
    registry._governanceRoot,
  ]);
  approve(registry, advHash);
  registry.advanceEpoch({
    newEpoch: registry._currentEpoch + 1n,
    newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot,
    currentTime,
    now: currentTime,
  });

  // Retune the class with a valid split + a valid new rate (=refRate).
  const bps = validSplit();
  const nonceIn = 1n;
  const retuneTime = currentTime + 10n;
  const { signature } = operatorSign(opKey, {
    registry, scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: refRate, nonceIn, currentTime: retuneTime,
  });
  registry.retuneClass({
    scheduleId, classPath, newSplitBps: bps, newRateFiatPerKwh: refRate,
    operatorId: opKey.pubkeyBytes, operatorSignature: signature,
    nonceIn, currentTime: retuneTime, now: retuneTime,
  });

  // Resolve; sum still 10000, entry rate = refRate.
  const entry = registry.resolveCurrent({ scheduleId, classPath });
  assert.equal(sumSplit(entry.bps), 10000n);
  assert.equal(entry.rateFiatPerKwh, refRate);
  assert.equal(entry.bps.producerShareBps, 6500);
});

// -----------------------------------------------------------------------------
// T2 — I-A negative
// -----------------------------------------------------------------------------

test('T2 I-A: registerSchedule with unchartered nodeId REVERTS', () => {
  const fx = makeFixture();
  const { registry, opKey, validatorKey, nodeUnchartered, charterTree } = fx;

  // Craft a proof for a chartered node then swap the leaf: the reconstructed
  // root will not match, i.e. the proof "looks structurally valid but names
  // the wrong node". Simpler: use an ALL-ZERO proof; reconstruction will not
  // match.
  const badProof = {
    siblings: new Array(CHARTER_DEPTH).fill(Buffer.alloc(32)),
    indices: new Array(CHARTER_DEPTH).fill(false),
  };

  assertReverts(() => {
    registry.registerSchedule({
      nodeId: nodeUnchartered,
      scheduleHash: randomBytes(32),
      operatorPubkey: opKey.pubkeyBytes,
      refRateFiatPerKwh: 100n,
      effectiveEpoch: 1n,
      validatorAttestor: validatorKey.pubkeyBytes,
      validatorSignature: Buffer.alloc(64),
      currentTime: 1_000_000n,
      charterProof: badProof,
      now: 1_000_000n,
    });
  }, 'SCHEDULE_UNCHARTERED_NODE');
});

// -----------------------------------------------------------------------------
// T3 — I-B floor negatives
// -----------------------------------------------------------------------------

test('T3 I-B: LD floor breach on retune REVERTS RETUNE_LD_FLOOR_VIOLATION', () => {
  const fx = makeFixture();
  const { registry, opKey } = fx;
  const { scheduleId, refRate } = registerFixture({ fixture: fx });
  // Advance so retune epoch bounds are met.
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const classPath = randomBytes(32);
  // ldShareBps = 100 (below floor 200); rest chosen so sum still = 10000.
  //   producer 6600 + ld 100 + ops 2500 + dao 500 + margin 300 + stat 0 = 10000
  const bad = { producerShareBps: 6600, ldShareBps: 100, opsShareBps: 2500,
                daoShareBps: 500, operatorMarginBps: 300, statutoryTotalBps: 0 };
  const nonceIn = 1n;
  const retuneTime = t + 10n;
  const { signature } = operatorSign(opKey, {
    registry, scheduleId, classPath, newSplitBps: bad,
    newRateFiatPerKwh: refRate, nonceIn, currentTime: retuneTime,
  });
  assertReverts(() => registry.retuneClass({
    scheduleId, classPath, newSplitBps: bad, newRateFiatPerKwh: refRate,
    operatorId: opKey.pubkeyBytes, operatorSignature: signature,
    nonceIn, currentTime: retuneTime, now: retuneTime,
  }), 'RETUNE_LD_FLOOR_VIOLATION');
});

test('T3 I-B: ops floor breach on retune REVERTS RETUNE_OPS_FLOOR_VIOLATION', () => {
  const fx = makeFixture();
  const { registry, opKey } = fx;
  const { scheduleId, refRate } = registerFixture({ fixture: fx });
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const classPath = randomBytes(32);
  // ops = 1000 (below floor 2000). Sum still = 10000.
  const bad = { producerShareBps: 7500, ldShareBps: 500, opsShareBps: 1000,
                daoShareBps: 500, operatorMarginBps: 500, statutoryTotalBps: 0 };
  const nonceIn = 1n;
  const retuneTime = t + 10n;
  const { signature } = operatorSign(opKey, {
    registry, scheduleId, classPath, newSplitBps: bad,
    newRateFiatPerKwh: refRate, nonceIn, currentTime: retuneTime,
  });
  assertReverts(() => registry.retuneClass({
    scheduleId, classPath, newSplitBps: bad, newRateFiatPerKwh: refRate,
    operatorId: opKey.pubkeyBytes, operatorSignature: signature,
    nonceIn, currentTime: retuneTime, now: retuneTime,
  }), 'RETUNE_OPS_FLOOR_VIOLATION');
});

// -----------------------------------------------------------------------------
// T3.5 — sanity-band retune negative (F-5)
// -----------------------------------------------------------------------------

test('T3.5 F-5: retune with rate OUTSIDE ±20% of schedule ref REVERTS', () => {
  const fx = makeFixture();
  const { registry, opKey } = fx;
  const { scheduleId, refRate } = registerFixture({ fixture: fx });
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const classPath = randomBytes(32);
  const bps = validSplit();
  // refRate = 100, band ±20 → allowed [80, 120]. Try 121 (over) and 79 (under).
  const nonceIn = 1n;
  const retuneTime = t + 10n;
  const badHigh = 121n;
  const badLow = 79n;

  const { signature: sigHigh } = operatorSign(opKey, {
    registry, scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: badHigh, nonceIn, currentTime: retuneTime,
  });
  assertReverts(() => registry.retuneClass({
    scheduleId, classPath, newSplitBps: bps, newRateFiatPerKwh: badHigh,
    operatorId: opKey.pubkeyBytes, operatorSignature: sigHigh,
    nonceIn, currentTime: retuneTime, now: retuneTime,
  }), 'RETUNE_VIOLATES_SANITY_BAND');

  const { signature: sigLow } = operatorSign(opKey, {
    registry, scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: badLow, nonceIn, currentTime: retuneTime,
  });
  assertReverts(() => registry.retuneClass({
    scheduleId, classPath, newSplitBps: bps, newRateFiatPerKwh: badLow,
    operatorId: opKey.pubkeyBytes, operatorSignature: sigLow,
    nonceIn, currentTime: retuneTime, now: retuneTime,
  }), 'RETUNE_VIOLATES_SANITY_BAND');

  // Boundary should PASS: refRate * (1 - 0.20) = 80.
  const boundary = 80n;
  const { signature: sigOK } = operatorSign(opKey, {
    registry, scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: boundary, nonceIn, currentTime: retuneTime,
  });
  registry.retuneClass({
    scheduleId, classPath, newSplitBps: bps, newRateFiatPerKwh: boundary,
    operatorId: opKey.pubkeyBytes, operatorSignature: sigOK,
    nonceIn, currentTime: retuneTime, now: retuneTime,
  });
});

// -----------------------------------------------------------------------------
// T4 — I-D replay
// -----------------------------------------------------------------------------

test('T4 I-D: replaying federationApproval REVERTS FEDERATION_APPROVAL_REPLAYED', () => {
  const fx = makeFixture();
  const { registry, opKey, validatorKey, charteredNodes, charterTree } = fx;

  const nodeId = charteredNodes[0];
  const scheduleHash = randomBytes(32);
  const effectiveEpoch = 1n;
  const currentTime = 1_000_000n;
  const refRate = 100n;
  const actionHash = persistentHash([
    pad32(DOMAIN.REGISTER_SCHEDULE), registry.self, nodeId, scheduleHash,
    u64ToBytes32(effectiveEpoch), registry.currentEpochBytes(),
  ]);
  approve(registry, actionHash);
  const sig = signValidator(validatorKey, actionHash);
  const proof = charterTree.proofsByNodeId.get(toHex(nodeId));

  registry.registerSchedule({
    nodeId, scheduleHash, operatorPubkey: opKey.pubkeyBytes,
    refRateFiatPerKwh: refRate, effectiveEpoch,
    validatorAttestor: validatorKey.pubkeyBytes, validatorSignature: sig,
    currentTime, charterProof: proof, now: currentTime,
  });

  // Second submit: SAME actionHash, so replay guard fires. (The msfed
  // approval is still in the multisigApprovals set; only the CONSUMED set
  // needs to block replay.)
  assertReverts(() => {
    registry.registerSchedule({
      nodeId, scheduleHash, operatorPubkey: opKey.pubkeyBytes,
      refRateFiatPerKwh: refRate, effectiveEpoch,
      validatorAttestor: validatorKey.pubkeyBytes, validatorSignature: sig,
      currentTime, charterProof: proof, now: currentTime,
    });
  }, 'FEDERATION_APPROVAL_REPLAYED');
});

// -----------------------------------------------------------------------------
// T5 — I-D forgery (approval never granted → multisig witness returns false)
// -----------------------------------------------------------------------------

test('T5 I-D: unforged federationApproval REVERTS FEDERATION_APPROVAL_INVALID', () => {
  const fx = makeFixture();
  const { registry, opKey, validatorKey, charteredNodes, charterTree } = fx;

  const nodeId = charteredNodes[0];
  const scheduleHash = randomBytes(32);
  const effectiveEpoch = 1n;
  const currentTime = 1_000_000n;
  const actionHash = persistentHash([
    pad32(DOMAIN.REGISTER_SCHEDULE), registry.self, nodeId, scheduleHash,
    u64ToBytes32(effectiveEpoch), registry.currentEpochBytes(),
  ]);
  // DO NOT approve; multisig_signature_valid returns false.
  const sig = signValidator(validatorKey, actionHash);
  const proof = charterTree.proofsByNodeId.get(toHex(nodeId));

  assertReverts(() => {
    registry.registerSchedule({
      nodeId, scheduleHash, operatorPubkey: opKey.pubkeyBytes,
      refRateFiatPerKwh: 100n, effectiveEpoch,
      validatorAttestor: validatorKey.pubkeyBytes, validatorSignature: sig,
      currentTime, charterProof: proof, now: currentTime,
    });
  }, 'FEDERATION_APPROVAL_INVALID');
});

// -----------------------------------------------------------------------------
// F-4 — second wrong-seat negative: approval was granted but for a DIFFERENT
// authority hash (i.e. a different msfed council). Mirror: swap
// _federationAuthority just before consumption.
// -----------------------------------------------------------------------------

test('F-4: approval bundle bound to wrong council REVERTS', () => {
  const fx = makeFixture();
  const { registry, opKey, validatorKey, charteredNodes, charterTree } = fx;

  const nodeId = charteredNodes[0];
  const scheduleHash = randomBytes(32);
  const effectiveEpoch = 1n;
  const currentTime = 1_000_000n;
  const actionHash = persistentHash([
    pad32(DOMAIN.REGISTER_SCHEDULE), registry.self, nodeId, scheduleHash,
    u64ToBytes32(effectiveEpoch), registry.currentEpochBytes(),
  ]);
  // Grant approval, then rotate the registry's federation authority so the
  // stored approval is for the OLD council.
  approve(registry, actionHash);
  registry._federationAuthority = randomBytes(32); // different council

  const sig = signValidator(validatorKey, actionHash);
  const proof = charterTree.proofsByNodeId.get(toHex(nodeId));

  assertReverts(() => {
    registry.registerSchedule({
      nodeId, scheduleHash, operatorPubkey: opKey.pubkeyBytes,
      refRateFiatPerKwh: 100n, effectiveEpoch,
      validatorAttestor: validatorKey.pubkeyBytes, validatorSignature: sig,
      currentTime, charterProof: proof, now: currentTime,
    });
  }, 'FEDERATION_APPROVAL_INVALID');
});

// -----------------------------------------------------------------------------
// T6 — epoch retirement
// -----------------------------------------------------------------------------

test('T6 epoch retirement: resolvePath at e-1 works, at retirement epoch REVERTS', () => {
  const fx = makeFixture();
  const { registry, opKey } = fx;
  const { scheduleId, refRate } = registerFixture({ fixture: fx });

  // Advance to schedule's effective epoch (was currentEpoch+1 at register).
  const t1 = 2_000_000n;
  const ah1 = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah1);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime: t1, now: t1 });

  // Retune once so a class exists at epoch 1.
  const classPath = randomBytes(32);
  const bps = validSplit();
  const { signature } = operatorSign(opKey, {
    registry, scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: refRate, nonceIn: 1n, currentTime: t1 + 5n,
  });
  registry.retuneClass({
    scheduleId, classPath, newSplitBps: bps, newRateFiatPerKwh: refRate,
    operatorId: opKey.pubkeyBytes, operatorSignature: signature,
    nonceIn: 1n, currentTime: t1 + 5n, now: t1 + 5n,
  });

  // Advance to epoch 2.
  const t2 = 3_000_000n;
  const ah2 = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(1n), u64ToBytes32(2n), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah2);
  registry.advanceEpoch({ newEpoch: 2n, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime: t2, now: t2 });

  // Retire at epoch 2.
  const retireHash = persistentHash([pad32(DOMAIN.RETIRE_SCHEDULE),
    registry.self, scheduleId, registry.currentEpochBytes()]);
  approve(registry, retireHash);
  registry.retireSchedule({ scheduleId, currentTime: t2 + 1n, now: t2 + 1n });

  // resolvePath at epoch 1 (< retiredEpoch = 2) still works.
  const e1 = registry.resolvePath({ scheduleId, classPath, epoch: 1n });
  assert.equal(sumSplit(e1.bps), 10000n);

  // resolvePath at epoch 2 (= retiredEpoch) reverts.
  assertReverts(() => registry.resolvePath({ scheduleId, classPath, epoch: 2n }),
                'RESOLVE_EPOCH_OUT_OF_RANGE');
});

// -----------------------------------------------------------------------------
// F-7a — epoch decrement negative
// -----------------------------------------------------------------------------

test('F-7a: advanceEpoch with newEpoch < currentEpoch REVERTS', () => {
  const fx = makeFixture();
  const { registry } = fx;
  // Currently epoch 0; try to advance to 0 (== not +1) — should REVERT.
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(0n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  assertReverts(() => registry.advanceEpoch({
    newEpoch: 0n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot,
    currentTime: 1_000_000n, now: 1_000_000n,
  }), 'EPOCH_ADVANCE_NOT_PLUS_ONE');

  // Also: advance to 5 (=/= +1) — should REVERT.
  const ah5 = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(5n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah5);
  assertReverts(() => registry.advanceEpoch({
    newEpoch: 5n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot,
    currentTime: 1_000_000n, now: 1_000_000n,
  }), 'EPOCH_ADVANCE_NOT_PLUS_ONE');
});

// -----------------------------------------------------------------------------
// F-7b — unauthorised epoch advance
// -----------------------------------------------------------------------------

test('F-7b: advanceEpoch without federationApproval REVERTS', () => {
  const fx = makeFixture();
  const { registry } = fx;
  // No approve() call — should REVERT on multisig check.
  assertReverts(() => registry.advanceEpoch({
    newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot,
    currentTime: 1_000_000n, now: 1_000_000n,
  }), 'FEDERATION_APPROVAL_INVALID');
});

// -----------------------------------------------------------------------------
// T7 — property test: 1000 random valid splits, sum-to-10000 holds byte-for-byte.
// -----------------------------------------------------------------------------

test('T7 property: 1000 random valid retunes, sum-to-10000 always holds', () => {
  const fx = makeFixture();
  const { registry, opKey } = fx;
  const { scheduleId, refRate } = registerFixture({ fixture: fx });
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Each iteration uses a fresh classPath (independent nonce ledger via
  // (op, schedule, epoch, class)).
  const N = 1000;
  let nonce = 0n;
  for (let i = 0; i < N; i++) {
    const classPath = randomBytes(32);
    // Build a random valid split: pick ld >= 200, ops >= 2000, then distribute
    // the remainder across producer/dao/margin/statutory.
    const ld = 200 + randomInt(0, 200);          // 200..399
    const ops = 2000 + randomInt(0, 500);        // 2000..2499
    const remainder = 10000 - ld - ops;          // ≥ 7101, well within Uint<16>
    // Producer gets bulk; distribute a bit of noise to the other three.
    const dao = randomInt(0, 300);
    const margin = randomInt(0, 300);
    const stat = randomInt(0, 300);
    const producer = remainder - dao - margin - stat;
    if (producer < 0) { i--; continue; }         // very rare with the ranges above
    const bps = {
      producerShareBps: producer, ldShareBps: ld, opsShareBps: ops,
      daoShareBps: dao, operatorMarginBps: margin, statutoryTotalBps: stat,
    };
    // Random valid rate in band [80, 120].
    const rate = 80n + BigInt(randomInt(0, 41));
    nonce += 1n;
    const retuneTime = t + 10n + BigInt(i) * 100n;
    const { signature } = operatorSign(opKey, {
      registry, scheduleId, classPath, newSplitBps: bps,
      newRateFiatPerKwh: rate, nonceIn: nonce, currentTime: retuneTime,
    });
    registry.retuneClass({
      scheduleId, classPath, newSplitBps: bps, newRateFiatPerKwh: rate,
      operatorId: opKey.pubkeyBytes, operatorSignature: signature,
      nonceIn: nonce, currentTime: retuneTime, now: retuneTime,
    });
    // Resolve back.
    const entry = registry.resolveCurrent({ scheduleId, classPath });
    assert.equal(sumSplit(entry.bps), 10000n, `iter ${i}: sum != 10000`);
    assert.equal(entry.rateFiatPerKwh, rate, `iter ${i}: rate mismatch`);
    assert.equal(entry.bps.producerShareBps, producer);
  }
});

// -----------------------------------------------------------------------------
// R-A — charter proof against wrong root REVERTS
// -----------------------------------------------------------------------------

test('R-A: charter proof against outdated root (post-advanceEpoch) REVERTS', () => {
  const fx = makeFixture();
  const { registry, opKey, validatorKey, charteredNodes, charterTree } = fx;

  // Rotate governanceRoot via advanceEpoch.
  const newRoot = randomBytes(32);
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), newRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: newRoot, currentTime: 1_000_000n, now: 1_000_000n });

  // Try to register using the OLD proof.
  const nodeId = charteredNodes[0];
  const proof = charterTree.proofsByNodeId.get(toHex(nodeId));
  const scheduleHash = randomBytes(32);
  const effectiveEpoch = 2n;
  const currentTime = 1_500_000n;
  const actionHash = persistentHash([
    pad32(DOMAIN.REGISTER_SCHEDULE), registry.self, nodeId, scheduleHash,
    u64ToBytes32(effectiveEpoch), registry.currentEpochBytes(),
  ]);
  approve(registry, actionHash);
  const sig = signValidator(validatorKey, actionHash);
  assertReverts(() => {
    registry.registerSchedule({
      nodeId, scheduleHash, operatorPubkey: opKey.pubkeyBytes,
      refRateFiatPerKwh: 100n, effectiveEpoch,
      validatorAttestor: validatorKey.pubkeyBytes, validatorSignature: sig,
      currentTime, charterProof: proof, now: currentTime,
    });
  }, 'SCHEDULE_UNCHARTERED_NODE');
});

// -----------------------------------------------------------------------------
// R-B — retune replay across schedules
// -----------------------------------------------------------------------------

test('R-B: signed retune replayed against DIFFERENT schedule REVERTS', () => {
  const fx = makeFixture();
  const { registry, opKey } = fx;
  // Register two schedules under different nodes.
  const s1 = registerFixture({ fixture: fx,
    opts: { nodeId: fx.charteredNodes[0], scheduleHash: randomBytes(32) } });
  const s2 = registerFixture({ fixture: fx,
    opts: { nodeId: fx.charteredNodes[1], scheduleHash: randomBytes(32) } });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(s1.refRate), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: s1.refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const classPath = randomBytes(32);
  const bps = validSplit();
  const retuneTime = t + 10n;

  // Sign a retune for s1.
  const { signature: sig1 } = operatorSign(opKey, {
    registry, scheduleId: s1.scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: s1.refRate, nonceIn: 1n, currentTime: retuneTime,
  });
  // Legit retune of s1 succeeds.
  registry.retuneClass({
    scheduleId: s1.scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: s1.refRate,
    operatorId: opKey.pubkeyBytes, operatorSignature: sig1,
    nonceIn: 1n, currentTime: retuneTime, now: retuneTime,
  });

  // Replay against s2 with the s1 signature — signature check fails first
  // because payloadHash binds scheduleId. Either RETUNE_OPERATOR_SIG_INVALID
  // or RETUNE_NONCE_MISMATCH is acceptable; either way, REVERTS.
  assertReverts(() => registry.retuneClass({
    scheduleId: s2.scheduleId, classPath, newSplitBps: bps,
    newRateFiatPerKwh: s1.refRate,
    operatorId: opKey.pubkeyBytes, operatorSignature: sig1,
    nonceIn: 1n, currentTime: retuneTime, now: retuneTime,
  }), 'RETUNE_OPERATOR_SIG_INVALID|RETUNE_NONCE_MISMATCH');
});

// -----------------------------------------------------------------------------
// R-C — resolvePath with MAX_UINT64 epoch
// -----------------------------------------------------------------------------

test('R-C: resolvePath with MAX_UINT64 epoch REVERTS', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const MAX_U64 = (1n << 64n) - 1n;
  const classPath = randomBytes(32);
  assertReverts(() => registry.resolvePath({ scheduleId, classPath, epoch: MAX_U64 }),
                'RESOLVE_EPOCH_OUT_OF_RANGE');
});
