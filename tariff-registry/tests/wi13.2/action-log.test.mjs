// tariff-registry/tests/wi13.2/action-log.test.mjs
// -----------------------------------------------------------------------------
// WI-13.2 offline suite — action-log root + per-kind payloadHash widening.
//
// Coverage (brief §REQUIRED TESTS):
//   AL-T1  Per-kind payloadHash (kinds 0,1,2,3,7): emit -> getActionEntry ->
//          recompute payloadHash off-chain from the map record -> byte-equal.
//          (I-13.2-A + I-13.2-B + the WI-14 recHash == entry.payloadHash gate.)
//   AL-T2  Monotonicity: 10 mixed-kind emits; root changes on every emit and
//          never repeats; old-leaf inclusion proofs still verify against the
//          new root (append-only, I-13.2-C).
//   AL-T3  Determinism (property, 1000 sequences): same ordered (kind,leaf)
//          sequence -> byte-identical root, across two independent builders,
//          and correctness is D-independent (I-13.2-D).
//   AL-T4  Migration: bootstrap from WI-13.1-style pre-amendment state ->
//          root == EMPTY_ROOT(D), baseSeq == pre-head, pre-amendment entries
//          read back with payloadHash == pad(32,"") (§SCOPE F).
//   AL-T5  WI-14 EventProof integration preview: generate an EventProof, run a
//          simulated verifyEventProof (recompute payloadHash + reconstructRoot
//          + compare to registryActionLogRoot); accept valid, reject (i) wrong
//          payloadHash, (ii) tampered sibling, (iii) stale root. (§SCOPE E.)
//
// The .compact contract is ground truth for chain behaviour; lib.mjs mirrors it
// byte-for-byte (domain tags, field order, node/leaf hashing). No new deps.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';

import {
  TariffRegistry, DOMAIN,
  pad32, persistentHash, u64ToBytes32, u16ToBytes32,
  toHex, bufEq,
  buildCharterTree,
  validSplit,
  newEd25519, ed25519Sign,
  Revert, makeFixture,
  // WI-13.2 surface
  ACTION_LOG_DEPTH_DEFAULT,
  laneActionPayloadHash, scheduleActionPayloadHash, retuneActionPayloadHash,
  sentinelPayloadHash,
  ActionLogTree, actionLogZeros, reconstructActionLogRoot,
} from '../lib.mjs';

// ------------------------------ shared harness -------------------------------

function assertReverts(fn, expected) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof Revert, `expected Revert, got ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    if (expected) assert.match(e.message, new RegExp(expected), `expected /${expected}/, got: ${e.message}`);
    return;
  }
  assert.fail(`expected Revert (${expected ?? 'any'}), but no throw`);
}

function approve(registry, actionHash) { registry.approveByFederation(actionHash); }

// Register a schedule against a chartered node (auto approval + validator sig +
// charter proof). Returns { scheduleId }.
function doRegisterSchedule(fx, { nodeId, scheduleHash, effectiveEpoch, currentTime, refRate } = {}) {
  const { registry, opKey, validatorKey, charteredNodes, charterTree } = fx;
  nodeId = nodeId ?? charteredNodes[0];
  scheduleHash = scheduleHash ?? randomBytes(32);
  effectiveEpoch = effectiveEpoch ?? (registry._currentEpoch + 1n);
  currentTime = currentTime ?? 1_000_000n;
  refRate = refRate ?? 100n;
  const actionHash = persistentHash([
    pad32(DOMAIN.REGISTER_SCHEDULE), registry.self, nodeId, scheduleHash,
    u64ToBytes32(effectiveEpoch), registry.currentEpochBytes(),
  ]);
  approve(registry, actionHash);
  const validatorSignature = ed25519Sign(validatorKey.privateKey, actionHash);
  const charterProof = charterTree.proofsByNodeId.get(toHex(nodeId));
  const res = registry.registerSchedule({
    nodeId, scheduleHash, operatorPubkey: opKey.pubkeyBytes,
    refRateFiatPerKwh: refRate, effectiveEpoch,
    validatorAttestor: validatorKey.pubkeyBytes, validatorSignature,
    currentTime, charterProof, now: currentTime,
  });
  return { scheduleId: res.scheduleId, refRate };
}

function doAdvanceEpoch(fx, currentTime, refRate = 100n) {
  const { registry } = fx;
  const from = registry._currentEpoch;
  const to = from + 1n;
  const ah = persistentHash([pad32(DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(from), u64ToBytes32(to), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah);
  registry.advanceEpoch({ newEpoch: to, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime, now: currentTime });
}

function doRegisterLane(fx, { scheduleId, laneKindByte, leviedBy, bpsShare, effectiveEpoch, currentTime }) {
  const { registry, charteredNodes, charterTree } = fx;
  const remitAddress = randomBytes(32);
  const applicabilityHash = randomBytes(32);
  const statuteRefHash = randomBytes(32);
  const basis = 0, remittanceMode = 0;
  const ah = persistentHash([
    pad32(DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(bpsShare), remitAddress,
    u64ToBytes32(basis), applicabilityHash, statuteRefHash,
    u64ToBytes32(effectiveEpoch), u64ToBytes32(remittanceMode),
    registry.currentEpochBytes(), u64ToBytes32(currentTime),
  ]);
  approve(registry, ah);
  const charterProof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  return registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare, remitAddress, basis,
    applicabilityHash, statuteRefHash, effectiveEpoch, remittanceMode,
    charterProof, currentTime, now: currentTime,
  });
}

function doRetireLane(fx, { scheduleId, leviedBy, laneKindByte, currentTime }) {
  const { registry } = fx;
  const ah = persistentHash([
    pad32(DOMAIN.RETIRE_LANE), registry.self, scheduleId, leviedBy,
    u64ToBytes32(laneKindByte), registry.currentEpochBytes(), u64ToBytes32(currentTime),
  ]);
  approve(registry, ah);
  return registry.retireLane({ scheduleId, leviedBy, laneKindByte, currentTime, now: currentTime });
}

function doRetireSchedule(fx, { scheduleId, currentTime }) {
  const { registry } = fx;
  const ah = persistentHash([pad32(DOMAIN.RETIRE_SCHEDULE),
    registry.self, scheduleId, registry.currentEpochBytes()]);
  approve(registry, ah);
  return registry.retireSchedule({ scheduleId, currentTime, now: currentTime });
}

function doRetune(fx, { scheduleId, classPath, split, rate, nonceIn, currentTime }) {
  const { registry, opKey } = fx;
  const shHash = persistentHash([
    pad32(DOMAIN.SPLIT_SHARES),
    u16ToBytes32(split.producerShareBps), u16ToBytes32(split.ldShareBps),
    u16ToBytes32(split.opsShareBps), u16ToBytes32(split.daoShareBps),
    u16ToBytes32(split.operatorMarginBps), u16ToBytes32(split.statutoryTotalBps),
  ]);
  const authHash = persistentHash([
    pad32(DOMAIN.RETUNE_CLASS), registry.self, scheduleId, classPath, shHash,
    u64ToBytes32(rate), registry.currentEpochBytes(), u64ToBytes32(nonceIn),
    u64ToBytes32(currentTime),
  ]);
  const signature = ed25519Sign(opKey.privateKey, authHash);
  return registry.retuneClass({
    scheduleId, classPath, newSplitBps: split, newRateFiatPerKwh: rate,
    operatorId: opKey.pubkeyBytes, operatorSignature: signature,
    nonceIn, currentTime, now: currentTime,
  });
}

// -----------------------------------------------------------------------------
// AL-T1 — per-kind payloadHash: on-chain value == off-chain recompute from map.
// -----------------------------------------------------------------------------

test('AL-T1 kind 0 SCHEDULE_REGISTERED: payloadHash == recompute from _registeredSchedules', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const { scheduleId } = doRegisterSchedule(fx);

  const entry = registry.getActionEntry(0n);
  assert.equal(entry.kind, 0);
  const record = registry._registeredSchedules.get(toHex(scheduleId));
  const expected = scheduleActionPayloadHash(0, record);
  assert.ok(bufEq(entry.payloadHash, expected), 'kind-0 payloadHash mismatch');
  assert.ok(!bufEq(entry.payloadHash, sentinelPayloadHash()), 'must be non-sentinel');
});

test('AL-T1 kind 1 LANE_REGISTERED: payloadHash == recompute from resolveLane record', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const { scheduleId } = doRegisterSchedule(fx);
  doAdvanceEpoch(fx, 2_000_000n);

  const leviedBy = Buffer.concat([Buffer.from('KRA'), Buffer.alloc(29)]);
  const laneKindByte = 1;
  doRegisterLane(fx, { scheduleId, laneKindByte, leviedBy, bpsShare: 500, effectiveEpoch: 2n, currentTime: 2_000_100n });

  // The lane emit is the 2nd event (seq: 0 register, 1 advance, 2 lane).
  const entry = registry.getActionEntry(2n);
  assert.equal(entry.kind, 1);
  const record = registry.resolveLane({ scheduleId, leviedBy, laneKindByte });
  const expected = laneActionPayloadHash(1, record);
  assert.ok(bufEq(entry.payloadHash, expected), 'kind-1 payloadHash mismatch');
});

test('AL-T1 kind 2 retuneClass: payloadHash == recompute from _classEntries', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const { scheduleId, refRate } = doRegisterSchedule(fx);
  doAdvanceEpoch(fx, 2_000_000n, refRate);

  const classPath = randomBytes(32);
  const split = validSplit();
  doRetune(fx, { scheduleId, classPath, split, rate: refRate, nonceIn: 1n, currentTime: 2_000_100n });

  const entry = registry.getActionEntry(2n); // seq 0 register, 1 advance, 2 retune
  assert.equal(entry.kind, 2);
  const splitKey = registry.classSplitKey(scheduleId, classPath);
  const ce = registry._classEntries.get(toHex(splitKey));
  const expected = retuneActionPayloadHash(scheduleId, classPath, ce.bps, ce.rateFiatPerKwh, ce.lastUpdatedAt);
  assert.ok(bufEq(entry.payloadHash, expected), 'kind-2 payloadHash mismatch');
});

test('AL-T1 kind 3 SCHEDULE_RETIRED: payloadHash == recompute from retired record', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const { scheduleId, refRate } = doRegisterSchedule(fx);
  doAdvanceEpoch(fx, 2_000_000n, refRate);
  doRetireSchedule(fx, { scheduleId, currentTime: 2_000_100n });

  const entry = registry.getActionEntry(2n); // 0 register, 1 advance, 2 retire
  assert.equal(entry.kind, 3);
  const record = registry._registeredSchedules.get(toHex(scheduleId)); // retiredEpoch != 0
  assert.notEqual(record.retiredEpoch, 0n);
  const expected = scheduleActionPayloadHash(3, record);
  assert.ok(bufEq(entry.payloadHash, expected), 'kind-3 payloadHash mismatch');
  // I-13.2-E: retired body differs from a live body (retiredEpoch inside hash).
  const liveLike = { ...record, retiredEpoch: 0n };
  assert.ok(!bufEq(expected, scheduleActionPayloadHash(3, liveLike)), 'retired must differ from live');
});

test('AL-T1 kind 7 LANE_RETIRED: payloadHash == recompute from retired lane record', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const { scheduleId } = doRegisterSchedule(fx);
  doAdvanceEpoch(fx, 2_000_000n);

  const leviedBy = Buffer.concat([Buffer.from('EPRA'), Buffer.alloc(28)]);
  const laneKindByte = 3;
  doRegisterLane(fx, { scheduleId, laneKindByte, leviedBy, bpsShare: 500, effectiveEpoch: 2n, currentTime: 2_000_100n });
  doAdvanceEpoch(fx, 3_000_000n);
  doRetireLane(fx, { scheduleId, leviedBy, laneKindByte, currentTime: 3_000_100n });

  // seq: 0 register, 1 advance, 2 lane, 3 advance, 4 retireLane
  const entry = registry.getActionEntry(4n);
  assert.equal(entry.kind, 7);
  const record = registry.resolveLane({ scheduleId, leviedBy, laneKindByte }); // retiredEpoch != 0
  assert.notEqual(record.retiredEpoch, 0n);
  const expected = laneActionPayloadHash(7, record);
  assert.ok(bufEq(entry.payloadHash, expected), 'kind-7 payloadHash mismatch');
  // I-13.2-E: kind-1 vs kind-7 over the same record differ in the kind byte.
  assert.ok(!bufEq(expected, laneActionPayloadHash(1, record)), 'kind byte must separate 1 vs 7');
});

test('AL-T1 non-mirrored kinds 4/5/6 carry the pad(32,"") sentinel payloadHash', () => {
  const fx = makeFixture();
  const { registry } = fx;
  doRegisterSchedule(fx);              // seq 0 (kind 0, non-sentinel)
  doAdvanceEpoch(fx, 2_000_000n);      // seq 1 (kind 4, sentinel)
  const advanceEntry = registry.getActionEntry(1n);
  assert.equal(advanceEntry.kind, 4);
  assert.ok(bufEq(advanceEntry.payloadHash, sentinelPayloadHash()), 'kind-4 must be sentinel');
});

// -----------------------------------------------------------------------------
// AL-T2 — monotonicity: 10 mixed-kind emits, append-only root.
// -----------------------------------------------------------------------------

test('AL-T2 monotonicity: 10 mixed-kind emits; root changes & never rewinds; old proofs verify', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const roots = [Buffer.from(registry.registryActionLogRoot)]; // empty root at seq 0

  // seq 0: register schedule (kind 0)
  const { scheduleId, refRate } = doRegisterSchedule(fx);
  roots.push(Buffer.from(registry.registryActionLogRoot));
  // seq 1: advanceEpoch (kind 4, non-mirrored)
  doAdvanceEpoch(fx, 2_000_000n, refRate);
  roots.push(Buffer.from(registry.registryActionLogRoot));

  const authA = Buffer.concat([Buffer.from('AuthA'), Buffer.alloc(27)]);
  const authB = Buffer.concat([Buffer.from('AuthB'), Buffer.alloc(27)]);
  const authC = Buffer.concat([Buffer.from('AuthC'), Buffer.alloc(27)]);
  // seq 2,3: register two lanes (kind 1)
  doRegisterLane(fx, { scheduleId, laneKindByte: 0, leviedBy: authA, bpsShare: 500, effectiveEpoch: 2n, currentTime: 2_000_100n });
  roots.push(Buffer.from(registry.registryActionLogRoot));
  doRegisterLane(fx, { scheduleId, laneKindByte: 1, leviedBy: authB, bpsShare: 400, effectiveEpoch: 2n, currentTime: 2_000_200n });
  roots.push(Buffer.from(registry.registryActionLogRoot));
  // seq 4: retune (kind 2)
  doRetune(fx, { scheduleId, classPath: randomBytes(32), split: validSplit(), rate: refRate, nonceIn: 1n, currentTime: 2_000_300n });
  roots.push(Buffer.from(registry.registryActionLogRoot));
  // seq 5: advanceEpoch (kind 4)
  doAdvanceEpoch(fx, 3_000_000n, refRate);
  roots.push(Buffer.from(registry.registryActionLogRoot));
  // seq 6: retire lane authA (kind 7)
  doRetireLane(fx, { scheduleId, leviedBy: authA, laneKindByte: 0, currentTime: 3_000_100n });
  roots.push(Buffer.from(registry.registryActionLogRoot));
  // seq 7: register another lane (kind 1)
  doRegisterLane(fx, { scheduleId, laneKindByte: 2, leviedBy: authC, bpsShare: 300, effectiveEpoch: 4n, currentTime: 3_000_200n });
  roots.push(Buffer.from(registry.registryActionLogRoot));
  // seq 8: retune a second class (kind 2)
  doRetune(fx, { scheduleId, classPath: randomBytes(32), split: validSplit(), rate: refRate, nonceIn: 1n, currentTime: 3_000_300n });
  roots.push(Buffer.from(registry.registryActionLogRoot));
  // seq 9: retire schedule (kind 3)
  doRetireSchedule(fx, { scheduleId, currentTime: 3_000_400n });
  roots.push(Buffer.from(registry.registryActionLogRoot));

  assert.equal(registry._actionSeq, 10n, 'expected 10 emits');

  // Every emit changed the root; no root ever repeats (append-only, I-13.2-C).
  const seen = new Set();
  for (let i = 0; i < roots.length; i++) {
    const hex = toHex(roots[i]);
    assert.ok(!seen.has(hex), `root repeated at step ${i}`);
    seen.add(hex);
    if (i > 0) assert.ok(!bufEq(roots[i], roots[i - 1]), `root did not change at emit ${i}`);
  }

  // Old-leaf inclusion still verifies against the FINAL (new) root: pick leaf 0.
  const finalRoot = registry.registryActionLogRoot;
  const tree = registry._actionLogTree;
  for (const idx of [0, 2, 4, 6, 9]) {
    const leaf = registry.getActionPayloadHash(BigInt(idx));
    const { siblings, pathBits } = tree.proof(idx);
    const reconstructed = reconstructActionLogRoot(leaf, siblings, pathBits);
    assert.ok(bufEq(reconstructed, finalRoot), `leaf ${idx} inclusion failed against final root`);
  }
});

// -----------------------------------------------------------------------------
// AL-T3 — determinism (property): same sequence -> byte-identical root.
// -----------------------------------------------------------------------------

test('AL-T3 determinism: 1000 random (kind,leaf) sequences build byte-identical roots (two builders)', () => {
  const SEED_RUNS = 1000;
  for (let run = 0; run < SEED_RUNS; run++) {
    const depth = 8; // small depth for speed; D-independence checked separately
    const n = 1 + randomInt(0, 40); // up to ~40 leaves (< 2^8)
    const leaves = [];
    for (let i = 0; i < n; i++) {
      // Mix real payloadHashes and the sentinel (non-mirrored kinds).
      leaves.push(randomInt(0, 5) === 0 ? sentinelPayloadHash() : randomBytes(32));
    }
    const a = new ActionLogTree(depth);
    const b = new ActionLogTree(depth);
    for (const l of leaves) a.append(l);
    for (const l of leaves) b.append(l);
    assert.ok(bufEq(a.root, b.root), `run ${run}: two independent builders diverged`);
  }
});

test('AL-T3 D-independence: correctness holds at multiple depths (roots deterministic per D)', () => {
  const leaves = Array.from({ length: 20 }, () => randomBytes(32));
  for (const depth of [8, 12, 16, 20]) {
    const a = new ActionLogTree(depth);
    const b = new ActionLogTree(depth);
    for (const l of leaves) { a.append(l); b.append(l); }
    assert.ok(bufEq(a.root, b.root), `depth ${depth}: nondeterministic`);
    // Inclusion of every leaf verifies against the final root at this depth.
    for (let i = 0; i < leaves.length; i++) {
      const { siblings, pathBits } = a.proof(i);
      assert.ok(bufEq(reconstructActionLogRoot(leaves[i], siblings, pathBits), a.root),
        `depth ${depth}: leaf ${i} inclusion failed`);
    }
  }
});

test('AL-T3 incremental root == the empty root before any append; single append is deterministic', () => {
  const depth = 10;
  const { emptyRoot } = actionLogZeros(depth);
  const t = new ActionLogTree(depth);
  assert.ok(bufEq(t.root, emptyRoot), 'fresh tree root must equal EMPTY_ROOT(D)');
  const leaf = randomBytes(32);
  const r1 = Buffer.from(t.append(leaf));
  const t2 = new ActionLogTree(depth);
  const r2 = Buffer.from(t2.append(Buffer.from(leaf)));
  assert.ok(bufEq(r1, r2), 'single-append root nondeterministic');
});

// -----------------------------------------------------------------------------
// AL-T4 — migration (forward-only): WI-13.1 pre-amendment state -> amended.
// -----------------------------------------------------------------------------

test('AL-T4 migration: bootstrap forward-only; root == EMPTY_ROOT(D), baseSeq == pre-head', () => {
  const depth = ACTION_LOG_DEPTH_DEFAULT;
  const fx = makeFixture(); // fresh registry; simulate pre-amendment below
  const { registry } = fx;

  // Simulate a WI-13.1 pre-amendment state: several legacy _actionLog entries
  // with the sentinel payloadHash and a non-zero _actionSeq, none committed to
  // the tree. (Historical entries cannot yield a canonical payloadHash — they
  // only stored the non-invertible actionHash; §SCOPE F design decision #2.)
  const PRE = 5;
  for (let i = 0; i < PRE; i++) {
    registry.pushLegacyEntry({ kind: i % 8, currentTime: BigInt(1000 + i) });
  }
  const preHead = registry._actionSeq;
  assert.equal(preHead, BigInt(PRE));

  // Activate the amendment (forward-only migration).
  registry.bootstrapActionLogRoot();

  // (a) root == EMPTY_ROOT(D) and baseSeq == pre-amendment head.
  const { emptyRoot } = actionLogZeros(depth);
  assert.ok(bufEq(registry.registryActionLogRoot, emptyRoot), 'root must be EMPTY_ROOT(D)');
  assert.equal(registry._actionLogBaseSeq, preHead, 'baseSeq must equal pre-amendment head');

  // (b) pre-amendment entries read back with payloadHash == pad(32,"").
  for (let i = 0; i < PRE; i++) {
    const e = registry.getActionEntry(BigInt(i));
    assert.ok(bufEq(e.payloadHash, sentinelPayloadHash()),
      `legacy entry ${i} must carry the pre-amendment sentinel`);
  }

  // (c) from baseSeq forward, real emits populate payloadHash + extend root.
  const { scheduleId } = doRegisterSchedule(fx, { effectiveEpoch: 1n });
  assert.equal(registry._actionSeq, preHead + 1n);
  const firstMirrored = registry.getActionEntry(preHead);
  assert.equal(firstMirrored.kind, 0);
  assert.ok(!bufEq(firstMirrored.payloadHash, sentinelPayloadHash()), 'first post-migration entry must be mirrored');
  assert.ok(!bufEq(registry.registryActionLogRoot, emptyRoot), 'root must advance past empty after first mirrored emit');
  // The freshly committed leaf verifies against the new root at its tree index
  // (tree index is relative to bootstrap: this is leaf 0 of the migrated tree).
  const { siblings, pathBits } = registry._actionLogTree.proof(0);
  assert.ok(bufEq(reconstructActionLogRoot(firstMirrored.payloadHash, siblings, pathBits),
                  registry.registryActionLogRoot), 'post-migration leaf 0 inclusion failed');
});

// -----------------------------------------------------------------------------
// AL-T5 — WI-14 EventProof integration preview (simulated verifyEventProof).
// -----------------------------------------------------------------------------

// TypeScript-equivalent of VNEXT-DESIGN §7.1 verifyEventProof: (1) recompute
// payloadHash from the event body the keeper supplies, assert == proof.payloadHash
// (== entry.payloadHash); (2) reconstructRoot from (payloadHash, siblings,
// pathBits); (3) assert == the committed root. WI-13.2 ships NO in-circuit
// verifier — this is the shape-compatibility evidence only.
function simulateVerifyEventProof({ entry, recomputedPayloadHash, proof, root }) {
  // Step 1: keeper's recomputed body hash must match the proof + entry.
  if (!bufEq(recomputedPayloadHash, proof.payloadHash)) throw new Revert('EVENT_PROOF_INVALID:recHash');
  if (!bufEq(entry.payloadHash, proof.payloadHash)) throw new Revert('EVENT_PROOF_INVALID:entryHash');
  // Step 2 + 3: reconstruct and compare to the committed root.
  const reconstructed = reconstructActionLogRoot(proof.payloadHash, proof.siblings, proof.pathBits);
  if (!bufEq(reconstructed, root)) throw new Revert('EVENT_PROOF_INVALID:root');
  return true;
}

test('AL-T5 EventProof preview: valid proof ACCEPTS; wrong hash / tampered sibling / stale root REJECT', () => {
  const fx = makeFixture();
  const { registry } = fx;
  const { scheduleId } = doRegisterSchedule(fx);
  doAdvanceEpoch(fx, 2_000_000n);

  // Emit a LANE_REGISTERED (kind 1) — a fully mirror-relevant event.
  const leviedBy = Buffer.concat([Buffer.from('WARMA'), Buffer.alloc(27)]);
  const laneKindByte = 4;
  doRegisterLane(fx, { scheduleId, laneKindByte, leviedBy, bpsShare: 250, effectiveEpoch: 2n, currentTime: 2_000_100n });
  const actionSeq = 2n; // 0 register, 1 advance, 2 lane

  // Save a stale root, then add more events so the committed root moves on.
  const staleRoot = Buffer.from(registry.registryActionLogRoot);
  doRetune(fx, { scheduleId, classPath: randomBytes(32), split: validSplit(), rate: 100n, nonceIn: 1n, currentTime: 2_000_200n });
  const currentRoot = registry.registryActionLogRoot;
  assert.ok(!bufEq(staleRoot, currentRoot), 'sanity: root advanced');

  // Build the EventProof for the lane event against the CURRENT tree.
  const entry = registry.getActionEntry(actionSeq);
  const { siblings, pathBits } = registry._actionLogTree.proof(Number(actionSeq));
  const proof = {
    actionSeq,
    payloadHash: Buffer.from(entry.payloadHash),
    merkleProof: siblings,     // Vector<D, Bytes<32>>
    merkleSiblings: pathBits,  // Vector<D, Bool>  (path bits)
    siblings, pathBits,        // aliases used by reconstructActionLogRoot
  };

  // Keeper recomputes payloadHash from the LaneRecord (VNEXT-DESIGN §7.2 recHash).
  const laneRecord = registry.resolveLane({ scheduleId, leviedBy, laneKindByte });
  const recomputed = laneActionPayloadHash(1, laneRecord);

  // (valid) ACCEPTS against the current root.
  assert.equal(simulateVerifyEventProof({ entry, recomputedPayloadHash: recomputed, proof, root: currentRoot }), true);

  // (i) wrong payloadHash -> REJECT.
  assertReverts(() => simulateVerifyEventProof({
    entry, recomputedPayloadHash: randomBytes(32), proof, root: currentRoot,
  }), 'EVENT_PROOF_INVALID');

  // (ii) tampered sibling -> REJECT.
  const tamperedSibs = proof.siblings.map((s, i) => (i === 0 ? randomBytes(32) : s));
  assertReverts(() => simulateVerifyEventProof({
    entry, recomputedPayloadHash: recomputed,
    proof: { ...proof, payloadHash: proof.payloadHash, siblings: tamperedSibs, pathBits: proof.pathBits },
    root: currentRoot,
  }), 'EVENT_PROOF_INVALID:root');

  // (iii) proof against a stale root -> REJECT.
  assertReverts(() => simulateVerifyEventProof({
    entry, recomputedPayloadHash: recomputed, proof, root: staleRoot,
  }), 'EVENT_PROOF_INVALID:root');
});
