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

// =============================================================================
// WI-13.1 Lane Tests (LANE-T1..T9 + LANE-R-A + LANE-R-E)
// =============================================================================

test('LANE-T1: happy path registerLane + resolve byte-for-byte', () => {
  const fx = makeFixture();
  const { registry, charteredNodes, charterTree } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  // Advance to effective epoch.
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Register a lane.
  const laneKindByte = 0;
  const leviedBy = randomBytes(32);
  const bpsShare = 500;
  const remitAddress = randomBytes(32);
  const basis = 0;
  const applicabilityHash = randomBytes(32);
  const statuteRefHash = randomBytes(32);
  const effectiveEpoch = 2n;
  const remittanceMode = 1;
  const currentTime = t + 100n;

  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(bpsShare), remitAddress,
    u64ToBytes32(basis), applicabilityHash, statuteRefHash,
    u64ToBytes32(effectiveEpoch), u64ToBytes32(remittanceMode),
    registry.currentEpochBytes(), u64ToBytes32(currentTime),
  ]);
  approve(registry, laneActionHash);

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare, remitAddress, basis,
    applicabilityHash, statuteRefHash, effectiveEpoch, remittanceMode,
    charterProof: proof, currentTime, now: currentTime,
  });

  // Resolve and verify byte-for-byte.
  const resolved = registry.resolveLane({ scheduleId, leviedBy, laneKindByte });
  assert.ok(bufEq(resolved.scheduleId, scheduleId));
  assert.equal(resolved.laneKindByte, laneKindByte);
  assert.ok(bufEq(resolved.leviedBy, leviedBy));
  assert.equal(resolved.bpsShare, bpsShare);
  assert.ok(bufEq(resolved.remitAddress, remitAddress));
  assert.equal(resolved.basis, basis);
  assert.ok(bufEq(resolved.applicabilityHash, applicabilityHash));
  assert.ok(bufEq(resolved.statuteRefHash, statuteRefHash));
  assert.equal(resolved.effectiveEpoch, effectiveEpoch);
  assert.equal(resolved.retiredEpoch, 0n);
  assert.equal(resolved.remittanceMode, remittanceMode);
  assert.equal(resolved.registeredAt, currentTime);
});

test('LANE-T2: registerLane with unchartered schedule REVERTS', () => {
  const fx = makeFixture();
  const { registry, nodeUnchartered, charterTree, charteredNodes } = fx;
  // Register a schedule under an unchartered node (should fail).
  // Actually, the charter check happens at registerSchedule, so we can't
  // register an unchartered schedule. Instead: register a valid schedule,
  // then try to register a lane with a BAD charter proof.
  const { scheduleId } = registerFixture({ fixture: fx });

  // Advance epoch.
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const badProof = {
    siblings: new Array(CHARTER_DEPTH).fill(Buffer.alloc(32)),
    indices: new Array(CHARTER_DEPTH).fill(false),
  };

  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(0), randomBytes(32), u16ToBytes32(500), randomBytes(32),
    u64ToBytes32(0), randomBytes(32), randomBytes(32),
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash);

  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte: 0, leviedBy: randomBytes(32), bpsShare: 500,
    remitAddress: randomBytes(32), basis: 0, applicabilityHash: randomBytes(32),
    statuteRefHash: randomBytes(32), effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: badProof, currentTime: t + 100n, now: t + 100n,
  }), 'SCHEDULE_UNCHARTERED_NODE');
});

test('LANE-T3: registerLane against retired schedule REVERTS', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  // Advance epoch.
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Retire the schedule.
  const retireHash = persistentHash([pad32(DOMAIN.RETIRE_SCHEDULE),
    registry.self, scheduleId, registry.currentEpochBytes()]);
  approve(registry, retireHash);
  registry.retireSchedule({ scheduleId, currentTime: t + 50n, now: t + 50n });

  // Try to register a lane.
  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(0), randomBytes(32), u16ToBytes32(500), randomBytes(32),
    u64ToBytes32(0), randomBytes(32), randomBytes(32),
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash);

  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte: 0, leviedBy: randomBytes(32), bpsShare: 500,
    remitAddress: randomBytes(32), basis: 0, applicabilityHash: randomBytes(32),
    statuteRefHash: randomBytes(32), effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  }), 'SCHEDULE_NOT_LIVE');
});

test('LANE-T4: registerLane with retroactive epoch REVERTS', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  // Advance to epoch 1.
  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Try to register a lane with effectiveEpoch = currentEpoch (not > currentEpoch).
  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const effectiveEpoch = 1n; // = currentEpoch, should fail
  const leviedBy = randomBytes(32);
  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(0), leviedBy, u16ToBytes32(500), randomBytes(32),
    u64ToBytes32(0), randomBytes(32), randomBytes(32),
    u64ToBytes32(effectiveEpoch), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash);

  // Assert it reverts (bare underflow, no specific error message).
  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte: 0, leviedBy, bpsShare: 500,
    remitAddress: randomBytes(32), basis: 0, applicabilityHash: randomBytes(32),
    statuteRefHash: randomBytes(32), effectiveEpoch, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  }));
});

test('LANE-T5: multi-authority same-kind lanes succeed at distinct keys', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Register first lane: (scheduleId, KRA-authority, kind=1).
  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const laneKindByte = 1;
  const leviedBy1 = Buffer.concat([Buffer.from('KRA'), Buffer.alloc(29)]); // KRA authority
  const remitAddress1 = randomBytes(32);
  const appHash1 = randomBytes(32);
  const statHash1 = randomBytes(32);
  const laneActionHash1 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy1, u16ToBytes32(500), remitAddress1,
    u64ToBytes32(0), appHash1, statHash1,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash1);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy: leviedBy1, bpsShare: 500,
    remitAddress: remitAddress1, basis: 0, applicabilityHash: appHash1,
    statuteRefHash: statHash1, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  });

  // Register second lane: (scheduleId, county-authority, kind=1) — same kind, different leviedBy.
  // This SHOULD succeed (HIGH-1 fix semantic).
  const leviedBy2 = Buffer.concat([Buffer.from('COUNTY'), Buffer.alloc(26)]); // County authority
  const remitAddress2 = randomBytes(32);
  const appHash2 = randomBytes(32);
  const statHash2 = randomBytes(32);
  const laneActionHash2 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy2, u16ToBytes32(600), remitAddress2,
    u64ToBytes32(0), appHash2, statHash2,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 200n),
  ]);
  approve(registry, laneActionHash2);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy: leviedBy2, bpsShare: 600,
    remitAddress: remitAddress2, basis: 0, applicabilityHash: appHash2,
    statuteRefHash: statHash2, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 200n, now: t + 200n,
  });

  // Assert both records exist independently at their respective keys.
  const resolved1 = registry.resolveLane({ scheduleId, leviedBy: leviedBy1, laneKindByte });
  assert.equal(resolved1.bpsShare, 500);
  assert.ok(bufEq(resolved1.leviedBy, leviedBy1));

  const resolved2 = registry.resolveLane({ scheduleId, leviedBy: leviedBy2, laneKindByte });
  assert.equal(resolved2.bpsShare, 600);
  assert.ok(bufEq(resolved2.leviedBy, leviedBy2));
});

test('LANE-T5b: exact-key duplicate registerLane REVERTS', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Register lane: (scheduleId, EPRA-authority, kind=1).
  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const laneKindByte = 1;
  const leviedBy = Buffer.concat([Buffer.from('EPRA'), Buffer.alloc(28)]);
  const remitAddress = randomBytes(32);
  const appHash = randomBytes(32);
  const statHash = randomBytes(32);
  const laneActionHash1 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(500), remitAddress,
    u64ToBytes32(0), appHash, statHash,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash1);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 500,
    remitAddress, basis: 0, applicabilityHash: appHash,
    statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  });

  // Try to register AGAIN with the EXACT same (scheduleId, leviedBy, laneKindByte).
  // Should fail with LANE_ALREADY_REGISTERED.
  const laneActionHash2 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(600), remitAddress,
    u64ToBytes32(0), appHash, statHash,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 200n),
  ]);
  approve(registry, laneActionHash2);
  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 600,
    remitAddress, basis: 0, applicabilityHash: appHash,
    statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 200n, now: t + 200n,
  }), 'LANE_ALREADY_REGISTERED');
});

test('LANE-T6: retireLane happy path + isLaneActive + resolveLane still works', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Register a lane.
  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const laneKindByte = 0;
  const leviedBy = randomBytes(32);
  const remitAddress = randomBytes(32);
  const appHash = randomBytes(32);
  const statHash = randomBytes(32);
  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(500), remitAddress,
    u64ToBytes32(0), appHash, statHash,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 500,
    remitAddress, basis: 0, applicabilityHash: appHash,
    statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  });

  // Advance to epoch 2 so lane is active.
  const ah2 = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(1n), u64ToBytes32(2n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah2);
  registry.advanceEpoch({ newEpoch: 2n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t + 500n, now: t + 500n });

  // Lane should be active.
  assert.equal(registry.isLaneActive({ scheduleId, leviedBy, laneKindByte }), true);

  // Retire the lane.
  const retireHash = persistentHash([
    pad32(DOMAIN.RETIRE_LANE), registry.self, scheduleId, leviedBy,
    u64ToBytes32(laneKindByte), registry.currentEpochBytes(), u64ToBytes32(t + 600n),
  ]);
  approve(registry, retireHash);
  registry.retireLane({ scheduleId, leviedBy, laneKindByte, currentTime: t + 600n, now: t + 600n });

  // Lane should now be inactive.
  assert.equal(registry.isLaneActive({ scheduleId, leviedBy, laneKindByte }), false);

  // resolveLane should still return the record.
  const resolved = registry.resolveLane({ scheduleId, leviedBy, laneKindByte });
  assert.equal(resolved.retiredEpoch, 2n);
});

test('LANE-T7: retireLane on already-retired lane REVERTS', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const laneKindByte = 0;
  const leviedBy = randomBytes(32);
  const remitAddress = randomBytes(32);
  const appHash = randomBytes(32);
  const statHash = randomBytes(32);
  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(500), remitAddress,
    u64ToBytes32(0), appHash, statHash,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 500,
    remitAddress, basis: 0, applicabilityHash: appHash,
    statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  });

  // Retire once.
  const retireHash = persistentHash([
    pad32(DOMAIN.RETIRE_LANE), registry.self, scheduleId, leviedBy,
    u64ToBytes32(laneKindByte), registry.currentEpochBytes(), u64ToBytes32(t + 200n),
  ]);
  approve(registry, retireHash);
  registry.retireLane({ scheduleId, leviedBy, laneKindByte, currentTime: t + 200n, now: t + 200n });

  // Try to retire again.
  const retireHash2 = persistentHash([
    pad32(DOMAIN.RETIRE_LANE), registry.self, scheduleId, leviedBy,
    u64ToBytes32(laneKindByte), registry.currentEpochBytes(), u64ToBytes32(t + 300n),
  ]);
  approve(registry, retireHash2);
  assertReverts(() => registry.retireLane({
    scheduleId, leviedBy, laneKindByte, currentTime: t + 300n, now: t + 300n,
  }), 'LANE_ALREADY_RETIRED');
});

test('LANE-T8: replaying registerLane approval REVERTS', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const laneKindByte = 0;
  const leviedBy = randomBytes(32);
  const remitAddress = randomBytes(32);
  const appHash = randomBytes(32);
  const statHash = randomBytes(32);
  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(500), remitAddress,
    u64ToBytes32(0), appHash, statHash,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 500,
    remitAddress, basis: 0, applicabilityHash: appHash,
    statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  });

  // Retire the lane so we can try to re-register.
  const retireHash = persistentHash([
    pad32(DOMAIN.RETIRE_LANE), registry.self, scheduleId, leviedBy,
    u64ToBytes32(laneKindByte), registry.currentEpochBytes(), u64ToBytes32(t + 200n),
  ]);
  approve(registry, retireHash);
  registry.retireLane({ scheduleId, leviedBy, laneKindByte, currentTime: t + 200n, now: t + 200n });

  // Try to re-register with the SAME actionHash (replay).
  // DO NOT call approve() again — the approval is already consumed.
  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 500,
    remitAddress, basis: 0, applicabilityHash: appHash,
    statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  }), 'FEDERATION_APPROVAL_REPLAYED');
});

test('LANE-T9: resolveLanes batch heterogeneous cases (extended)', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));

  // (a) Populate 3 lanes: kind=0, kind=2, kind=3 at different leviedBy authorities.
  const authA = Buffer.concat([Buffer.from('AuthA'), Buffer.alloc(27)]);
  const authB = Buffer.concat([Buffer.from('AuthB'), Buffer.alloc(27)]);
  const authC = Buffer.concat([Buffer.from('AuthC'), Buffer.alloc(27)]);

  for (const [kind, auth, bps] of [[0, authA, 500], [2, authB, 502], [3, authC, 503]]) {
    const remitAddr = randomBytes(32);
    const appHash = randomBytes(32);
    const statHash = randomBytes(32);
    const laneActionHash = persistentHash([
      pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
      u64ToBytes32(kind), auth, u16ToBytes32(bps), remitAddr,
      u64ToBytes32(0), appHash, statHash,
      u64ToBytes32(2n), u64ToBytes32(0),
      registry.currentEpochBytes(), u64ToBytes32(t + 100n + BigInt(kind)),
    ]);
    approve(registry, laneActionHash);
    registry.registerLane({
      scheduleId, laneKindByte: kind, leviedBy: auth, bpsShare: bps,
      remitAddress: remitAddr, basis: 0, applicabilityHash: appHash,
      statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
      charterProof: proof, currentTime: t + 100n + BigInt(kind), now: t + 100n + BigInt(kind),
    });
  }

  // (c) Retire lane kind=2 to test retired-lane-in-slot.
  const retireHash = persistentHash([
    pad32(DOMAIN.RETIRE_LANE), registry.self, scheduleId, authB,
    u64ToBytes32(2), registry.currentEpochBytes(), u64ToBytes32(t + 500n),
  ]);
  approve(registry, retireHash);
  registry.retireLane({ scheduleId, leviedBy: authB, laneKindByte: 2, currentTime: t + 500n, now: t + 500n });

  // (d) Register a not-yet-effective lane (kind=5, effectiveEpoch=10 >> currentEpoch=1).
  const authD = Buffer.concat([Buffer.from('AuthD'), Buffer.alloc(27)]);
  const remitAddr5 = randomBytes(32);
  const appHash5 = randomBytes(32);
  const statHash5 = randomBytes(32);
  const laneActionHash5 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(5), authD, u16ToBytes32(505), remitAddr5,
    u64ToBytes32(0), appHash5, statHash5,
    u64ToBytes32(10n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 600n),
  ]);
  approve(registry, laneActionHash5);
  registry.registerLane({
    scheduleId, laneKindByte: 5, leviedBy: authD, bpsShare: 505,
    remitAddress: remitAddr5, basis: 0, applicabilityHash: appHash5,
    statuteRefHash: statHash5, effectiveEpoch: 10n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 600n, now: t + 600n,
  });

  // Build request vectors (length 10):
  // Slot 0: kind=0, authA (populated, active)
  // Slot 1: kind=1, authA (empty, not registered)
  // Slot 2: kind=2, authB (retired)
  // Slot 3: kind=3, authC (populated, active)
  // Slot 4: kind=5, authD (not-yet-effective)
  // Slot 5: kind=0, authA again (duplicate pair → same record as slot 0)
  // Slots 6-9: zero-authority, kind=0 (empty)
  const zeroAuth = Buffer.alloc(32);
  const leviedBysVec = [authA, authA, authB, authC, authD, authA, zeroAuth, zeroAuth, zeroAuth, zeroAuth];
  const kindsVec = [0, 1, 2, 3, 5, 0, 0, 0, 0, 0];

  const results = registry.resolveLanes({ scheduleId, leviedBys: leviedBysVec, laneKindBytes: kindsVec });
  assert.equal(results.length, 10);

  // (a) Slot 0: populated, active.
  assert.equal(results[0].laneKindByte, 0);
  assert.equal(results[0].bpsShare, 500);
  assert.ok(bufEq(results[0].leviedBy, authA));
  assert.equal(results[0].retiredEpoch, 0n);

  // (b) Slot 1: empty (kind=1, authA not registered) → zero record.
  assert.equal(results[1].laneKindByte, 0);
  assert.equal(results[1].bpsShare, 0);
  assert.equal(results[1].retiredEpoch, 0n);
  assert.ok(bufEq(results[1].scheduleId, Buffer.alloc(32)));

  // (c) Slot 2: retired lane (retiredEpoch != 0).
  assert.equal(results[2].laneKindByte, 2);
  assert.equal(results[2].bpsShare, 502);
  assert.ok(bufEq(results[2].leviedBy, authB));
  assert.equal(results[2].retiredEpoch, 1n); // retired at epoch 1

  // Slot 3: populated, active.
  assert.equal(results[3].laneKindByte, 3);
  assert.equal(results[3].bpsShare, 503);

  // (d) Slot 4: not-yet-effective (effectiveEpoch=10 > currentEpoch=1).
  assert.equal(results[4].laneKindByte, 5);
  assert.equal(results[4].bpsShare, 505);
  assert.equal(results[4].effectiveEpoch, 10n);
  assert.equal(results[4].retiredEpoch, 0n);

  // (e) Slot 5: duplicate pair (kind=0, authA) → same record as slot 0.
  assert.equal(results[5].laneKindByte, 0);
  assert.equal(results[5].bpsShare, 500);
  assert.ok(bufEq(results[5].leviedBy, authA));

  // Slots 6-9: empty (zero authority → not registered).
  for (let i = 6; i < 10; i++) {
    assert.ok(bufEq(results[i].scheduleId, Buffer.alloc(32)));
    assert.equal(results[i].bpsShare, 0);
  }
});

test('LANE-T10: count-cap enforcement at MAX_STATUTORY_LANES=10', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));

  // Register 10 lanes with distinct (leviedBy, laneKindByte) pairs.
  for (let i = 0; i < 10; i++) {
    const authName = `Auth${i}`;
    const leviedBy = Buffer.concat([Buffer.from(authName), Buffer.alloc(32 - authName.length)]);
    const kind = i; // kinds 0..9
    const remitAddr = randomBytes(32);
    const appHash = randomBytes(32);
    const statHash = randomBytes(32);
    const laneActionHash = persistentHash([
      pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
      u64ToBytes32(kind), leviedBy, u16ToBytes32(500 + i), remitAddr,
      u64ToBytes32(0), appHash, statHash,
      u64ToBytes32(2n), u64ToBytes32(0),
      registry.currentEpochBytes(), u64ToBytes32(t + 100n + BigInt(i)),
    ]);
    approve(registry, laneActionHash);
    registry.registerLane({
      scheduleId, laneKindByte: kind, leviedBy, bpsShare: 500 + i,
      remitAddress: remitAddr, basis: 0, applicabilityHash: appHash,
      statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
      charterProof: proof, currentTime: t + 100n + BigInt(i), now: t + 100n + BigInt(i),
    });
  }

  // Verify count is 10.
  assert.equal(registry._registeredLaneCount.get(toHex(scheduleId)), 10);

  // Try to register an 11th lane → should revert (bare underflow).
  const leviedBy11 = Buffer.concat([Buffer.from('Auth11'), Buffer.alloc(26)]);
  const remitAddr11 = randomBytes(32);
  const appHash11 = randomBytes(32);
  const statHash11 = randomBytes(32);
  const laneActionHash11 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(10), leviedBy11, u16ToBytes32(600), remitAddr11,
    u64ToBytes32(0), appHash11, statHash11,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 2000n),
  ]);
  approve(registry, laneActionHash11);
  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte: 10, leviedBy: leviedBy11, bpsShare: 600,
    remitAddress: remitAddr11, basis: 0, applicabilityHash: appHash11,
    statuteRefHash: statHash11, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 2000n, now: t + 2000n,
  }));
});

test('LANE-T11: resolveLanes width-10 round trip', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));

  // Register 10 lanes.
  const authorities = [];
  const kinds = [];
  for (let i = 0; i < 10; i++) {
    const authName = `Auth${i}`;
    const leviedBy = Buffer.concat([Buffer.from(authName), Buffer.alloc(32 - authName.length)]);
    authorities.push(leviedBy);
    kinds.push(i);
    const remitAddr = randomBytes(32);
    const appHash = randomBytes(32);
    const statHash = randomBytes(32);
    const laneActionHash = persistentHash([
      pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
      u64ToBytes32(i), leviedBy, u16ToBytes32(500 + i), remitAddr,
      u64ToBytes32(0), appHash, statHash,
      u64ToBytes32(2n), u64ToBytes32(0),
      registry.currentEpochBytes(), u64ToBytes32(t + 100n + BigInt(i)),
    ]);
    approve(registry, laneActionHash);
    registry.registerLane({
      scheduleId, laneKindByte: i, leviedBy, bpsShare: 500 + i,
      remitAddress: remitAddr, basis: 0, applicabilityHash: appHash,
      statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
      charterProof: proof, currentTime: t + 100n + BigInt(i), now: t + 100n + BigInt(i),
    });
  }

  // Call resolveLanes with all 10 pairs.
  const results = registry.resolveLanes({ scheduleId, leviedBys: authorities, laneKindBytes: kinds });
  assert.equal(results.length, 10);

  // Verify all 10 return records have matching non-zero scheduleId and correct (leviedBy, laneKindByte).
  for (let i = 0; i < 10; i++) {
    assert.ok(bufEq(results[i].scheduleId, scheduleId));
    assert.ok(bufEq(results[i].leviedBy, authorities[i]));
    assert.equal(results[i].laneKindByte, kinds[i]);
    assert.equal(results[i].bpsShare, 500 + i);
  }
});

test('LANE-T12: kind-range enforcement (laneKindByte < 16)', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));

  // Try to register with laneKindByte = 16 → should revert (bare underflow).
  const leviedBy = randomBytes(32);
  const remitAddr = randomBytes(32);
  const appHash = randomBytes(32);
  const statHash = randomBytes(32);
  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(16), leviedBy, u16ToBytes32(500), remitAddr,
    u64ToBytes32(0), appHash, statHash,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash);
  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte: 16, leviedBy, bpsShare: 500,
    remitAddress: remitAddr, basis: 0, applicabilityHash: appHash,
    statuteRefHash: statHash, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  }));

  // Verify laneKindByte = 15 succeeds (upper boundary inclusive of 15).
  const leviedBy15 = randomBytes(32);
  const remitAddr15 = randomBytes(32);
  const appHash15 = randomBytes(32);
  const statHash15 = randomBytes(32);
  const laneActionHash15 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(15), leviedBy15, u16ToBytes32(500), remitAddr15,
    u64ToBytes32(0), appHash15, statHash15,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 200n),
  ]);
  approve(registry, laneActionHash15);
  registry.registerLane({
    scheduleId, laneKindByte: 15, leviedBy: leviedBy15, bpsShare: 500,
    remitAddress: remitAddr15, basis: 0, applicabilityHash: appHash15,
    statuteRefHash: statHash15, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 200n, now: t + 200n,
  });

  // Verify it was registered.
  const resolved = registry.resolveLane({ scheduleId, leviedBy: leviedBy15, laneKindByte: 15 });
  assert.equal(resolved.laneKindByte, 15);
  assert.equal(resolved.bpsShare, 500);
});

test('LANE-R-A: charter proof against outdated root (post-advanceEpoch) REVERTS', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  // Rotate governanceRoot.
  const newRoot = randomBytes(32);
  const ah2 = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(1n), u64ToBytes32(2n), u64ToBytes32(100n), newRoot]);
  approve(registry, ah2);
  registry.advanceEpoch({ newEpoch: 2n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: newRoot, currentTime: t + 500n, now: t + 500n });

  // Try to register a lane using the OLD proof.
  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const leviedBy = randomBytes(32);
  const laneActionHash = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(0), leviedBy, u16ToBytes32(500), randomBytes(32),
    u64ToBytes32(0), randomBytes(32), randomBytes(32),
    u64ToBytes32(3n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 600n),
  ]);
  approve(registry, laneActionHash);
  assertReverts(() => registry.registerLane({
    scheduleId, laneKindByte: 0, leviedBy, bpsShare: 500,
    remitAddress: randomBytes(32), basis: 0, applicabilityHash: randomBytes(32),
    statuteRefHash: randomBytes(32), effectiveEpoch: 3n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 600n, now: t + 600n,
  }), 'SCHEDULE_UNCHARTERED_NODE');
});

test('LANE-R-E: register → retire → register-again on same key succeeds', () => {
  const fx = makeFixture();
  const { registry, charterTree, charteredNodes } = fx;
  const { scheduleId } = registerFixture({ fixture: fx });

  const t = 2_000_000n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(0n), u64ToBytes32(1n), u64ToBytes32(100n), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: 1n, newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: registry._governanceRoot, currentTime: t, now: t });

  const proof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const laneKindByte = 0;
  const leviedBy = Buffer.concat([Buffer.from('EPRA'), Buffer.alloc(28)]);

  // Register first lane.
  const remitAddress1 = randomBytes(32);
  const appHash1 = randomBytes(32);
  const statHash1 = randomBytes(32);
  const laneActionHash1 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(500), remitAddress1,
    u64ToBytes32(0), appHash1, statHash1,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 100n),
  ]);
  approve(registry, laneActionHash1);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 500,
    remitAddress: remitAddress1, basis: 0, applicabilityHash: appHash1,
    statuteRefHash: statHash1, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 100n, now: t + 100n,
  });

  // Verify count is 1.
  assert.equal(registry._registeredLaneCount.get(toHex(scheduleId)), 1);

  // Retire it.
  const retireHash = persistentHash([
    pad32(DOMAIN.RETIRE_LANE), registry.self, scheduleId, leviedBy,
    u64ToBytes32(laneKindByte), registry.currentEpochBytes(), u64ToBytes32(t + 200n),
  ]);
  approve(registry, retireHash);
  registry.retireLane({ scheduleId, leviedBy, laneKindByte, currentTime: t + 200n, now: t + 200n });

  // Register again on the same (scheduleId, leviedBy, laneKindByte) with NEW bpsShare.
  const remitAddress2 = randomBytes(32);
  const appHash2 = randomBytes(32);
  const statHash2 = randomBytes(32);
  const laneActionHash2 = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(700), remitAddress2,
    u64ToBytes32(0), appHash2, statHash2,
    u64ToBytes32(2n), u64ToBytes32(0),
    registry.currentEpochBytes(), u64ToBytes32(t + 300n),
  ]);
  approve(registry, laneActionHash2);
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare: 700,
    remitAddress: remitAddress2, basis: 0, applicabilityHash: appHash2,
    statuteRefHash: statHash2, effectiveEpoch: 2n, remittanceMode: 0,
    charterProof: proof, currentTime: t + 300n, now: t + 300n,
  });

  // Verify count is STILL 1 (slot was already claimed, not incremented).
  assert.equal(registry._registeredLaneCount.get(toHex(scheduleId)), 1);

  // Resolve: new record supersedes.
  const resolved = registry.resolveLane({ scheduleId, leviedBy, laneKindByte });
  assert.equal(resolved.bpsShare, 700);
  assert.equal(resolved.retiredEpoch, 0n);
});
