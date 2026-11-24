// Off-chain council signer for Multisig v8 (WI16-C-1a), standing in for a
// Tangem ring: secp256k1 over the 32-byte digest AS GIVEN (no prehash), raw
// r||s, exactly what the ring produced in the 2026-11-24 test. The digest comes
// from the contract's own exported pure circuit `approvalDigest`.
import { secp256k1 } from '@noble/curves/secp256k1.js';

const N = secp256k1.Point.CURVE().n;
const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);

export function newCouncilKey() {
  const sk = secp256k1.utils.randomSecretKey();
  const raw = secp256k1.getPublicKey(sk, false); // 04 || x || y
  return { sk, point: { x: big(raw.slice(1, 33)), y: big(raw.slice(33, 65)), identity: false } };
}

/** The council digest exactly as the circuit computes it. */
export function approvalDigest(mod, selfBytes, actionHash, epoch = 0n) {
  return mod.pureCircuits.approvalDigest(selfBytes, actionHash, epoch);
}

/** Sign a digest like the ring does; `highS` returns the (r, n-s) twin. */
export function signDigest(digest, sk, { highS = false } = {}) {
  const sig = secp256k1.sign(digest, sk, { prehash: false, lowS: true });
  const r = big(sig.slice(0, 32));
  const s = big(sig.slice(32));
  return { r, s: highS ? N - s : s };
}

/** A well-formed signature by nobody (the PoC's "forged" input). */
export const forgedSignature = () => ({ r: 1n, s: 1n });
