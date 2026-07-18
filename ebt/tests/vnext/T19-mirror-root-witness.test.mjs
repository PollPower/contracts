// T19 - mirrorActionLogRoot trust model after review-pass-2 round-2 fix.
// Root installs are owner-gated, with a witness sanity check as defense-in-depth.
//
// Coverage:
//   1. Owner-gate: non-owner call fails "Only owner".
//   2. Valid witness under a new (advanced) root: root advances.
//   3. Tampered witness (wrong Merkle sibling): EVENT_PROOF_INVALID.
//   4. Root that doesn't match the witness reconstruction: EVENT_PROOF_INVALID.
//   5. Self-consistent attacker-computed root+witness succeeds for owner.
//   6. The same forged bundle fails for non-owner.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeEbtFixture, doRegisterSchedule, doRetuneClass, doAdvanceEpoch,
  doRegisterLane, buildProof, statutorySplit, assertReverts, nonZero32,
  bufEq, reconstructActionLogRoot,
} from '../lib.mjs';

// Seed a registry with enough events that the on-chain root is well-defined.
function seedRegistryStage1() {
  const f = makeEbtFixture();
  const { fx, ebt } = f;
  const classPath = nonZero32(0x91);
  const { scheduleId, refRate } = doRegisterSchedule(fx, { effectiveEpoch: 1n, currentTime: 1_000_000n });
  doRetuneClass(fx, {
    scheduleId, classPath, split: statutorySplit(300),
    rate: refRate, nonceIn: 1n, currentTime: 1_000_100n,
  });
  doAdvanceEpoch(fx, 1_500_000n, refRate);
  const lane1 = doRegisterLane(fx, {
    scheduleId, laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 300,
    effectiveEpoch: 2n, currentTime: 1_500_100n, remittanceMode: 1, remitAddress: nonZero32(0x51),
  });
  return { fx, ebt, scheduleId, classPath, refRate, lane1 };
}

test('T19 valid witness under a new root advances the trust anchor', () => {
  const { fx, ebt, scheduleId, refRate, lane1 } = seedRegistryStage1();

  // Bootstrap the mirror with the current root, using lane1 as the witness.
  const bootProof = buildProof(fx.registry, lane1.seq);
  const bootEntry = fx.registry.getActionEntry(BigInt(lane1.seq));
  ebt.mirrorActionLogRoot({
    newRoot: fx.registry.registryActionLogRoot,
    sampleEntry: bootEntry, proof: bootProof,
  });
  const rootBoot = Buffer.from(ebt._registryActionLogRootMirror);

  // Advance the registry: register another lane. Root moves.
  const lane2 = doRegisterLane(fx, {
    scheduleId, laneKindByte: 1, leviedBy: nonZero32(0x42), bpsShare: 300,
    effectiveEpoch: 2n, currentTime: 1_500_200n, remittanceMode: 1, remitAddress: nonZero32(0x52),
  });
  const newRoot = fx.registry.registryActionLogRoot;
  assert.ok(!bufEq(newRoot, rootBoot), 'registry root should move after new event');

  // Install the new root using lane2 as the witness (any entry proven under
  // the new root works, including lane1 whose proof updates when the tree
  // grows). Use lane2 for clarity.
  const advProof = buildProof(fx.registry, lane2.seq);
  const advEntry = fx.registry.getActionEntry(BigInt(lane2.seq));
  ebt.mirrorActionLogRoot({
    newRoot, sampleEntry: advEntry, proof: advProof,
  });
  assert.ok(bufEq(ebt._registryActionLogRootMirror, newRoot),
            'mirrored root advanced to newRoot');
});

test('T19 non-owner cannot call mirrorActionLogRoot even with valid witness', () => {
  const { fx, ebt, lane1 } = seedRegistryStage1();
  const proof = buildProof(fx.registry, lane1.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane1.seq));

  assertReverts(
    () => ebt.mirrorActionLogRoot({
      newRoot: fx.registry.registryActionLogRoot,
      sampleEntry: entry,
      proof,
      caller: nonZero32(0xee),
    }),
    'Only owner',
  );
});

test('T19 tampered Merkle sibling -> EVENT_PROOF_INVALID', () => {
  const { fx, ebt, lane1 } = seedRegistryStage1();
  const proof = buildProof(fx.registry, lane1.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane1.seq));

  // Corrupt one sibling.
  const bad = { ...proof, siblings: proof.siblings.map(s => Buffer.from(s)) };
  bad.siblings[0][0] ^= 0xff;

  assertReverts(
    () => ebt.mirrorActionLogRoot({
      newRoot: fx.registry.registryActionLogRoot,
      sampleEntry: entry, proof: bad,
    }),
    'EVENT_PROOF_INVALID',
  );
});

test('T19 newRoot that does not match witness reconstruction -> EVENT_PROOF_INVALID', () => {
  const { fx, ebt, lane1 } = seedRegistryStage1();
  const proof = buildProof(fx.registry, lane1.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane1.seq));

  // Try to install a bogus root under a valid entry+witness. The witness
  // reconstructs to the real root, not the bogus root, so the assert fires.
  const bogusRoot = Buffer.alloc(32, 0xaa);
  assertReverts(
    () => ebt.mirrorActionLogRoot({
      newRoot: bogusRoot,
      sampleEntry: entry, proof,
    }),
    'EVENT_PROOF_INVALID',
  );
});

test('T19 owner can install self-consistent attacker-computed root+witness', () => {
  const { ebt } = makeEbtFixture();
  const payloadHash = nonZero32(0xa1);
  const siblings = Array.from({ length: 24 }, (_, i) => nonZero32((i + 1) & 0xff));
  const pathBits = Array.from({ length: 24 }, (_, i) => (i % 2) === 1);
  const forgedRoot = reconstructActionLogRoot(payloadHash, siblings, pathBits);
  const sampleEntry = { payloadHash: Buffer.from(payloadHash) };
  const proof = { actionSeq: 999n, payloadHash: Buffer.from(payloadHash), siblings, pathBits };

  ebt.mirrorActionLogRoot({ newRoot: forgedRoot, sampleEntry, proof });
  assert.ok(bufEq(ebt._registryActionLogRootMirror, forgedRoot));
});

test('T19 non-owner cannot install self-consistent attacker-computed root+witness', () => {
  const { ebt } = makeEbtFixture();
  const payloadHash = nonZero32(0xb1);
  const siblings = Array.from({ length: 24 }, (_, i) => nonZero32((0xc0 + i) & 0xff));
  const pathBits = Array.from({ length: 24 }, (_, i) => (i % 3) === 0);
  const forgedRoot = reconstructActionLogRoot(payloadHash, siblings, pathBits);
  const sampleEntry = { payloadHash: Buffer.from(payloadHash) };
  const proof = { actionSeq: 1000n, payloadHash: Buffer.from(payloadHash), siblings, pathBits };

  assertReverts(
    () => ebt.mirrorActionLogRoot({
      newRoot: forgedRoot,
      sampleEntry,
      proof,
      caller: nonZero32(0xef),
    }),
    'Only owner',
  );
});
