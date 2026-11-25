// WI-16 Tangem test pipeline, proven with a software secp256k1 key standing in
// for the ring: key formats, raw vs DER signatures, high-S, and the compiled
// Compact stdlib secp256k1EcdsaVerify (offline). The real ring result is
// checked with tooling/tangem/verify-ring-signature.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { buildExists, loadContract } from './harness.mjs';
import { N, analyse, parsePublicKey, parseSignature, circuitVerify } from '../../tooling/tangem/ring-signature.mjs';

const NAME = 'tangem-verify';
const skip = buildExists(NAME) ? false : 'build/l9/tangem-verify missing (compile tooling/tangem/tangem-verify.compact)';

const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => createHash('sha256').update(s).digest();
// The hash signed with the ring.
const TEST_HASH = sha('PollPower WI-16 Tangem secp256k1 test 2026-11-24');
const sk = sha('wi16 software stand-in for the Tangem ring (test key, not a secret)');
const pkCompressed = secp256k1.getPublicKey(sk, true);
const pkUncompressed = secp256k1.getPublicKey(sk, false);

function sign(hash) {
  const sig = secp256k1.sign(hash, sk, { prehash: false, lowS: true }); // 64-byte r||s
  return { raw: sig, r: BigInt('0x' + hex(sig.slice(0, 32))), s: BigInt('0x' + hex(sig.slice(32))) };
}
function der(r, s) {
  const int = (v) => {
    let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex');
    while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.of(0), b]);
    return Buffer.concat([Buffer.of(0x02, b.length), b]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.of(0x30, body.length), body]);
}
const result = (publicKey, signature, hash = TEST_HASH) =>
  ({ curve: 'secp256k1', publicKey: hex(publicKey), signature: hex(signature), hash: hex(hash) });

test('the test hash is the one in the admin app and the instructions', () => {
  assert.equal(hex(TEST_HASH), '1f530333927aed3cadebc75edb1d176c3335015006bb8af0600c83cabd713176');
});

test('TANGEM-1: low-S raw r||s verifies in the circuit for every public key format', { skip }, async () => {
  const mod = await loadContract(NAME);
  const { raw } = sign(TEST_HASH);
  for (const pk of [pkCompressed, pkUncompressed, pkUncompressed.slice(1)]) {
    const rep = analyse(mod, result(pk, raw));
    assert.equal(rep.circuit.asGiven, true, rep.publicKeyFormat);
    assert.equal(rep.noble.lowSRequired, true);
  }
});

test('TANGEM-2: a DER signature decodes to the same r,s and verifies', { skip }, async () => {
  const mod = await loadContract(NAME);
  const { r, s } = sign(TEST_HASH);
  const rep = analyse(mod, result(pkCompressed, der(r, s)));
  assert.match(rep.signatureEncoding, /^DER/);
  assert.equal(rep.circuit.asGiven, true);
  const p = parseSignature(hex(der(r, s)));
  assert.equal(p.r, r);
  assert.equal(p.s, s);
});

test('TANGEM-3: high-S handling of the Compact verifier (pinned)', { skip }, async () => {
  const mod = await loadContract(NAME);
  const { r, s } = sign(TEST_HASH);
  const highS = N - s;
  const pk = parsePublicKey(hex(pkCompressed));
  const v = circuitVerify(mod, TEST_HASH, r, highS, pk.point);
  // The normalised (low-S) form must always verify.
  assert.equal(v.lowS, true);
  // Observed 2026-11-24 (compact-runtime 0.21.0): the stdlib accepts high-S too.
  // So the ring's S normalisation does not matter for verification, but ECDSA
  // malleability is real: (r, n-s) is a second valid signature. Council
  // approvals must therefore be keyed by (actionHash, admin), never by
  // signature bytes. Pinned so a runtime change is noticed.
  assert.equal(v.asGiven, true);
});

test('TANGEM-4 (negative): wrong hash or wrong key does not verify', { skip }, async () => {
  const mod = await loadContract(NAME);
  const { raw } = sign(TEST_HASH);
  const other = secp256k1.getPublicKey(sha('a different key'), true);
  assert.equal(analyse(mod, result(pkCompressed, raw, sha('another message'))).circuit.asGiven, false);
  assert.equal(analyse(mod, result(other, raw)).circuit.asGiven, false);
});
