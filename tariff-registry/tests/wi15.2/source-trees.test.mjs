import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  pad32,
  persistentHash,
  u64ToBytes32,
  u16ToBytes32,
  bufEq,
} from '../lib.mjs';

const TREE_DEPTH = 20;

function bitsFromSeq(seq, depth = TREE_DEPTH) {
  const out = [];
  let v = BigInt(seq);
  for (let i = 0; i < depth; i++) {
    out.push((v & 1n) === 1n);
    v >>= 1n;
  }
  return out;
}

class IncrementalTree {
  constructor(emptyLeafTag, nodeTag, depth = TREE_DEPTH) {
    this.depth = depth;
    this.nodeTag = pad32(nodeTag);
    this.zeros = [];
    this.frontier = [];
    this.leaves = [];

    let z = pad32(emptyLeafTag);
    for (let i = 0; i < depth; i++) {
      this.zeros[i] = z;
      this.frontier[i] = z;
      z = persistentHash([this.nodeTag, z, z]);
    }
    this.root = z;
  }

  append(leaf) {
    const seq = this.leaves.length;
    this.leaves.push(Buffer.from(leaf));
    const bits = bitsFromSeq(seq, this.depth);
    let climb = Buffer.from(leaf);
    for (let i = 0; i < this.depth; i++) {
      const bit = bits[i];
      const sib = bit ? this.frontier[i] : this.zeros[i];
      if (!bit) this.frontier[i] = climb;
      climb = bit
        ? persistentHash([this.nodeTag, sib, climb])
        : persistentHash([this.nodeTag, climb, sib]);
    }
    this.root = climb;
    return BigInt(seq);
  }

  proof(seq) {
    const bits = bitsFromSeq(seq, this.depth);
    const siblings = [];
    for (let i = 0; i < this.depth; i++) {
      let sibling;
      if (!bits[i]) {
        sibling = this.zeros[i];
      } else {
        const leftIndex = Number(BigInt(seq) & ~((1n << BigInt(i + 1)) - 1n));
        sibling = this.nodeAtLevel(leftIndex, i);
      }
      siblings.push(Buffer.from(sibling));
    }
    return { siblings, bits };
  }

  nodeAtLevel(startLeaf, level) {
    let width = 1 << level;
    let acc = this.leaves[startLeaf] ?? this.zeros[0];
    for (let j = 1; j < width; j++) {
      const nxt = this.leaves[startLeaf + j] ?? this.zeros[0];
      acc = persistentHash([this.nodeTag, acc, nxt]);
    }
    for (let i = 0; i < level; i++) {
      acc = persistentHash([this.nodeTag, acc, this.zeros[i]]);
    }
    return acc;
  }
}

function reconstructRoot(nodeTag, leaf, siblings, bits) {
  const tag = pad32(nodeTag);
  let h = Buffer.from(leaf);
  for (let i = 0; i < siblings.length; i++) {
    h = bits[i]
      ? persistentHash([tag, siblings[i], h])
      : persistentHash([tag, h, siblings[i]]);
  }
  return h;
}

function scheduleRecordHash(r) {
  return persistentHash([
    pad32('pp:tariff:v1:scheduleRecord'),
    r.scheduleId,
    r.nodeId,
    r.scheduleHash,
    r.operatorPubkey,
    u64ToBytes32(r.effectiveEpoch),
    u64ToBytes32(r.retiredEpoch),
    u64ToBytes32(r.refRateFiatPerKwh),
    u64ToBytes32(r.registeredAt),
  ]);
}

function laneRecordHash(r) {
  return persistentHash([
    pad32('pp:tariff:v1:laneRecord'),
    r.scheduleId,
    u64ToBytes32(r.laneKindByte),
    r.leviedBy,
    u16ToBytes32(r.bpsShare),
    r.remitAddress,
    u64ToBytes32(r.basis),
    r.applicabilityHash,
    r.statuteRefHash,
    u64ToBytes32(r.effectiveEpoch),
    u64ToBytes32(r.retiredEpoch),
    u64ToBytes32(r.remittanceMode),
    u64ToBytes32(r.registeredAt),
  ]);
}

function classEntryHash(c) {
  return persistentHash([
    pad32('pp:tariff:v1:classEntry'),
    u16ToBytes32(c.bps.producerShareBps),
    u16ToBytes32(c.bps.ldShareBps),
    u16ToBytes32(c.bps.opsShareBps),
    u16ToBytes32(c.bps.daoShareBps),
    u16ToBytes32(c.bps.operatorMarginBps),
    u16ToBytes32(c.bps.statutoryTotalBps),
    u64ToBytes32(c.rateFiatPerKwh),
    u64ToBytes32(c.lastUpdatedAt),
  ]);
}

test('schedule source tree: register/retire mutations change root and proofs reconstruct', () => {
  const t = new IncrementalTree('pp:tariff:v1:schedulesEmpty', 'pp:tariff:v1:schedulesNode');
  const startRoot = Buffer.from(t.root);
  const scheduleId = randomBytes(32);
  const base = {
    scheduleId,
    nodeId: randomBytes(32),
    scheduleHash: randomBytes(32),
    operatorPubkey: randomBytes(32),
    effectiveEpoch: 4n,
    retiredEpoch: 0n,
    refRateFiatPerKwh: 40_000_000n,
    registeredAt: 1_700_000_000n,
  };

  const leaf0 = persistentHash([pad32('pp:tariff:v1:schedulesLeaf'), scheduleId, scheduleRecordHash(base)]);
  const seq0 = t.append(leaf0);
  assert.ok(!bufEq(startRoot, t.root), 'register must change root');
  const p0 = t.proof(seq0);
  assert.ok(bufEq(reconstructRoot('pp:tariff:v1:schedulesNode', leaf0, p0.siblings, p0.bits), t.root));

  const retired = { ...base, retiredEpoch: 6n };
  const leaf1 = persistentHash([pad32('pp:tariff:v1:schedulesLeaf'), scheduleId, scheduleRecordHash(retired)]);
  const prevRoot = Buffer.from(t.root);
  const seq1 = t.append(leaf1);
  assert.ok(!bufEq(prevRoot, t.root), 'retire must change root');
  const p1 = t.proof(seq1);
  assert.ok(bufEq(reconstructRoot('pp:tariff:v1:schedulesNode', leaf1, p1.siblings, p1.bits), t.root));
});

test('lane source tree: register/retire mutations change root and proofs reconstruct', () => {
  const t = new IncrementalTree('pp:tariff:v1:lanesEmpty', 'pp:tariff:v1:lanesNode');
  const laneKey = randomBytes(32);
  const rec = {
    scheduleId: randomBytes(32),
    laneKindByte: 1n,
    leviedBy: randomBytes(32),
    bpsShare: 500,
    remitAddress: randomBytes(32),
    basis: 0n,
    applicabilityHash: randomBytes(32),
    statuteRefHash: randomBytes(32),
    effectiveEpoch: 4n,
    retiredEpoch: 0n,
    remittanceMode: 0n,
    registeredAt: 1_700_000_100n,
  };
  const leaf0 = persistentHash([pad32('pp:tariff:v1:lanesLeaf'), laneKey, laneRecordHash(rec)]);
  const root0 = Buffer.from(t.root);
  const seq0 = t.append(leaf0);
  assert.ok(!bufEq(root0, t.root), 'register lane must change root');
  const p0 = t.proof(seq0);
  assert.ok(bufEq(reconstructRoot('pp:tariff:v1:lanesNode', leaf0, p0.siblings, p0.bits), t.root));

  const retired = { ...rec, retiredEpoch: 7n };
  const leaf1 = persistentHash([pad32('pp:tariff:v1:lanesLeaf'), laneKey, laneRecordHash(retired)]);
  const root1 = Buffer.from(t.root);
  const seq1 = t.append(leaf1);
  assert.ok(!bufEq(root1, t.root), 'retire lane must change root');
  const p1 = t.proof(seq1);
  assert.ok(bufEq(reconstructRoot('pp:tariff:v1:lanesNode', leaf1, p1.siblings, p1.bits), t.root));
});

test('class-entries source tree: retune mutation changes root and proof reconstructs', () => {
  const t = new IncrementalTree('pp:tariff:v1:classEntriesEmpty', 'pp:tariff:v1:classEntriesNode');
  const classKey = randomBytes(32);
  const ce = {
    bps: {
      producerShareBps: 4000,
      ldShareBps: 200,
      opsShareBps: 2000,
      daoShareBps: 1000,
      operatorMarginBps: 800,
      statutoryTotalBps: 2000,
    },
    rateFiatPerKwh: 40_000_000n,
    lastUpdatedAt: 1_700_000_200n,
  };
  const leaf = persistentHash([pad32('pp:tariff:v1:classEntriesLeaf'), classKey, classEntryHash(ce)]);
  const oldRoot = Buffer.from(t.root);
  const seq = t.append(leaf);
  assert.ok(!bufEq(oldRoot, t.root), 'retune class must change root');
  const p = t.proof(seq);
  assert.ok(bufEq(reconstructRoot('pp:tariff:v1:classEntriesNode', leaf, p.siblings, p.bits), t.root));
});
