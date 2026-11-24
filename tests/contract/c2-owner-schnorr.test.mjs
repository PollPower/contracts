// WI16-C-2: the EBT owner proves a Jubjub key with a Schnorr signature over
// the exact action, verified in-circuit (stdlib jubjubSchnorrVerify). Before
// the fix, assertOnlyOwner() compared ownPublicKey() (a witness the submitter
// controls) with the public owner field, so anyone passed.
//
// Interface under test:
//   constructor(ownerPk: JubjubPoint, ...authorities)
//   ledger _ownerPk: JubjubPoint, _ownerNonce: Counter
//   pure ownerDigest_<circuit>(args...) -> Bytes<32>
//   pure ownerActionMessage(self, action, argsDigest, nonce) -> Field
//   every owner-gated circuit takes a final `ownerSig: JubjubSchnorrSignature`
//   and checks it first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, b32 } from '../parity/harness.mjs';
import { newOwnerKey, signOwnerAction, garbageSignature } from './owner-signer.mjs';
import { newMachineKey } from './machine-signer.mjs';

const NAME = 'ebt-v8';
const skip = buildExists(NAME) ? false : 'build/l9/ebt-v8 missing: run `npm run build:contracts`';
const unused = (n) => () => { throw new Error(`witness ${n} must not be called`); };
const witnesses = { signature_valid: unused('signature_valid'), multisig_signature_valid: unused('multisig_signature_valid') };
// WI16-C-1c: the meter authority and escrow attestor are Jubjub keys.
const AUTH = newMachineKey();
const ESCROW = newMachineKey();
const ONLY_OWNER = /Only owner/;

const ctorArgs = (ownerPk) => [
  ownerPk, AUTH.pk, { bytes: b32(0xa2) }, { bytes: b32(0x21) }, { bytes: b32(0x23) }, ESCROW.pk, b32(0xa4),
];
async function setup() {
  const mod = await loadContract(NAME);
  const owner = newOwnerKey();
  const c = await deploy(mod, witnesses, ctorArgs(owner.pk));
  return { mod, c, owner };
}

// A valid argument list (without ownerSig) for each owner-gated circuit.
const ZERO_TARIFF_PATH = { scheduleId: b32(0), classPath: b32(0), epoch: 0n, fiatValueAtMint: 0n };
const ZERO_ENTRY = { kind: 0n, scheduleId: b32(0), nodeId: b32(0), epoch: 0n, actionHash: b32(0), emittedAt: 0n, payloadHash: b32(0) };
const ZERO_PROOF = { actionSeq: 0n, payloadHash: b32(0), merkleProof: Array.from({ length: 24 }, () => b32(0)), merkleSiblings: Array(24).fill(false) };
const ARGS = {
  attestProducerOwnership: { digest: [b32(0x31), b32(0x32), b32(0x33), 1n, b32(0x34), 0n], extra: [] },
  revokeProducerOwnership: { digest: [b32(0x31), 1n, b32(0x34), 0n], extra: [] },
  claimSplit: { digest: [0n, 0n], extra: [] },
  execOwnerOp: { digest: [1n, { x: 0n, y: 1n }, AUTH.pk], extra: [] },
  manualReissue: { digest: [b32(0x36), { bytes: b32(0x37) }, 1n, 1n, b32(0x38), ZERO_TARIFF_PATH, 0n], extra: [garbageSignature()] },
  mirrorActionLogRoot: { digest: [b32(0x39), ZERO_ENTRY], extra: [ZERO_PROOF] },
};
const callArgs = (circuit, sig) => [...ARGS[circuit].digest, ...ARGS[circuit].extra, sig];

test('C2-0: ownPublicKey()-based owner field is gone; the owner is a Jubjub key', { skip }, async () => {
  const { c, owner } = await setup();
  const L = c.ledger();
  assert.equal(L._owner, undefined, 'the Either<ZswapCoinPublicKey, ...> owner field must be removed');
  assert.deepEqual(L._ownerPk, owner.pk);
  assert.equal(L._ownerNonce, 0n);
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, NAME, 'compiler', 'contract-info.json'), 'utf8'));
  assert.ok(info.circuits.some((x) => x.name === 'ownerActionMessage' && x.pure), 'ownerActionMessage must be an exported pure circuit');
});

for (const circuit of Object.keys(ARGS)) {
  test(`C2-1 (negative, PoC): ${circuit} rejects a forged signature`, { skip }, async () => {
    const { c } = await setup();
    await assert.rejects(c.call(circuit, ...callArgs(circuit, garbageSignature())), ONLY_OWNER);
  });
}

test('C2-2 (negative): a real signature by another key is rejected', { skip }, async () => {
  const { mod, c } = await setup();
  const attacker = newOwnerKey();
  const sig = signOwnerAction(mod, c, 'attestProducerOwnership', ARGS.attestProducerOwnership.digest, { sk: attacker.sk });
  await assert.rejects(c.call('attestProducerOwnership', ...callArgs('attestProducerOwnership', sig)), ONLY_OWNER);
});

test('C2-3: the owner signature is accepted and the nonce advances', { skip }, async () => {
  const { mod, c, owner } = await setup();
  const [key, producer, meter, reason, evidence, time] = ARGS.attestProducerOwnership.digest;
  // attestationKey must equal persistentHash([producer, meter]) for the call to pass its own check.
  const { createHash } = await import('node:crypto');
  const realKey = new Uint8Array(createHash('sha256').update(Buffer.concat([producer, meter])).digest());
  const digestArgs = [realKey, producer, meter, reason, evidence, time];
  const sig = signOwnerAction(mod, c, 'attestProducerOwnership', digestArgs, { sk: owner.sk });
  await c.call('attestProducerOwnership', ...digestArgs, sig);
  assert.equal(c.ledger()._ownerNonce, 1n);
  assert.equal(c.ledger().producerAttestations.member(realKey), true);
  void key;
});

test('C2-4 (negative): a signature for other arguments is rejected', { skip }, async () => {
  const { mod, c, owner } = await setup();
  const sig = signOwnerAction(mod, c, 'claimSplit', [0n, 0n], { sk: owner.sk });
  await assert.rejects(c.call('claimSplit', 2n, 0n, sig), ONLY_OWNER); // signed kind 0, submitted kind 2
});

test('C2-5 (negative): a used signature cannot be replayed (nonce)', { skip }, async () => {
  const { mod, c, owner } = await setup();
  const newAuth = AUTH.pk;
  const sig = signOwnerAction(mod, c, 'execOwnerOp', [1n, { x: 0n, y: 1n }, newAuth], { sk: owner.sk });
  await c.call('execOwnerOp', 1n, { x: 0n, y: 1n }, newAuth, sig); // op 1 = setMeterAuthority
  await assert.rejects(c.call('execOwnerOp', 1n, { x: 0n, y: 1n }, newAuth, sig), ONLY_OWNER);
});

test('C2-6 (negative): a signature bound to another contract address is rejected', { skip }, async () => {
  const { mod, c, owner } = await setup();
  const sig = signOwnerAction(mod, c, 'claimSplit', [0n, 0n], { sk: owner.sk, addressBytes: b32(0x77) });
  await assert.rejects(c.call('claimSplit', 0n, 0n, sig), ONLY_OWNER);
});

test('C2-7: transferOwnership rotates the key; the old key stops working', { skip }, async () => {
  const { mod, c, owner } = await setup();
  const next = newOwnerKey();
  const sig = signOwnerAction(mod, c, 'execOwnerOp', [0n, next.pk, AUTH.pk], { sk: owner.sk });
  await c.call('execOwnerOp', 0n, next.pk, AUTH.pk, sig); // op 0 = transferOwnership
  assert.deepEqual(c.ledger()._ownerPk, next.pk);
  const old = signOwnerAction(mod, c, 'execOwnerOp', [1n, { x: 0n, y: 1n }, AUTH.pk], { sk: owner.sk });
  await assert.rejects(c.call('execOwnerOp', 1n, { x: 0n, y: 1n }, AUTH.pk, old), ONLY_OWNER);
  const fresh = signOwnerAction(mod, c, 'execOwnerOp', [1n, { x: 0n, y: 1n }, AUTH.pk], { sk: next.sk });
  await c.call('execOwnerOp', 1n, { x: 0n, y: 1n }, AUTH.pk, fresh);
  assert.equal(c.ledger()._ownerNonce, 2n);
});
