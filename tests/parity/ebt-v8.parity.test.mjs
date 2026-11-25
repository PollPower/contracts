// Parity: EBT v8 compiled with Compact 0.36.1 vs the JS mirror
// (ebt/tests/lib.mjs) and an independent off-chain HAT builder.
//
// Since WI16-C-1c the HAT is a Jubjub Schnorr signature verified in-circuit
// (no witness). EBT-2 builds the chip digest and the HAT message with
// compact-runtime's transientHash from the documented layouts, NOT through the
// contract's pure circuits, and checks the circuit accepts the result: that is
// the parity meter-authority-service (and pp-settle-service) must meet.
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
    { bytes: b32(0x21) }, { bytes: b32(0x23) }, newMachineKey().pk, { bytes: b32(0xa4) },
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

test('EBT-2: a HAT built off-chain from the documented layouts is accepted by settle', { skip }, async () => {
  const c = await setup();
  const V = (n) => new RTlib.CompactTypeVector(n, new RTlib.CompactTypeBytes(32));
  const le = (x) => new Uint8Array(RTlib.convertBigintToBytes(32, x, 'x'));
  const sessionID = Buffer.alloc(32, 0x61);
  const amount = 0x0102030405n; // asymmetric bytes: a byte-order mistake changes the hash
  const producerKey = Buffer.alloc(32, 0x63);
  const producerAddr = Buffer.alloc(32, 0x64);
  const meterKeyHash = Buffer.alloc(32, 0x65);
  const chipHwId = Buffer.concat([Buffer.alloc(8, 0x6a), Buffer.from([0, 0, 0, 9]), Buffer.alloc(20)]);
  const chipSessionUwh = amount * 1000n + 7n;
  const chipUptimeMs = 9000n;
  const chipNonce = 7n;
  const chipPubkey = Buffer.alloc(32, 0x66);
  const chipSigR = Buffer.alloc(32, 0x67);
  const chipSigS = Buffer.alloc(32, 0x68);
  // Off-chain builders (what the services implement): transientHash, integers little-endian.
  const recordDigest = le(RTlib.transientHash(V(11), [
    padTag('pollpower:hat:record:v1'), c.addressBytes, sessionID, le(amount), producerKey, producerAddr,
    meterKeyHash, chipHwId, le(chipSessionUwh), le(chipUptimeMs), le(chipNonce)]));
  const hatMsg = (tag) => RTlib.transientHash(V(6), [padTag(tag), c.addressBytes, recordDigest, chipPubkey, chipSigR, chipSigS]);
  const settle = (sig) => c.call('settle', sessionID, amount, producerKey, { bytes: producerAddr }, meterKeyHash,
    chipHwId, chipSessionUwh, chipUptimeMs, chipNonce, chipPubkey, chipSigR, chipSigS, sig,
    b32(0), b32(0), 0n, 1n, [b32(0), b32(0), b32(0), b32(0)], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n],
    0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
  // Signature accepted: settle moves on to the producer-attestation check.
  await assert.rejects(settle(signMessage(hatMsg('pollpower:ebt:v9:hat'), HAT.sk)), /PRODUCER_NOT_ATTESTED/);
  // Same builder with the old v8 tag: refused.
  await assert.rejects(settle(signMessage(hatMsg('pollpower:ebt:v8:epoch1'), HAT.sk)), /Bad HAT signature/);
});
