// Parity: EBT v8 compiled with Compact 0.36.1 vs the JS mirror
// (ebt/tests/lib.mjs) and the settle payload builder in ebt/settle-flow/ceremony.mjs.
//
// The recording witness below does NOT authorise anything: it captures the
// message hash the circuit hands to `signature_valid`, then aborts the call.
// (Authorisation through witnesses is finding WI16-C-1; see docs/findings-status.md.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../ebt/tests/lib.mjs';
import { buildExists, loadContract, deploy, b32, hex, runtimePersistentHash, padTag, RTlib } from './harness.mjs';
import { newOwnerKey, signOwnerAction } from '../contract/owner-signer.mjs';

const NAME = 'ebt-v8';
const skip = buildExists(NAME) ? false : 'build/l9/ebt-v8 missing: run `npm run build:contracts`';

class Captured extends Error {}

async function setup(captured) {
  const witnesses = {
    signature_valid: (ctx, pubkey, messageHash, signature) => {
      captured.push({ pubkey, messageHash, signature });
      throw new Captured('captured');
    },
    multisig_signature_valid: () => { throw new Error('multisig witness must not be reached'); },
  };
  const mod = await loadContract(NAME);
  // WI16-H-1: authorities are constructor arguments; WI16-C-2: the owner is a Jubjub key.
  const c = await deploy(mod, witnesses, [
    OWNER.pk, b32(0xa1), b32(0xa2),
    { bytes: b32(0x21) }, { bytes: b32(0x22) }, { bytes: b32(0x23) }, b32(0xa3), b32(0xa4),
  ]);
  return Object.assign(c, { mod });
}
const OWNER = newOwnerKey();
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

test('EBT-2: settle HAT payload hash == mirror signHat payload == ceremony.mjs builder', { skip }, async () => {
  const captured = [];
  const c = await setup(captured);
  const sessionID = Buffer.alloc(32, 0x61);
  const hatPubkey = Buffer.from(b32(0xa1)); // must equal the meter authority set at initialize
  const amount = 0x0102030405n; // asymmetric bytes: a byte-order mistake changes the hash
  const producerKey = Buffer.alloc(32, 0x63);
  const producerAddr = Buffer.alloc(32, 0x64);

  await assert.rejects(
    c.call('settle',
      sessionID, hatPubkey, amount, producerKey, { bytes: producerAddr }, Buffer.alloc(32, 0x65), new Uint8Array(64),
      b32(0), b32(0), 0n, 0n, [b32(0), b32(0), b32(0), b32(0)], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n],
      0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n),
    Captured,
  );
  assert.equal(captured.length, 1, 'settle must reach the HAT signature check exactly once');
  const { pubkey, messageHash } = captured[0];
  assert.equal(hex(pubkey), hex(hatPubkey));

  // Mirror (ebt/tests/lib.mjs signHat): SHA-256 over the six 32-byte fields, amount via u64ToBytes32.
  const mirror = M.persistentHash([
    M.pad32(M.EBT_DOMAIN.HAT), sessionID, hatPubkey, M.u64ToBytes32(amount), producerKey, producerAddr,
  ]);
  // ceremony.mjs: compact-runtime persistentHash, amount as 32 bytes. Runtime
  // 0.16 called this convertFieldToBytes; 0.21 renamed it convertBigintToBytes
  // (same signature), which is what the compiled 0.36.1 contract itself calls.
  const ceremony = runtimePersistentHash([
    padTag('pollpower:ebt:v8:epoch1'), sessionID, hatPubkey,
    new Uint8Array(RTlib.convertBigintToBytes(32, amount, 'amount')), producerKey, producerAddr,
  ]);

  assert.equal(hex(messageHash), hex(ceremony), 'circuit HAT payload != ceremony.mjs builder');
  assert.equal(hex(messageHash), hex(mirror), 'circuit HAT payload != JS mirror (signHat)');
});
