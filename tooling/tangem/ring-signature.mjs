// @ts-nocheck: behaviour is pinned by tests/parity/tangem-secp256k1.test.mjs.
// WI-16 Tangem test: decode what a ring returns and check it the way the
// Compact stdlib secp256k1EcdsaVerify will. No network, no keys stored.
//
// A Tangem ring signs the 32-byte hash it is given as-is (no extra hashing),
// so every check here uses the hash directly (`prehash: false`).
import { secp256k1 } from '@noble/curves/secp256k1.js';

/** secp256k1 group order n. */
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;

export const hexToBytes = (hex) => {
  const clean = String(hex).trim().toLowerCase().replace(/^0x/, '');
  if (!/^([0-9a-f]{2})*$/.test(clean)) throw new Error(`not hex: ${hex}`);
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const bytesToBigint = (b) => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
const bigintTo32 = (v) => hexToBytes(v.toString(16).padStart(64, '0'));

/**
 * Public key as the ring reports it -> affine point.
 * Accepts 33-byte compressed (02/03), 65-byte uncompressed (04) or 64-byte raw x||y.
 */
export function parsePublicKey(hex) {
  const b = hexToBytes(hex);
  let format;
  let bytes = b;
  if (b.length === 33 && (b[0] === 2 || b[0] === 3)) format = 'compressed (33 bytes)';
  else if (b.length === 65 && b[0] === 4) format = 'uncompressed (65 bytes, 0x04 prefix)';
  else if (b.length === 64) { format = 'raw x||y (64 bytes, no prefix)'; bytes = Uint8Array.of(4, ...b); }
  else throw new Error(`unrecognised secp256k1 public key: ${b.length} bytes`);
  const p = secp256k1.Point.fromBytes(bytes).toAffine();
  return { format, x: p.x, y: p.y, point: { x: p.x, y: p.y, identity: false } };
}

/** Minimal strict DER: 30 len 02 lenR R 02 lenS S. */
function parseDer(b) {
  const fail = (why) => { throw new Error(`invalid DER signature: ${why}`); };
  if (b[0] !== 0x30) fail('no SEQUENCE');
  if (b[1] !== b.length - 2) fail('length mismatch');
  let i = 2;
  const int = () => {
    if (b[i] !== 0x02) fail('expected INTEGER');
    const len = b[i + 1];
    const v = b.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return bytesToBigint(v);
  };
  const r = int();
  const s = int();
  if (i !== b.length) fail('trailing bytes');
  return { r, s };
}

/** Signature as the ring returns it -> { r, s, encoding }. */
export function parseSignature(hex) {
  const b = hexToBytes(hex);
  if (b.length === 64) return { encoding: 'raw r||s (64 bytes)', r: bytesToBigint(b.slice(0, 32)), s: bytesToBigint(b.slice(32)) };
  if (b.length === 65) return { encoding: 'r||s||v (65 bytes, recovery byte ignored)', r: bytesToBigint(b.slice(0, 32)), s: bytesToBigint(b.slice(32, 64)) };
  if (b[0] === 0x30) return { encoding: `DER (${b.length} bytes)`, ...parseDer(b) };
  throw new Error(`unrecognised signature encoding: ${b.length} bytes`);
}

export const isHighS = (s) => s > HALF_N;
export const normalizeS = (s) => (isHighS(s) ? N - s : s);

/** Off-chain reference check (noble), with and without the low-S rule. */
export function nobleVerify(hashBytes, r, s, pk) {
  const sig = Uint8Array.of(...bigintTo32(r), ...bigintTo32(s));
  const pub = secp256k1.Point.fromAffine({ x: pk.x, y: pk.y }).toBytes(true);
  return {
    lowSRequired: secp256k1.verify(sig, hashBytes, pub, { prehash: false, lowS: true }),
    lowSNotRequired: secp256k1.verify(sig, hashBytes, pub, { prehash: false, lowS: false }),
  };
}

/**
 * Runs the compiled Compact circuit `check` (stdlib secp256k1EcdsaVerify) offline
 * for the signature as given and with S normalised to low-S.
 * @param {{ pureCircuits: { check: Function } }} mod compiled tangem-verify module
 */
export function circuitVerify(mod, hashBytes, r, s, point) {
  const run = (sv) => {
    try { return mod.pureCircuits.check(hashBytes, { r, s: sv }, point); } catch (e) { return `error: ${e.message}`; }
  };
  return { asGiven: run(s), lowS: run(normalizeS(s)), highS: run(isHighS(s) ? s : N - s) };
}

/** Full report for one ring result (the JSON the admin app shares). */
export function analyse(mod, result) {
  const hash = hexToBytes(result.hash);
  if (hash.length !== 32) throw new Error('hash must be 32 bytes');
  const pk = parsePublicKey(result.publicKey);
  const sig = parseSignature(result.signature);
  return {
    curve: result.curve,
    publicKeyFormat: pk.format,
    signatureEncoding: sig.encoding,
    sIsHigh: isHighS(sig.s),
    noble: nobleVerify(hash, sig.r, sig.s, pk),
    circuit: circuitVerify(mod, hash, sig.r, sig.s, pk.point),
    walletKeyMatches: !result.walletPublicKey || result.walletPublicKey.toLowerCase() === String(result.publicKey).toLowerCase(),
  };
}
