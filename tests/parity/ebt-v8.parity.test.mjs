// Parity: EBT v8 compiled with Compact 0.36.1 vs the JS mirror
// (ebt/tests/lib.mjs) and an independent off-chain HAT builder.
//
// Since WI16-C-1c the HAT is a Jubjub Schnorr signature verified in-circuit
// (no witness). EBT-2 builds the signed message with compact-runtime's
// transientHash from the documented layout, NOT through the contract's
// hatMessage pure circuit, and checks the circuit accepts it: that is the
// parity a meter-authority-service implementation must meet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../ebt/tests/lib.mjs';
import { buildExists, loadContract, deploy, b32, padTag, RTlib } from './harness.mjs';
import { newOwnerKey, signOwnerAction } from '../contract/owner-signer.mjs';
import { newMachineKey, signMessage } from '../contract/machine-signer.mjs';

const NAME = 'ebt-v8';
const skip = buildExists(NAME) ? false : 'build/l9/ebt-v8 missing: run `npm run build:contracts`';

const OWNER = newOwnerKey();
const HAT = newMachineKey();
async function setup() {
  const mod = await loadContract(NAME);
  // WI16-H-1: authorities are constructor arguments; C-2/C-1c: Jubjub keys.
  const c = await deploy(mod, {}, [
    OWNER.pk, HAT.pk, { bytes: b32(0xa2) },
    { bytes: b32(0x21) }, { bytes: b32(0x23) }, newMachineKey().pk, b32(0xa4),
  ]);
  return Object.assign(c, { mod });
}
const ownerCall = (c, circuit, args) =>
  c.call(circuit, ...args, signOwnerAction(c.mod, c, circuit, args, { sk: OWNER.sk }));

test('EBT-1: attestationKey computed in JS is the key the circuit derives', { skip }, async () => {
  const c = await setup([]);
  const producerBytes = Buffer.alloc(32, 0x51);
  const meterKeyHash = Buffer.alloc(32, 0x52);
  const key = M.persistentHash([producerBytes, meterKeyHash]);
  // The circuit asserts attestationKey == persistentHash<Vector<2>>([producerBytes, meterKeyHash]).
  await ownerCall(c, 'attestProducerOwnership', [new Uint8Array(key), producerBytes, meterKeyHash, 1n, b32(0x53), 0n]);
  assert.equal(c.ledger().producerAttestations.member(new Uint8Array(key)), true);
  // And a wrong key is refused, so the assert is really comparing.
  await assert.rejects(
    ownerCall(c, 'attestProducerOwnership', [b32(0x99), producerBytes, Buffer.alloc(32, 0x54), 1n, b32(0x53), 0n]),
    /attestation\/producer mismatch/,
  );
});

test('EBT-2: a HAT built off-chain from the documented layout is accepted by settle', { skip }, async () => {
  const c = await setup();
  const sessionID = Buffer.alloc(32, 0x61);
  const amount = 0x0102030405n; // asymmetric bytes: a byte-order mistake changes the hash
  const producerKey = Buffer.alloc(32, 0x63);
  const producerAddr = Buffer.alloc(32, 0x64);
  const meterKeyHash = Buffer.alloc(32, 0x65);
  // Service-side builder: transientHash over Vector<7, Bytes<32>>, integers little-endian.
  const msg = RTlib.transientHash(new RTlib.CompactTypeVector(7, new RTlib.CompactTypeBytes(32)), [
    padTag('pollpower:ebt:v9:hat'), c.addressBytes, sessionID,
    new Uint8Array(RTlib.convertBigintToBytes(32, amount, 'amount')), producerKey, producerAddr, meterKeyHash,
  ]);
  const settle = (sig) => c.call('settle', sessionID, amount, producerKey, { bytes: producerAddr }, meterKeyHash, sig,
    b32(0), b32(0), 0n, 1n, [b32(0), b32(0), b32(0), b32(0)], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n],
    0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
  // Signature accepted: settle moves on to the producer-attestation check.
  await assert.rejects(settle(signMessage(msg, HAT.sk)), /PRODUCER_NOT_ATTESTED/);
  // Same builder with the old v8 tag: refused.
  const old = RTlib.transientHash(new RTlib.CompactTypeVector(7, new RTlib.CompactTypeBytes(32)), [
    padTag('pollpower:ebt:v8:epoch1'), c.addressBytes, sessionID,
    new Uint8Array(RTlib.convertBigintToBytes(32, amount, 'amount')), producerKey, producerAddr, meterKeyHash,
  ]);
  await assert.rejects(settle(signMessage(old, HAT.sk)), /Bad HAT signature/);
});
