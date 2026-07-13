// multisig/tooling/sortition-table/tests/vectors.test.mjs
// -----------------------------------------------------------------------------
// Byte-for-byte agreement with the committed vectors is the primary acceptance
// gate for this tool (WI-15 invariants #1 and #2). Each vector A–F is run end
// to end:
//
//   - The canonical table is rebuilt from the vector's rows and the
//     membershipRoot + per-row leafHash MUST match the committed values.
//   - The draw is replayed from (table, seed) and the resulting selected[5]
//     MUST match the committed expected.selected for positive vectors.
//   - Vector F (deliberately wrong incoming[5]) MUST be REJECTED with
//     firstDivergenceIndex naming the exact wrong index.
//
// If any assertion fails, the tool disagrees with the spec generator on some
// byte-level detail. That is either a bug in this tool or (per §8) a spec
// ambiguity — either way, do not paper over it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildCanonicalTable,
  runDraw,
  auditDraw,
  padLeafHash,
  toHex,
  canonAddr,
  COUNCIL_SIZE,
} from '../lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = resolve(HERE, '..', '..', 'draw-spec-vectors.json');

async function loadVectors() {
  const raw = await readFile(VECTORS_PATH, 'utf8');
  return JSON.parse(raw);
}

test('spec header — the committed vectors are v1 SHA-256', async () => {
  const vs = await loadVectors();
  assert.equal(vs.specVersion, 'pp-sortition-draw-spec/v1');
  assert.equal(vs.hashPrimitive, 'SHA-256');
  assert.equal(vs.domainTags.leaf, 'pp:sortition:leaf:v1');
  assert.equal(vs.domainTags.node, 'pp:sortition:node:v1');
  assert.equal(vs.domainTags.pad, 'pp:sortition:pad:v1');
  assert.equal(vs.domainTags.draw, 'pp:sortition:draw:v1');
  assert.equal(vs.domainTags.beacon, 'pp:sortition:beacon:v1');
  // The pad sentinel is a spec-fixed constant; nail it down here so a
  // regression in padLeafHash() is caught immediately.
  const expectedPad = vs.vectors[0].table.padSentinelLeafHash;
  assert.equal(toHex(padLeafHash()), expectedPad,
    'padLeafHash() must equal the committed vector A pad sentinel');
});

test('every vector A–F: build-table reproduces membershipRoot + every leafHash', async () => {
  const vs = await loadVectors();
  for (const v of vs.vectors) {
    const snapshot = {
      epoch: v.table.epoch,
      rows: v.table.rows.map((r) => ({
        memberAddr: r.memberAddr,
        weight: r.weight,
      })),
    };
    const rebuilt = buildCanonicalTable(snapshot);

    assert.equal(rebuilt.n, v.table.n, `vector ${v.id}: n mismatch`);
    assert.equal(rebuilt.paddedLeafCount, v.table.paddedLeafCount,
      `vector ${v.id}: paddedLeafCount mismatch`);
    assert.equal(rebuilt.padSentinelLeafHash, v.table.padSentinelLeafHash,
      `vector ${v.id}: padSentinelLeafHash mismatch`);
    assert.equal(rebuilt.totalWeight, v.table.totalWeight,
      `vector ${v.id}: totalWeight mismatch`);
    assert.equal(rebuilt.membershipRoot, v.table.membershipRoot,
      `vector ${v.id}: membershipRoot mismatch (byte-level spec disagreement)`);

    for (let i = 0; i < v.table.rows.length; i++) {
      assert.equal(rebuilt.rows[i].index, v.table.rows[i].index,
        `vector ${v.id}: row ${i} index mismatch`);
      assert.equal(rebuilt.rows[i].memberAddr, v.table.rows[i].memberAddr,
        `vector ${v.id}: row ${i} memberAddr mismatch (canonical order?)`);
      assert.equal(rebuilt.rows[i].weight, v.table.rows[i].weight,
        `vector ${v.id}: row ${i} weight mismatch`);
      assert.equal(rebuilt.rows[i].cumulative, v.table.rows[i].cumulative,
        `vector ${v.id}: row ${i} cumulative mismatch`);
      assert.equal(rebuilt.rows[i].leafHash, v.table.rows[i].leafHash,
        `vector ${v.id}: row ${i} leafHash mismatch (leaf encoding disagreement)`);
    }
  }
});

test('positive vectors (A, B, C, D, E): draw reproduces expected selected[5] and kConsumed', async () => {
  const vs = await loadVectors();
  for (const v of vs.vectors) {
    if (v.id === 'F') continue; // negative vector, tested separately
    const draw = runDraw(v.table.rows, v.seed);
    assert.equal(draw.selected.length, COUNCIL_SIZE,
      `vector ${v.id}: draw must return exactly ${COUNCIL_SIZE} members`);
    assert.deepEqual(draw.selected, v.expected.selected,
      `vector ${v.id}: selected[5] mismatch (draw disagrees with spec)`);
    assert.equal(draw.kConsumed, v.expected.kConsumed,
      `vector ${v.id}: kConsumed mismatch (draw trace divergence)`);
    // Cross-check the full k-sequence trace — a divergence anywhere in
    // (k, pick, winnerIndex, accepted) is a spec disagreement worth naming.
    for (let i = 0; i < draw.kSequence.length; i++) {
      const a = draw.kSequence[i];
      const b = v.expected.kSequence[i];
      assert.equal(a.k, b.k, `vector ${v.id}: kSequence[${i}].k`);
      assert.equal(a.hashHex, b.hashHex, `vector ${v.id}: kSequence[${i}].hashHex`);
      assert.equal(a.pick, b.pick, `vector ${v.id}: kSequence[${i}].pick`);
      assert.equal(a.winnerIndex, b.winnerIndex, `vector ${v.id}: kSequence[${i}].winnerIndex`);
      assert.equal(a.winnerAddr, b.winnerAddr, `vector ${v.id}: kSequence[${i}].winnerAddr`);
      assert.equal(a.accepted, b.accepted, `vector ${v.id}: kSequence[${i}].accepted`);
    }
  }
});

test('positive vectors: auditDraw returns MATCH for the correct claimed incoming[5]', async () => {
  const vs = await loadVectors();
  for (const v of vs.vectors) {
    if (v.id === 'F') continue;
    const verdict = auditDraw({
      table: v.table,
      seed: v.seed,
      claimedIncoming: v.expected.selected,
    });
    assert.equal(verdict.verdict, 'MATCH', `vector ${v.id}: expected MATCH, got ${verdict.verdict}`);
    assert.deepEqual(verdict.selected, v.expected.selected,
      `vector ${v.id}: auditDraw selected mismatch`);
  }
});

test('vector F: auditDraw REJECTS the wrong claimed incoming[5] and names the divergence', async () => {
  const vs = await loadVectors();
  const v = vs.vectors.find((x) => x.id === 'F');
  assert.ok(v, 'vector F must exist');
  const verdict = auditDraw({
    table: v.table,
    seed: v.seed,
    claimedIncoming: v.claimedIncoming,
  });
  assert.equal(verdict.verdict, 'MISMATCH', 'vector F must be REJECTED');
  assert.equal(verdict.firstDivergenceIndex, v.expected.firstDivergenceIndex,
    'vector F: firstDivergenceIndex must match spec generator');
  assert.deepEqual(verdict.correctSelected, v.expected.correctSelected.map(canonAddr),
    'vector F: correctSelected must match spec generator');
  // The rejectionReason string is human-readable; assert only the shape:
  assert.match(verdict.rejectionReason, /^claimed incoming\[\d\] = 0x[0-9a-f]{64} but /);
});

test('single-member substitution ANYWHERE in incoming is caught by auditDraw', async () => {
  // Sensitivity check: for each positive vector, try substituting each index
  // with an address that is NOT the correct one. auditDraw must REJECT and
  // name the exact divergence index. This is broader than vector F's fixed
  // swap and covers invariant #4 of the WI-15 brief.
  const vs = await loadVectors();
  for (const v of vs.vectors) {
    if (v.id === 'F') continue;
    const correct = v.expected.selected;
    // Pick an address that appears in the table but not at every position of
    // selected[]. Any table row that is not `correct[j]` works.
    for (let j = 0; j < COUNCIL_SIZE; j++) {
      const substitute = v.table.rows.find((r) => r.memberAddr !== correct[j]);
      assert.ok(substitute, `vector ${v.id}: no substitute row found for index ${j}`);
      const claimed = [...correct];
      claimed[j] = substitute.memberAddr;
      const verdict = auditDraw({ table: v.table, seed: v.seed, claimedIncoming: claimed });
      assert.equal(verdict.verdict, 'MISMATCH',
        `vector ${v.id}: substitution at index ${j} should MISMATCH`);
      assert.equal(verdict.firstDivergenceIndex, j,
        `vector ${v.id}: firstDivergenceIndex for substitution at ${j}`);
    }
  }
});
