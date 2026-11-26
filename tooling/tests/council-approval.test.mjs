// Council approval from a ring result (Preprod first approval). Throwaway keys only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { checkRingResult, slotsFromLedger, assertSlotsMatchFile } from '../council/council-approval-lib.mjs';
import { N } from '../tangem/ring-signature.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => {
  const sk = secp256k1.utils.randomSecretKey();
  const c = secp256k1.getPublicKey(sk, true);
  const p = secp256k1.Point.fromBytes(c).toAffine();
  return { sk, compressed: hex(c), point: { x: p.x, y: p.y } };
};
const council = [key(), key(), key()];
const slots = council.map((k, slot) => ({ slot, x: k.point.x, y: k.point.y }));
const digest = hex(secp256k1.utils.randomSecretKey());   // any 32 bytes
const sign = (k, h = digest, { highS = false, der = false } = {}) => {
  const sig = secp256k1.sign(Buffer.from(h, 'hex'), k.sk, { prehash: false, lowS: true, format: der ? 'der' : 'compact' });
  if (!highS) return hex(sig);
  const r = BigInt('0x' + hex(sig.slice(0, 32))), s = N - BigInt('0x' + hex(sig.slice(32)));
  return r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0');
};
const result = (k, over = {}) => ({ test: 'wi16-tangem-secp256k1', curve: 'secp256k1', publicKey: k.compressed, walletPublicKey: k.compressed, hash: digest, signature: sign(k), ...over });

test('CA-1: a valid result from each council slot is accepted and mapped to its slot; S is returned low', () => {
  for (const i of [0, 1, 2]) {
    const r = checkRingResult({ result: result(council[i]), digestHex: digest, slots });
    assert.equal(r.slot, i);
    assert.ok(r.s <= N >> 1n);
  }
  const high = checkRingResult({ result: result(council[1], { signature: sign(council[1], digest, { highS: true }) }), digestHex: digest, slots });
  assert.equal(high.slot, 1);
  assert.ok(high.s <= N >> 1n, 'high-S normalised for the circuit');
  assert.equal(checkRingResult({ result: result(council[2], { signature: sign(council[2], digest, { der: true }) }), digestHex: digest, slots }).slot, 2);
});

test('CA-2: refuses a key that is not council slot 0, 1 or 2 (e.g. the retired demo key), even with a valid signature', () => {
  const outsider = key();
  assert.throws(() => checkRingResult({ result: result(outsider), digestHex: digest, slots }), /not council slot 0, 1 or 2/);
  assert.throws(() => checkRingResult({ result: result(outsider, { publicKey: council[0].compressed }), digestHex: digest, slots }), /walletPublicKey .* publicKey/);
});

test('CA-3: refuses another hash, a bad signature, a slot mismatch, and a non-secp256k1 result', () => {
  const other = hex(secp256k1.utils.randomSecretKey());
  assert.throws(() => checkRingResult({ result: result(council[0], { hash: other }), digestHex: digest, slots }), /signed a different hash/);
  assert.throws(() => checkRingResult({ result: result(council[0], { signature: sign(council[0], other) }), digestHex: digest, slots }), /does not verify/);
  assert.throws(() => checkRingResult({ result: result(council[0], { signature: sign(council[1]) }), digestHex: digest, slots }), /does not verify/);
  assert.throws(() => checkRingResult({ result: result(council[0]), digestHex: digest, slots, claimedSlot: 1 }), /slot 0, not the claimed slot 1/);
  assert.throws(() => checkRingResult({ result: result(council[0], { curve: 'ed25519' }), digestHex: digest, slots }), /secp256k1/);
});

test('CA-4: on-chain slots come from the ledger (count-limited) and must equal the council file', () => {
  const ledger = { _adminCount: 3n, _adminPks: { lookup: (i) => ({ x: council[Number(i)].point.x, y: council[Number(i)].point.y }) } };
  const s = slotsFromLedger(ledger);
  assert.deepEqual(s.map((x) => x.slot), [0, 1, 2]);
  assertSlotsMatchFile(s, council.map((k, slot) => ({ slot, publicKey: k.compressed })));
  const swapped = [council[1], council[0], council[2]].map((k, slot) => ({ slot, publicKey: k.compressed }));
  assert.throws(() => assertSlotsMatchFile(s, swapped), /slot 0 on chain differs from the council file/);
  assert.throws(() => assertSlotsMatchFile(s.slice(0, 2), swapped), /3 slots/);
});
