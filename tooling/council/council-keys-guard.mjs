// @ts-check
// Council keys: devnet test keys are HARD-BLOCKED outside the local devnet
// (Garrett, 2026-11-24), the same way devnet HAT chips are (IEEE prefix PPDEV).
//
// The devnet council keys are software stand-ins for the Tangem rings,
// derived from public labels. They carry their own marker: their x coordinate
// starts with 0xDE7E (found by grinding the label counter). A real ring key has
// that prefix with probability 1/65536.
//
// Every council constructor MUST be built with buildCouncilConstructorArgs,
// which refuses marked keys unless the network is the local devnet
// ('undeployed'). The Preprod deploy uses it; the check is in code, not
// configuration.
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const DEVNET_COUNCIL_MARKER = 0xde7en;   // top 16 bits of x
const MAX_SLOTS = 7;
const big = (/** @type {Uint8Array} */ b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);

/** @param {{x: bigint}} point */
export const isDevnetCouncilPoint = (point) => (BigInt(point.x) >> 240n) === DEVNET_COUNCIL_MARKER;

// Grind counters found once (each gives a key whose x starts with 0xDE7E).
const DEVNET_COUNTERS = [29749, 29255, 30896];

/** The i-th devnet council test key (sk + Multisig v8 point). LOCAL DEVNET ONLY. */
export function devnetCouncilKey(/** @type {number} */ i) {
  const n = DEVNET_COUNTERS[i];
  if (n === undefined) throw new Error(`no devnet council key ${i}`);
  const sk = new Uint8Array(createHash('sha256').update(`pollpower wi16 devnet council ${i} #${n} (test key, not a secret)`).digest());
  const raw = secp256k1.getPublicKey(sk, false);
  const point = { x: big(raw.slice(1, 33)), y: big(raw.slice(33, 65)), identity: false };
  if (!isDevnetCouncilPoint(point)) throw new Error('devnet council key lost its marker');
  return { sk, point };
}

/** Throws if any marked devnet council key is used outside the local devnet. */
export function assertCouncilKeysAllowed(/** @type {{x: bigint}[]} */ points, /** @type {string | undefined} */ networkId) {
  const marked = points.filter(isDevnetCouncilPoint);
  if (marked.length && networkId !== 'undeployed') {
    throw new Error(`refusing devnet council test key(s) on network ${JSON.stringify(networkId)}: local devnet ('undeployed') only`);
  }
}

/**
 * Multisig v8 constructor args: (adminPks: Vector<7, Secp256k1Point>,
 * adminCount, threshold). Unused slots are filled with the generator point (the
 * constructor installs only the first adminCount slots).
 */
export function buildCouncilConstructorArgs(/** @type {{x: bigint, y: bigint, identity: boolean}[]} */ points, /** @type {bigint} */ threshold, /** @type {string | undefined} */ networkId) {
  if (points.length < 1 || points.length > MAX_SLOTS) throw new Error(`council size must be 1..${MAX_SLOTS}`);
  if (threshold < 1n || threshold > BigInt(points.length) || threshold * 2n <= BigInt(points.length)) {
    throw new Error('threshold must be a strict majority of the council');
  }
  assertCouncilKeysAllowed(points, networkId);
  const raw = secp256k1.Point.BASE.toBytes(false);
  const filler = { x: big(raw.slice(1, 33)), y: big(raw.slice(33, 65)), identity: false };
  const slots = Array.from({ length: MAX_SLOTS }, (_, i) => points[i] ?? filler);
  return [slots, BigInt(points.length), threshold];
}
