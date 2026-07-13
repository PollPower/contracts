#!/usr/bin/env node
// gen-draw-spec-vectors.mjs
// -----------------------------------------------------------------------------
// Reference generator for SORTITION-DRAW-SPEC/v1 test vectors.
//
// This script is the SOURCE OF TRUTH for multisig/tooling/draw-spec-vectors.json.
// It implements the spec verbatim (§1.1 leaf encoding, Merkle tree with
// domain-separated internal-node hash and sentinel padding, §2 deterministic
// draw with rejection-on-collision) and emits vectors covering:
//   (a) minimal table n=5
//   (b) non-power-of-two leaf count exercising padding
//   (c) a seed that triggers at least one collision (rejection path)
//   (d) equal-weight gate policy table
//   (e) a table containing one federation-seat row
//   (f) a deliberately WRONG incoming[5] the auditor must REJECT
//
// Regenerate the vectors file with:
//     node multisig/tooling/gen-draw-spec-vectors.mjs > \
//         multisig/tooling/draw-spec-vectors.json
//
// Any change to this script's output is a spec change; bump SPEC_VERSION and
// document it in SORTITION-DRAW-SPEC.md.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

const SPEC_VERSION = 'pp-sortition-draw-spec/v1';
const HASH_PRIMITIVE = 'SHA-256';

// ---------------------------------------------------------------------------
// Domain tags — MUST match SORTITION-TABLE-DESIGN.md verbatim.
// ---------------------------------------------------------------------------
const TAG_LEAF   = 'pp:sortition:leaf:v1';
const TAG_NODE   = 'pp:sortition:node:v1';
const TAG_PAD    = 'pp:sortition:pad:v1';
const TAG_DRAW   = 'pp:sortition:draw:v1';
const TAG_BEACON = 'pp:sortition:beacon:v1'; // reserved; not consumed here.

// ---------------------------------------------------------------------------
// Byte-level helpers (all big-endian per §1.1 / §2).
// ---------------------------------------------------------------------------
function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    if (typeof p === 'string') h.update(Buffer.from(p, 'utf8'));
    else if (Buffer.isBuffer(p)) h.update(p);
    else if (p instanceof Uint8Array) h.update(Buffer.from(p));
    else throw new Error('sha256: unsupported input type ' + typeof p);
  }
  return h.digest();
}

function u64be(n) {
  if (typeof n === 'number') n = BigInt(n);
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(Number(n), 0);
  return b;
}

function hexToBytes(hex) {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length !== 64) throw new Error('memberAddr must be 32 bytes (64 hex chars), got ' + hex.length);
  return Buffer.from(hex, 'hex');
}

function toHex(buf) { return '0x' + Buffer.from(buf).toString('hex'); }

// ---------------------------------------------------------------------------
// §1.1 Leaf encoding.
//   leaf = SHA-256( "pp:sortition:leaf:v1"
//                 || epoch  (8B BE)
//                 || index  (4B BE)
//                 || memberAddr (32B)
//                 || weight (8B BE) )
// ---------------------------------------------------------------------------
function leafHash({ epoch, index, memberAddr, weight }) {
  return sha256(
    TAG_LEAF,
    u64be(epoch),
    u32be(index),
    hexToBytes(memberAddr),
    u64be(weight),
  );
}

// Sentinel padding leaf — value has no per-slot data; padded leaves are
// undrawable because their weight is 0 and they do not appear in the
// cumulative axis.
function paddingLeafHash() {
  return sha256(TAG_PAD);
}

// ---------------------------------------------------------------------------
// Merkle tree — binary, domain-separated internal-node hash, next-power-of-two
// padding using the sentinel leaf.
// ---------------------------------------------------------------------------
function nextPow2(n) {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function internalNode(left, right) {
  return sha256(TAG_NODE, left, right);
}

function computeRoot(leafHashes) {
  const target = nextPow2(leafHashes.length);
  const pad = paddingLeafHash();
  const level = [];
  for (let i = 0; i < target; i++) {
    level.push(i < leafHashes.length ? leafHashes[i] : pad);
  }
  let cur = level;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(internalNode(cur[i], cur[i + 1]));
    }
    cur = next;
  }
  return cur[0];
}

// ---------------------------------------------------------------------------
// §1.2 Canonical ordering — ascending by memberAddr bytes.
// Weights are taken as given (input); this function assigns indices and
// cumulative sums after the sort.
// ---------------------------------------------------------------------------
function canonicaliseTable(rows) {
  const sorted = [...rows].sort((a, b) => {
    const A = hexToBytes(a.memberAddr);
    const B = hexToBytes(b.memberAddr);
    return Buffer.compare(A, B);
  });
  let cum = 0n;
  return sorted.map((r, i) => {
    cum += BigInt(r.weight);
    return {
      index: i,
      memberAddr: r.memberAddr.startsWith('0x') ? r.memberAddr : '0x' + r.memberAddr,
      weight: r.weight,
      cumulative: Number(cum),
      note: r.note ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// §2 Deterministic draw.
//   k = 0; while (|selected| < 5):
//     pick = SHA-256("pp:sortition:draw:v1" || seed || u32be(k)) mod totalWeight
//     winner = smallest i s.t. pick < cumulative[i]
//     if winner.memberAddr in selected: k += 1; continue   // rejection sample
//     selected.push(winner.memberAddr); k += 1
// ---------------------------------------------------------------------------
function bytesToBigInt(buf) {
  // Big-endian byte string -> unsigned BigInt.
  let x = 0n;
  for (const b of buf) x = (x << 8n) | BigInt(b);
  return x;
}

function drawStep(seedHex, k) {
  const seed = hexToBytes(seedHex);
  const digest = sha256(TAG_DRAW, seed, u32be(k));
  return { digest, digestInt: bytesToBigInt(digest) };
}

function binarySearchCumulative(table, pick) {
  // Smallest i such that pick < cumulative[i]. Assumes cumulative is
  // strictly increasing over drawable (weight > 0) leaves. In these vectors
  // the caller supplies only drawable rows (padding is not in the table).
  let lo = 0, hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(table[mid].cumulative) <= pick) lo = mid + 1;
    else hi = mid;
  }
  return table[lo];
}

function runDraw(table, seedHex, want = 5) {
  const totalWeight = BigInt(table[table.length - 1].cumulative);
  const selected = [];
  const kSequence = [];
  let k = 0;
  // Safety cap: with n>=5 distinct members, termination is guaranteed, but
  // bound the loop to catch spec-violating inputs during test generation.
  const MAX_K = 10_000;
  while (selected.length < want) {
    if (k >= MAX_K) throw new Error('draw: exceeded MAX_K; input violates n>=5 distinct precondition');
    const { digest, digestInt } = drawStep(seedHex, k);
    const pick = digestInt % totalWeight;
    const winner = binarySearchCumulative(table, pick);
    const isCollision = selected.includes(winner.memberAddr);
    kSequence.push({
      k,
      hashHex: toHex(digest),
      pick: pick.toString(),
      winnerIndex: winner.index,
      winnerAddr: winner.memberAddr,
      accepted: !isCollision,
      reason: isCollision ? 'collision (already selected) -> advance k' : 'accepted',
    });
    if (!isCollision) selected.push(winner.memberAddr);
    k += 1;
  }
  return {
    totalWeight: totalWeight.toString(),
    selected,
    kSequence,
    kConsumed: k,
  };
}

// ---------------------------------------------------------------------------
// Build a full table artefact from raw rows + epoch.
// ---------------------------------------------------------------------------
function buildTable({ epoch, rows }) {
  const canonical = canonicaliseTable(rows);
  const leafHashes = canonical.map((r) =>
    leafHash({ epoch, index: r.index, memberAddr: r.memberAddr, weight: r.weight }),
  );
  const padded = nextPow2(canonical.length);
  const root = computeRoot(leafHashes);
  return {
    epoch,
    n: canonical.length,
    paddedLeafCount: padded,
    padSentinelLeafHash: toHex(paddingLeafHash()),
    rows: canonical.map((r, i) => ({
      index: r.index,
      memberAddr: r.memberAddr,
      weight: r.weight,
      cumulative: r.cumulative,
      leafHash: toHex(leafHashes[i]),
      note: r.note,
    })),
    totalWeight: canonical.reduce((a, r) => a + r.weight, 0),
    membershipRoot: toHex(root),
  };
}

// ---------------------------------------------------------------------------
// Fixed test addresses (32-byte, big-endian labels for readability).
// These are OPAQUE test vectors — not real keys. Chosen to exercise the
// canonical sort (varied leading bytes) and to be memorable in the doc.
// ---------------------------------------------------------------------------
const ADDR = {
  alice:      '0x11' + '00'.repeat(30) + 'a1', // starts with 0x11
  bob:        '0x22' + '00'.repeat(30) + 'b2',
  clusterW:   '0x33' + '00'.repeat(30) + 'c3', // federation-seat row (lower-tier council addr)
  dembe:      '0x44' + '00'.repeat(30) + 'd4',
  esther:     '0x55' + '00'.repeat(30) + 'e5',
  farida:     '0x66' + '00'.repeat(30) + 'f6',
  gita:       '0x77' + '00'.repeat(30) + '77',
  hasan:      '0x88' + '00'.repeat(30) + '88',
};

// A deterministic seed for the worked example (matches vector A). 32 bytes,
// derived by hashing a fixed string so it is reproducible without importing
// any beacon:
const SEED_A = toHex(sha256('pp:test:seed:A')); // vector (a) & worked example
const SEED_D = toHex(sha256('pp:test:seed:D')); // vector (d) reuses A's table with a new seed for variety
const SEED_E = toHex(sha256('pp:test:seed:E')); // vector (e) — federation row

// ---------------------------------------------------------------------------
// Collision-search: try incrementing counter seeds until the draw takes at
// least one collision (rejection) step. Deterministic and reproducible.
// ---------------------------------------------------------------------------
function findCollisionSeed(table, label) {
  for (let i = 0; i < 1_000_000; i++) {
    const seed = toHex(sha256(`pp:test:seed:${label}:${i}`));
    const draw = runDraw(table, seed);
    const collisions = draw.kSequence.filter((s) => !s.accepted).length;
    if (collisions >= 1) return { seed, tries: i + 1, draw };
  }
  throw new Error('collision search exhausted');
}

// ===========================================================================
// Vector definitions
// ===========================================================================

// (a) MINIMAL TABLE n=5, equal weights, seed = SEED_A.
const rowsA = [
  { memberAddr: ADDR.alice,  weight: 1 },
  { memberAddr: ADDR.bob,    weight: 1 },
  { memberAddr: ADDR.dembe,  weight: 1 },
  { memberAddr: ADDR.esther, weight: 1 },
  { memberAddr: ADDR.farida, weight: 1 },
];
const tableA = buildTable({ epoch: 7, rows: rowsA });
const drawA = runDraw(tableA.rows, SEED_A);

// (b) NON-POWER-OF-TWO leaf count (n=6): exercises padding.
const rowsB = [
  { memberAddr: ADDR.alice,  weight: 1 },
  { memberAddr: ADDR.bob,    weight: 1 },
  { memberAddr: ADDR.dembe,  weight: 1 },
  { memberAddr: ADDR.esther, weight: 1 },
  { memberAddr: ADDR.farida, weight: 1 },
  { memberAddr: ADDR.gita,   weight: 1 },
];
const tableB = buildTable({ epoch: 8, rows: rowsB });
// Use a seed that only exercises acceptance; padding is what this vector proves.
const SEED_B = toHex(sha256('pp:test:seed:B'));
const drawB = runDraw(tableB.rows, SEED_B);

// (c) COLLISION-TRIGGERING seed on a small table.
// Small totalWeight (=5) maximises collision probability, so acceptance is
// deterministic per-seed.
const tableC = buildTable({ epoch: 9, rows: rowsA });
const collisionC = findCollisionSeed(tableC.rows, 'C');

// (d) EQUAL-WEIGHT GATE POLICY, n=6, all weight=1. This is the spec's
// recommended gate table.
const rowsD = [
  { memberAddr: ADDR.alice,  weight: 1 },
  { memberAddr: ADDR.bob,    weight: 1 },
  { memberAddr: ADDR.dembe,  weight: 1 },
  { memberAddr: ADDR.esther, weight: 1 },
  { memberAddr: ADDR.farida, weight: 1 },
  { memberAddr: ADDR.hasan,  weight: 1 },
];
const tableD = buildTable({ epoch: 10, rows: rowsD });
const drawD = runDraw(tableD.rows, SEED_D);

// (e) TABLE with one federation-seat row (lower-tier council address).
// Structurally identical; note attached. Uses n=6.
const rowsE = [
  { memberAddr: ADDR.alice,    weight: 1 },
  { memberAddr: ADDR.bob,      weight: 1 },
  { memberAddr: ADDR.clusterW, weight: 1, note: 'federation seat (lower-tier council address)' },
  { memberAddr: ADDR.dembe,    weight: 1 },
  { memberAddr: ADDR.esther,   weight: 1 },
  { memberAddr: ADDR.farida,   weight: 1 },
];
const tableE = buildTable({ epoch: 11, rows: rowsE });
const drawE = runDraw(tableE.rows, SEED_E);

// (f) DELIBERATELY-WRONG incoming[5] that an auditor must REJECT.
// Uses table A and its correct draw; the "claimed" incoming permutes two
// entries so the divergence point is unambiguous.
const correctA = drawA.selected;
const wrongIncoming = [...correctA];
// Swap positions 0 and 1 to guarantee a divergence at position 0.
[wrongIncoming[0], wrongIncoming[1]] = [wrongIncoming[1], wrongIncoming[0]];
const divergenceIndex = correctA.findIndex((a, i) => a !== wrongIncoming[i]);

// ---------------------------------------------------------------------------
// Emit vectors.
// ---------------------------------------------------------------------------
const out = {
  specVersion: SPEC_VERSION,
  hashPrimitive: HASH_PRIMITIVE,
  generator: 'multisig/tooling/gen-draw-spec-vectors.mjs',
  notes: [
    'Vectors are the source-of-truth output of the generator; do not edit by hand.',
    'To regenerate: node multisig/tooling/gen-draw-spec-vectors.mjs > multisig/tooling/draw-spec-vectors.json',
    'Every domain tag used here appears verbatim in multisig/SORTITION-TABLE-DESIGN.md.',
  ],
  domainTags: {
    leaf: TAG_LEAF,
    node: TAG_NODE,
    pad: TAG_PAD,
    draw: TAG_DRAW,
    beacon: TAG_BEACON,
  },
  vectors: [
    {
      id: 'A',
      title: 'minimal table n=5, equal weights',
      exercises: ['minimal case', 'binary tree with n at power of two', 'no collisions expected'],
      table: tableA,
      seed: SEED_A,
      expected: {
        selected: drawA.selected,
        kConsumed: drawA.kConsumed,
        kSequence: drawA.kSequence,
      },
    },
    {
      id: 'B',
      title: 'non-power-of-two leaf count (n=6) — padding exercised',
      exercises: ['sentinel padding leaf', 'root over 8-leaf tree with 2 pad slots'],
      table: tableB,
      seed: SEED_B,
      expected: {
        selected: drawB.selected,
        kConsumed: drawB.kConsumed,
        kSequence: drawB.kSequence,
      },
    },
    {
      id: 'C',
      title: 'seed forces at least one rejection (collision path)',
      exercises: ['rejection sampling: advance k, do not re-pick'],
      table: tableC,
      seedSearchLabel: 'C',
      seedSearchTries: collisionC.tries,
      seed: collisionC.seed,
      expected: {
        selected: collisionC.draw.selected,
        kConsumed: collisionC.draw.kConsumed,
        kSequence: collisionC.draw.kSequence,
        collisions: collisionC.draw.kSequence.filter((s) => !s.accepted).length,
      },
    },
    {
      id: 'D',
      title: 'equal-weight gate policy (n=6, all weight=1) — spec §4 recommendation',
      exercises: ['gate policy round-trip', 'weight=1 uniform distribution'],
      table: tableD,
      seed: SEED_D,
      expected: {
        selected: drawD.selected,
        kConsumed: drawD.kConsumed,
        kSequence: drawD.kSequence,
      },
    },
    {
      id: 'E',
      title: 'federation-seat row present (lower-tier council address)',
      exercises: ['structural equivalence of federation and personal seats in the table'],
      table: tableE,
      seed: SEED_E,
      expected: {
        selected: drawE.selected,
        kConsumed: drawE.kConsumed,
        kSequence: drawE.kSequence,
      },
    },
    {
      id: 'F',
      title: 'wrong incoming[5] — auditor MUST reject',
      exercises: ['negative test: rotation whose incoming disagrees with the draw'],
      table: tableA,
      seed: SEED_A,
      claimedIncoming: wrongIncoming,
      expected: {
        verdict: 'reject',
        correctSelected: correctA,
        firstDivergenceIndex: divergenceIndex,
        rejectionReason:
          `claimed incoming[${divergenceIndex}] = ${wrongIncoming[divergenceIndex]} but ` +
          `spec §2 draw from (membershipRoot, seed) yields ${correctA[divergenceIndex]}`,
      },
    },
  ],
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
