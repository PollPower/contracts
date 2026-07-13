// multisig/tooling/sortition-table/lib.mjs
// -----------------------------------------------------------------------------
// Reference off-chain implementation of SORTITION-DRAW-SPEC/v1.
//
// This module is a SECOND, INDEPENDENT implementation of the spec (§1.1
// canonical order, §2 byte encodings, §3 SHA-256 primitive, §4 domain-tag
// registry, §5.1 leaves, §5.2 padding sentinel, §5.3 Merkle tree, §5.4 draw).
// It is written from the spec text directly, not by copying from
// gen-draw-spec-vectors.mjs. Byte-for-byte agreement with the committed
// vectors (see tests/vectors.test.mjs) is what proves the two implementations
// match.
//
// Pure functions only: no filesystem, no network, no clock, no globals. All
// I/O lives in the CLI wrappers (cli.mjs, build-table.mjs, audit-draw.mjs).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Spec version + closed domain-tag registry (SORTITION-DRAW-SPEC §1, §4).
// A change to any of these strings is a spec-version bump per §1.2/§1.3.
// ---------------------------------------------------------------------------
export const SPEC_VERSION = 'pp-sortition-draw-spec/v1';
export const HASH_PRIMITIVE = 'SHA-256';

export const TAG = Object.freeze({
  LEAF:   'pp:sortition:leaf:v1',   // 20 bytes ASCII
  NODE:   'pp:sortition:node:v1',   // 20 bytes ASCII
  PAD:    'pp:sortition:pad:v1',    // 19 bytes ASCII
  DRAW:   'pp:sortition:draw:v1',   // 20 bytes ASCII
  BEACON: 'pp:sortition:beacon:v1', // 22 bytes ASCII (reserved; not used off-chain by this tool)
});

// The council size the sortition table draws into is fixed (design note §2,
// §7). This is the "distinct members" count required in §5.4 and §7.
export const COUNCIL_SIZE = 5;

// ---------------------------------------------------------------------------
// Byte-level primitives (SORTITION-DRAW-SPEC §2). All integers big-endian,
// unsigned, fixed-width; no varint, no length-prefix.
// ---------------------------------------------------------------------------

/** SHA-256 over the concatenation of the given parts. */
export function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    if (typeof p === 'string') {
      h.update(Buffer.from(p, 'utf8'));
    } else if (Buffer.isBuffer(p)) {
      h.update(p);
    } else if (p instanceof Uint8Array) {
      h.update(Buffer.from(p));
    } else {
      throw new TypeError(`sha256: unsupported input type: ${typeof p}`);
    }
  }
  return h.digest();
}

/** 8-byte big-endian unsigned. Accepts number or bigint. */
export function u64be(n) {
  const big = typeof n === 'bigint' ? n : BigInt(n);
  if (big < 0n || big > 0xffffffffffffffffn) {
    throw new RangeError(`u64be: out of range: ${big}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(big, 0);
  return b;
}

/** 4-byte big-endian unsigned. */
export function u32be(n) {
  const num = typeof n === 'bigint' ? Number(n) : Number(n);
  if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
    throw new RangeError(`u32be: out of range: ${n}`);
  }
  const b = Buffer.alloc(4);
  b.writeUInt32BE(num, 0);
  return b;
}

/** Parse a 32-byte hex string (with or without 0x prefix) into a Buffer. */
export function hex32(hex) {
  if (typeof hex !== 'string') {
    throw new TypeError('hex32: expected string');
  }
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(`hex32: expected 32-byte hex (64 hex chars, optional 0x prefix), got: ${hex}`);
  }
  return Buffer.from(s, 'hex');
}

/** Buffer / Uint8Array -> 0x-prefixed hex string. */
export function toHex(buf) {
  return '0x' + Buffer.from(buf).toString('hex');
}

/** Interpret a Buffer as a big-endian unsigned BigInt. */
export function bytesToBigIntBE(buf) {
  let x = 0n;
  for (const b of buf) x = (x << 8n) | BigInt(b);
  return x;
}

/** smallest power of two >= n, with nextPow2(0) = nextPow2(1) = 1. */
export function nextPow2(n) {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Normalise a 32-byte hex string to canonical lowercased 0x-prefixed form. */
export function canonAddr(hex) {
  const buf = hex32(hex);
  return toHex(buf);
}

// ---------------------------------------------------------------------------
// §5.1 Leaf hash: SHA-256(TAG_LEAF || u64be(epoch) || u32be(index) ||
//                        memberAddr(32B) || u64be(weight))
// Pre-image = 20 + 8 + 4 + 32 + 8 = 72 bytes.
// ---------------------------------------------------------------------------
export function leafHash({ epoch, index, memberAddr, weight }) {
  return sha256(
    TAG.LEAF,
    u64be(epoch),
    u32be(index),
    hex32(memberAddr),
    u64be(weight),
  );
}

// ---------------------------------------------------------------------------
// §5.2 Padding-leaf sentinel: SHA-256(TAG_PAD), no other inputs. Constant.
// Padded slots have weight 0 and are undrawable (invariant §8.4).
// ---------------------------------------------------------------------------
export function padLeafHash() {
  return sha256(TAG.PAD);
}

// ---------------------------------------------------------------------------
// §5.3 Merkle tree.
//   node(left, right) = SHA-256(TAG_NODE || left(32B) || right(32B))
//   Padding to nextPow2(n) using the sentinel. Root computed by repeated
//   pairwise application from the leaf layer up.
// ---------------------------------------------------------------------------
export function nodeHash(left, right) {
  if (left.length !== 32 || right.length !== 32) {
    throw new Error(`nodeHash: children must be 32 bytes; got ${left.length}, ${right.length}`);
  }
  return sha256(TAG.NODE, left, right);
}

export function computeMerkleRoot(leafHashes) {
  const padded = nextPow2(leafHashes.length);
  const pad = padLeafHash();
  let layer = new Array(padded);
  for (let i = 0; i < padded; i++) {
    layer[i] = i < leafHashes.length ? leafHashes[i] : pad;
  }
  while (layer.length > 1) {
    const next = new Array(layer.length >> 1);
    for (let i = 0; i < layer.length; i += 2) {
      next[i >> 1] = nodeHash(layer[i], layer[i + 1]);
    }
    layer = next;
  }
  return layer[0];
}

// ---------------------------------------------------------------------------
// §1.2 canonical order (ascending by memberAddr bytes, lexicographic, total)
// + index assignment + cumulative sum. Padded slots are NOT in this list;
// they are appended only inside computeMerkleRoot.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} InputRow
 * @property {string}  memberAddr        32-byte hex (with/without 0x prefix)
 * @property {number|bigint} weight      non-negative integer weight (drawable rows: >= 1)
 * @property {boolean} [isFederationSeat]  informational only; does not affect encoding
 */

/**
 * @typedef {object} CanonRow
 * @property {number}  index
 * @property {string}  memberAddr        canonical 0x-prefixed lowercase 32-byte hex
 * @property {number}  weight
 * @property {number}  cumulative        weight sum through this row (inclusive)
 * @property {boolean} isFederationSeat
 * @property {string}  leafHash          0x-prefixed 32-byte hex
 */

/**
 * Canonicalise a snapshot: enforce distinct addresses (drawable rows only),
 * sort by memberAddr ascending, assign contiguous indices, compute cumulative
 * sums and per-row leaf hashes.
 *
 * The input snapshot is assumed to be already gate-filtered (that is WI-18's
 * concern). This function's job is byte layout, not policy.
 *
 * @param {{ epoch: number|bigint, rows: InputRow[] }} snapshot
 * @returns {{ epoch: number, rows: CanonRow[], totalWeight: number, membershipRoot: string, paddedLeafCount: number, padSentinelLeafHash: string, n: number }}
 */
export function buildCanonicalTable(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('buildCanonicalTable: snapshot must be an object with { epoch, rows }');
  }
  const { epoch, rows } = snapshot;
  if (epoch === undefined || epoch === null) {
    throw new Error('buildCanonicalTable: snapshot.epoch is required');
  }
  if (!Array.isArray(rows)) {
    throw new Error('buildCanonicalTable: snapshot.rows must be an array');
  }

  // Reject weight=0 rows in the input: padded/undrawable slots are synthesised
  // internally, never taken from the caller (invariant §8.4).
  for (const r of rows) {
    if (!r || typeof r.memberAddr !== 'string') {
      throw new Error(`buildCanonicalTable: row.memberAddr must be a hex string, got: ${JSON.stringify(r)}`);
    }
    const w = typeof r.weight === 'bigint' ? r.weight : BigInt(r.weight ?? 0);
    if (w <= 0n) {
      throw new Error(`buildCanonicalTable: row.weight must be >= 1 (padded/undrawable slots are internal), got ${r.weight} for ${r.memberAddr}`);
    }
  }

  // Distinct address check (drawable set must be a set).
  const seen = new Set();
  for (const r of rows) {
    const c = canonAddr(r.memberAddr);
    if (seen.has(c)) {
      throw new Error(`buildCanonicalTable: duplicate memberAddr in snapshot: ${c}`);
    }
    seen.add(c);
  }

  // §1.2 canonical order: sort ascending by 32-byte address, lexicographic.
  const sorted = [...rows].sort((a, b) => {
    return Buffer.compare(hex32(a.memberAddr), hex32(b.memberAddr));
  });

  // Assign indices + cumulative sums (BigInt in the accumulator; the table
  // exposes Number for JSON convenience — pilot-scale weights fit).
  let cum = 0n;
  const canon = sorted.map((r, i) => {
    const weight = Number(r.weight);
    cum += BigInt(weight);
    if (cum > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`buildCanonicalTable: cumulative weight exceeds Number.MAX_SAFE_INTEGER; caller must use bigint tooling`);
    }
    const memberAddr = canonAddr(r.memberAddr);
    const isFederationSeat = Boolean(r.isFederationSeat);
    return {
      index: i,
      memberAddr,
      weight,
      cumulative: Number(cum),
      isFederationSeat,
      leafHash: null, // filled below once index is stable
    };
  });

  // §5.1 leaf hashes over the canonical rows.
  const epochBig = typeof epoch === 'bigint' ? epoch : BigInt(epoch);
  const leafBufs = canon.map((r) => leafHash({
    epoch: epochBig,
    index: r.index,
    memberAddr: r.memberAddr,
    weight: r.weight,
  }));
  for (let i = 0; i < canon.length; i++) {
    canon[i].leafHash = toHex(leafBufs[i]);
  }

  const totalWeight = canon.length === 0 ? 0 : canon[canon.length - 1].cumulative;
  const padded = nextPow2(canon.length);
  const root = computeMerkleRoot(leafBufs);

  return {
    specVersion: SPEC_VERSION,
    hashPrimitive: HASH_PRIMITIVE,
    epoch: Number(epochBig),
    n: canon.length,
    paddedLeafCount: padded,
    padSentinelLeafHash: toHex(padLeafHash()),
    rows: canon,
    totalWeight,
    membershipRoot: toHex(root),
  };
}

// ---------------------------------------------------------------------------
// §5.4 Draw.
//   k = 0
//   while len(selected) < 5:
//     d      = SHA-256(TAG_DRAW || seed(32B) || u32be(k))
//     pick   = int_be(d) mod totalWeight
//     winner = smallest i s.t. pick < cumulative[i]      # half-open bucket
//     if winner.memberAddr in selected: k += 1; continue  # rejection: advance k
//     selected.push(winner.memberAddr); k += 1
// ---------------------------------------------------------------------------

/**
 * Half-open cumulative bucket lookup: smallest i with pick < cumulative[i].
 * Binary search over drawable (weight > 0) rows only. Caller MUST NOT include
 * padded slots.
 */
export function winnerFromPick(rows, pick) {
  if (rows.length === 0) throw new Error('winnerFromPick: empty rows');
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(rows[mid].cumulative) <= pick) lo = mid + 1;
    else hi = mid;
  }
  return rows[lo];
}

/**
 * One draw step. Pure: returns the digest, its pick, and the winner row.
 * `seed` may be a 0x-hex string or a 32-byte Buffer/Uint8Array.
 */
export function drawStep(rows, seed, k, totalWeight) {
  const seedBuf = Buffer.isBuffer(seed) || seed instanceof Uint8Array
    ? Buffer.from(seed)
    : hex32(seed);
  if (seedBuf.length !== 32) {
    throw new Error(`drawStep: seed must be 32 bytes; got ${seedBuf.length}`);
  }
  const digest = sha256(TAG.DRAW, seedBuf, u32be(k));
  const digestInt = bytesToBigIntBE(digest);
  const pick = digestInt % BigInt(totalWeight);
  const winner = winnerFromPick(rows, pick);
  return { digest, digestInt, pick, winner };
}

/**
 * Full draw: returns the ordered selected[] of exactly COUNCIL_SIZE distinct
 * memberAddrs, plus the full k-trace for auditor comparison. Rejects via
 * throw if the input violates preconditions (n >= 5 distinct drawable rows,
 * weights > 0, cumulative strictly increasing).
 *
 * @param {CanonRow[]} rows       drawable, canonical rows (padded slots MUST NOT be present)
 * @param {string|Buffer|Uint8Array} seed  32-byte seed
 * @param {{ want?: number, maxK?: number }} [opts]
 * @returns {{ totalWeight: number, selected: string[], kConsumed: number, kSequence: object[] }}
 */
export function runDraw(rows, seed, opts = {}) {
  const want = opts.want ?? COUNCIL_SIZE;
  const maxK = opts.maxK ?? 100_000; // safety cap: with n>=5 distinct, termination is guaranteed

  if (!Array.isArray(rows) || rows.length < want) {
    throw new Error(`runDraw: precondition violated — need >= ${want} drawable rows, got ${rows?.length ?? 0}`);
  }
  // Distinct-address precondition (§7.1).
  const distinct = new Set(rows.map((r) => r.memberAddr));
  if (distinct.size < want) {
    throw new Error(`runDraw: precondition violated — need >= ${want} DISTINCT drawable rows, got ${distinct.size} distinct of ${rows.length}`);
  }
  // Cumulative monotone strictly increasing (§7.2).
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].weight <= 0) {
      throw new Error(`runDraw: precondition violated — padded/zero-weight row at index ${i} is undrawable and must not appear in draw input`);
    }
    if (i > 0 && !(rows[i].cumulative > rows[i - 1].cumulative)) {
      throw new Error(`runDraw: precondition violated — cumulative not strictly increasing at index ${i}`);
    }
  }
  const totalWeight = rows[rows.length - 1].cumulative;
  if (totalWeight <= 0) {
    throw new Error('runDraw: precondition violated — totalWeight must be > 0');
  }

  const selected = [];
  const selectedSet = new Set();
  const kSequence = [];
  let k = 0;
  while (selected.length < want) {
    if (k >= maxK) {
      throw new Error(`runDraw: exceeded maxK=${maxK}; spec-level termination guarantee should not have failed with n>=5 distinct`);
    }
    const { digest, pick, winner } = drawStep(rows, seed, k, totalWeight);
    const isCollision = selectedSet.has(winner.memberAddr);
    kSequence.push({
      k,
      hashHex: toHex(digest),
      pick: pick.toString(),
      winnerIndex: winner.index,
      winnerAddr: winner.memberAddr,
      accepted: !isCollision,
      reason: isCollision ? 'collision (already selected) -> advance k' : 'accepted',
    });
    if (!isCollision) {
      selected.push(winner.memberAddr);
      selectedSet.add(winner.memberAddr);
    }
    k += 1;
  }
  return {
    totalWeight,
    selected,
    kConsumed: k,
    kSequence,
  };
}

// ---------------------------------------------------------------------------
// Auditor helper: compare a claimed incoming[5] against the spec-derived
// selected[5]. Returns MATCH / MISMATCH verdict with the first divergence
// point named (SORTITION-DRAW-SPEC §6 step 4, and vector F's `expected`).
// ---------------------------------------------------------------------------
export function auditDraw({ table, seed, claimedIncoming }) {
  if (!table || !Array.isArray(table.rows)) {
    throw new Error('auditDraw: table.rows[] is required');
  }
  if (!Array.isArray(claimedIncoming) || claimedIncoming.length !== COUNCIL_SIZE) {
    throw new Error(`auditDraw: claimedIncoming must be an array of length ${COUNCIL_SIZE}`);
  }
  // Only drawable rows go into the draw. buildCanonicalTable never emits
  // weight-0 rows, so we defensively assert here.
  const drawableRows = table.rows.filter((r) => r.weight > 0);
  if (drawableRows.length !== table.rows.length) {
    throw new Error('auditDraw: table.rows contains a zero-weight (padded) row; padded slots must not appear in the table');
  }

  const draw = runDraw(drawableRows, seed);
  const claimedCanon = claimedIncoming.map(canonAddr);
  const correctCanon = draw.selected.map(canonAddr);

  let firstDivergenceIndex = -1;
  for (let i = 0; i < COUNCIL_SIZE; i++) {
    if (claimedCanon[i] !== correctCanon[i]) {
      firstDivergenceIndex = i;
      break;
    }
  }

  if (firstDivergenceIndex === -1) {
    return {
      verdict: 'MATCH',
      selected: correctCanon,
      kConsumed: draw.kConsumed,
    };
  }
  return {
    verdict: 'MISMATCH',
    firstDivergenceIndex,
    correctSelected: correctCanon,
    claimedIncoming: claimedCanon,
    rejectionReason:
      `claimed incoming[${firstDivergenceIndex}] = ${claimedCanon[firstDivergenceIndex]} but ` +
      `spec §5.4 draw from (table, seed) yields ${correctCanon[firstDivergenceIndex]}`,
    kConsumed: draw.kConsumed,
  };
}

// ---------------------------------------------------------------------------
// Beacon derivation (§5.5). Provided for completeness; not used by the CLIs
// directly (they take a revealed seed).
// ---------------------------------------------------------------------------
export function deriveBeaconSeed(blockhash32) {
  const bh = Buffer.isBuffer(blockhash32) || blockhash32 instanceof Uint8Array
    ? Buffer.from(blockhash32)
    : hex32(blockhash32);
  if (bh.length !== 32) throw new Error(`deriveBeaconSeed: blockhash must be 32 bytes; got ${bh.length}`);
  return sha256(TAG.BEACON, bh);
}
