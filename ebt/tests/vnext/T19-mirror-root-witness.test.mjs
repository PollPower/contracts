// T19 - mirrorActionLogRoot is witness-gated (review-pass-1 fix,
// VNEXT-DESIGN §3.2 / §7.1 option iii). The trust anchor for every other
// mirror-write's EventProof is no longer owner-only; the caller must supply
// a real registry entry + inclusion witness that reconstructs to the new
// root. Fake roots require forging a Merkle proof under the hash assumption.
//
// Coverage:
//   1. Valid witness under a new (advanced) root: root advances.
//   2. Tampered witness (wrong Merkle sibling): EVENT_PROOF_INVALID.
//   3. Root that doesn't match the witness reconstruction:
//      EVENT_PROOF_INVALID.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeEbtFixture, doRegisterSchedule, doRetuneClass, doAdvanceEpoch,
  doRegisterLane, buildProof, statutorySplit, assertReverts, nonZero32,
  bufEq,
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
