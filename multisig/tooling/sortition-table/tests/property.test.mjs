// multisig/tooling/sortition-table/tests/property.test.mjs
// -----------------------------------------------------------------------------
// Property test: 1000 random valid tables x seeds. For each:
//   - buildCanonicalTable succeeds and yields a stable membershipRoot
//     (re-running is byte-identical: determinism, invariant #1).
//   - runDraw terminates in bounded k
//   - Result is exactly 5 distinct memberAddrs, all from the drawable rows
//   - auditDraw returns MATCH for the drawn selected[5]
//   - Substituting any one incoming[j] with any OTHER drawable-row address
//     makes auditDraw return MISMATCH with firstDivergenceIndex == j
//
// PRNG is seeded from a fixed string so this test is fully deterministic and
// reproducible across platforms. All bytes are chosen via SHA-256(counter),
// which also matches the spec's insistence that byte-identical outputs come
// from byte-identical inputs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildCanonicalTable,
  runDraw,
  auditDraw,
  toHex,
  canonAddr,
  COUNCIL_SIZE,
} from '../lib.mjs';

// A small deterministic byte-stream RNG. Blocks of 32 bytes from
// SHA-256("pp:wi15:property-test:" || u64be(counter)); counter increments per
// block. Fully reproducible.
class DetRng {
  constructor(seedLabel = 'pp:wi15:property-test:v1') {
    this.label = seedLabel;
    this.counter = 0n;
    this.block = Buffer.alloc(0);
    this.bIdx = 0;
  }
  _refill() {
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(this.counter, 0);
    this.counter++;
    this.block = createHash('sha256').update(this.label).update(c).digest();
    this.bIdx = 0;
  }
  bytes(n) {
    const out = Buffer.alloc(n);
    let i = 0;
    while (i < n) {
      if (this.bIdx >= this.block.length) this._refill();
      const take = Math.min(n - i, this.block.length - this.bIdx);
      this.block.copy(out, i, this.bIdx, this.bIdx + take);
      this.bIdx += take;
      i += take;
    }
    return out;
  }
  intInRange(min, max) {
    // Uniform in [min, max) via 6-byte draw modulo (small bias, adequate for
    // property tests).
    const span = max - min;
    const raw = this.bytes(6);
    let x = 0;
    for (const b of raw) x = x * 256 + b;
    return min + (x % span);
  }
  hex32() {
    return toHex(this.bytes(32));
  }
}

// A single random valid snapshot. n in [5..20], weights in [1..5] (small,
// avoids MAX_SAFE_INTEGER concerns), all addresses distinct.
function randomSnapshot(rng) {
  const n = rng.intInRange(COUNCIL_SIZE, 21); // 5..20 inclusive
  const rows = [];
  const seen = new Set();
  while (rows.length < n) {
    const addr = rng.hex32();
    const canon = canonAddr(addr);
    if (seen.has(canon)) continue;
    seen.add(canon);
    rows.push({
      memberAddr: canon,
      weight: rng.intInRange(1, 6), // 1..5 inclusive
    });
  }
  const epoch = rng.intInRange(1, 1_000_000);
  return { epoch, rows };
}

test('property: 1000 random tables x seeds — build + draw invariants hold', () => {
  const rng = new DetRng('pp:wi15:property-test:main');
  const N = 1000;

  for (let iter = 0; iter < N; iter++) {
    const snap = randomSnapshot(rng);
    const table = buildCanonicalTable(snap);

    // Determinism: second build yields byte-identical rows + root.
    const table2 = buildCanonicalTable(snap);
    assert.equal(table2.membershipRoot, table.membershipRoot,
      `iter ${iter}: determinism — membershipRoot must be stable across runs`);
    for (let i = 0; i < table.rows.length; i++) {
      assert.equal(table2.rows[i].leafHash, table.rows[i].leafHash,
        `iter ${iter}: determinism — leafHash[${i}]`);
      assert.equal(table2.rows[i].cumulative, table.rows[i].cumulative,
        `iter ${iter}: determinism — cumulative[${i}]`);
    }

    // Canonical order: rows sorted ascending by memberAddr bytes.
    for (let i = 1; i < table.rows.length; i++) {
      const a = Buffer.from(table.rows[i - 1].memberAddr.slice(2), 'hex');
      const b = Buffer.from(table.rows[i].memberAddr.slice(2), 'hex');
      assert.ok(Buffer.compare(a, b) < 0,
        `iter ${iter}: canonical order violated at row ${i}`);
    }
    // Cumulative monotone strictly increasing, ends at totalWeight.
    for (let i = 0; i < table.rows.length; i++) {
      if (i > 0) {
        assert.ok(table.rows[i].cumulative > table.rows[i - 1].cumulative,
          `iter ${iter}: cumulative not strictly increasing at ${i}`);
      }
    }
    assert.equal(table.rows[table.rows.length - 1].cumulative, table.totalWeight,
      `iter ${iter}: cumulative[last] != totalWeight`);

    // Draw: terminates, returns exactly 5 distinct, all from the table.
    const seed = rng.hex32();
    const draw = runDraw(table.rows, seed);
    assert.equal(draw.selected.length, COUNCIL_SIZE,
      `iter ${iter}: draw must return exactly ${COUNCIL_SIZE} members`);
    const distinct = new Set(draw.selected);
    assert.equal(distinct.size, COUNCIL_SIZE,
      `iter ${iter}: draw must return ${COUNCIL_SIZE} DISTINCT members`);
    const tableAddrs = new Set(table.rows.map((r) => r.memberAddr));
    for (const a of draw.selected) {
      assert.ok(tableAddrs.has(a), `iter ${iter}: draw returned address not in table: ${a}`);
    }

    // Audit round-trip: MATCH for the drawn selected.
    const good = auditDraw({ table, seed, claimedIncoming: draw.selected });
    assert.equal(good.verdict, 'MATCH', `iter ${iter}: audit round-trip should MATCH`);

    // Single-substitution: MISMATCH with firstDivergenceIndex == j.
    // Pick a substitute address that is a drawable-row member but not
    // draw.selected[j].
    const j = rng.intInRange(0, COUNCIL_SIZE);
    const substitute = table.rows.find((r) => r.memberAddr !== draw.selected[j])?.memberAddr;
    assert.ok(substitute, `iter ${iter}: could not find substitute row (n too small?)`);
    const badIncoming = [...draw.selected];
    badIncoming[j] = substitute;
    const bad = auditDraw({ table, seed, claimedIncoming: badIncoming });
    assert.equal(bad.verdict, 'MISMATCH',
      `iter ${iter}: substitution at ${j} must MISMATCH`);
    assert.equal(bad.firstDivergenceIndex, j,
      `iter ${iter}: firstDivergenceIndex for substitution at ${j}`);
  }
});

test('property: precondition n<5 is rejected by build-table', () => {
  // buildCanonicalTable itself accepts n<5 rows (it is a byte layout function),
  // but the CLI wrapper (build-table.mjs) enforces n>=5. Here we exercise the
  // runDraw path — the second gate — which must reject n<5.
  const rng = new DetRng('pp:wi15:property-test:precondition');
  for (const n of [0, 1, 2, 3, 4]) {
    if (n === 0) {
      // n=0 has no rows to sort/index; skip runDraw and just confirm layout.
      const t = buildCanonicalTable({ epoch: 1, rows: [] });
      assert.equal(t.n, 0);
      continue;
    }
    const rows = [];
    const seen = new Set();
    while (rows.length < n) {
      const addr = rng.hex32();
      const c = canonAddr(addr);
      if (seen.has(c)) continue;
      seen.add(c);
      rows.push({ memberAddr: c, weight: 1 });
    }
    const t = buildCanonicalTable({ epoch: 42, rows });
    assert.throws(() => runDraw(t.rows, rng.hex32()),
      /precondition violated/,
      `n=${n}: runDraw must reject on n<5`);
  }
});
