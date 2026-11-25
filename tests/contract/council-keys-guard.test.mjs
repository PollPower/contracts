// Devnet council test keys are hard-blocked outside the local devnet
// (Garrett, 2026-11-24): the keys carry their own marker (x starts 0xDE7E) and
// every council constructor is built through buildCouncilConstructorArgs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  devnetCouncilKey, isDevnetCouncilPoint, assertCouncilKeysAllowed, buildCouncilConstructorArgs,
} from '../../tooling/council/council-keys-guard.mjs';
import { newCouncilKey } from './council-signer.mjs';

const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const fromCompressed = (hex) => {
  const raw = secp256k1.Point.fromHex(hex).toBytes(false);
  return { x: big(raw.slice(1, 33)), y: big(raw.slice(33, 65)), identity: false };
};

test('CK-1: the devnet council keys are marked; a real ring key is not', () => {
  for (let i = 0; i < 3; i++) assert.equal(isDevnetCouncilPoint(devnetCouncilKey(i).point), true, `devnet key ${i}`);
  // A non-devnet key in the compressed SEC1 format the Tangem rings use
  // (freshly generated test vector; not any council member's key).
  const ring = fromCompressed('03758c3270cb67eb4f7efd88986ce5b3c6e87fa4d3fb9ba2ecad7a993e1a65ee86');
  assert.equal(isDevnetCouncilPoint(ring), false);
});

test('CK-2 (negative): devnet keys are refused on every network but the local devnet', () => {
  const devnet = [0, 1, 2].map((i) => devnetCouncilKey(i).point);
  for (const net of ['preprod', 'preview', 'mainnet', undefined, '']) {
    assert.throws(() => buildCouncilConstructorArgs(devnet, 2n, net), /refusing devnet council test key/, String(net));
    assert.throws(() => assertCouncilKeysAllowed([newCouncilKey().point, devnet[1]], net), /refusing/, `one devnet key mixed in on ${net}`);
  }
  const [slots, n, t] = buildCouncilConstructorArgs(devnet, 2n, 'undeployed');
  assert.equal(slots.length, 7);
  assert.equal(n, 3n);
  assert.equal(t, 2n);
});

test('CK-3: real keys pass on any network; the threshold must be a strict majority', () => {
  const real = [newCouncilKey(), newCouncilKey(), newCouncilKey()].map((k) => k.point).filter((p) => !isDevnetCouncilPoint(p));
  assert.equal(real.length, 3);
  assert.doesNotThrow(() => buildCouncilConstructorArgs(real, 2n, 'preprod'));
  assert.throws(() => buildCouncilConstructorArgs(real, 1n, 'preprod'), /strict majority/);
  assert.throws(() => buildCouncilConstructorArgs(real, 4n, 'preprod'), /strict majority/);
});
