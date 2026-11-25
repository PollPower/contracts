// WI16-C-1b (EBT): council-gated operations ask Multisig v8 `isApproved`
// through a ledger 9 cross-contract call and keep their own replay record.
//
// Before WI-16, execMultisigOp asserted `multisig_signature_valid(payload,
// authorityHash)`: a prover-supplied witness, so any prover could execute
// every council operation (PoC 2026-11-23). These tests run EBT v8 and a real
// Multisig v8 together (cross-contract calls checked against Multisig v8's
// real verifier keys).
//
// Interface under test:
//   constructor(ownerPk, meterAuthorityPubkey, council: Council, opsRecipient,
//               daoRecipient, escrowAttestorPubkey, registry)
//   pure councilActionHash(self, op, ldAddr, newEscrowAttestor, currentTime) -> Bytes<32>
//   execMultisigOp(op, ldAddr, newEscrowAttestor, currentTime)
//     op 0 bindLivingDividend (once), 4 setEscrowAttestor. Op 3 (authority rotation)
//     removed in C-1b (the council rotates inside Multisig v8); ops 1 (clear LD) and
//     2 (dividend recipient) removed with LD v3 (tests/contract/ld3-ebt-side.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, createWorld, b32, hex } from '../parity/harness.mjs';
import { newCouncilKey, approvalDigest, signDigest } from './council-signer.mjs';
import { newOwnerKey } from './owner-signer.mjs';
import { newMachineKey } from './machine-signer.mjs';

const skip = buildExists('ebt-v8') && buildExists('multisig-v8') ? false : 'builds missing: run `npm run build:contracts` (multisig-v8 needs --zk)';
const unused = (n) => () => { throw new Error(`witness ${n} must not be called`); };
const NOT_APPROVED = /Council has not approved/;

const LD = { bytes: b32(0x4d) };
const ATTESTOR = newMachineKey().pk; // WI16-C-1c: the escrow attestor is a Jubjub key

async function setup() {
  const world = createWorld();
  const ms = await loadContract('multisig-v8');
  const ebt = await loadContract('ebt-v8');
  const keys = Array.from({ length: 7 }, newCouncilKey);
  const deployCouncil = async () =>
    world.register(await deploy(ms, {}, [keys.map((k) => k.point), 3n, 2n], {}, { world }), ms, 'multisig-v8');
  const council = await deployCouncil();
  const deployEbt = async (councilHandle) => deploy(ebt, { signature_valid: unused('signature_valid') }, [
    newOwnerKey().pk, newMachineKey().pk, { bytes: councilHandle.addressBytes },
    { bytes: b32(0x21) }, { bytes: b32(0x23) }, newMachineKey().pk, { bytes: b32(0xa4) },
  ], {}, { world });
  const e = await deployEbt(council);

  const actionHash = (target, op, time, args = {}) => ebt.pureCircuits.councilActionHash(
    target.addressBytes, op, args.ld ?? LD, args.attestor ?? ATTESTOR, time);
  const approve = async (hash, slots = [0, 1], on = council) => {
    for (const i of slots) {
      await on.call('approve', hash, BigInt(i), signDigest(approvalDigest(ms, on.addressBytes, hash, 0n), keys[i].sk));
    }
  };
  const exec = (op, time, args = {}, target = e) =>
    target.call('execMultisigOp', op, args.ld ?? LD, args.attestor ?? ATTESTOR, time);
  return { ebt, e, council, deployCouncil, deployEbt, actionHash, approve, exec };
}

test('C1b-EBT-0: no council witness left; the council is a sealed contract reference', { skip }, async () => {
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, 'ebt-v8', 'compiler', 'contract-info.json'), 'utf8'));
  assert.ok(Array.isArray(info.witnesses));
  assert.ok(!info.witnesses.some((w) => w.name === 'multisig_signature_valid'), 'multisig_signature_valid must be gone');
  const { e, council } = await setup();
  const L = e.ledger();
  assert.equal(hex(L._council.bytes), hex(council.addressBytes));
  assert.equal(L._multisigAuthority, undefined);
  assert.equal(L._authorityRotationNonce, undefined);
});

test('C1b-EBT-1 (negative, PoC): no approvals, no execution', { skip }, async () => {
  const { exec, e } = await setup();
  for (const op of [0n, 4n]) await assert.rejects(exec(op, 1000n), NOT_APPROVED, `op ${op}`);
  assert.equal(e.ledger()._livingDividendAddress.is_some, false);
});

test('C1b-EBT-2 (negative): one approval of a 2-of-3 council is not enough', { skip }, async () => {
  const { exec, actionHash, approve, e } = await setup();
  await approve(actionHash(e, 0n, 1000n), [0]);
  await assert.rejects(exec(0n, 1000n), NOT_APPROVED);
});

test('C1b-EBT-3 (negative): an approval binds every argument and the time', { skip }, async () => {
  const { exec, actionHash, approve, e } = await setup();
  await approve(actionHash(e, 0n, 1000n));
  await assert.rejects(exec(0n, 1000n, { ld: { bytes: b32(0x99) } }), NOT_APPROVED, 'other LD address');
  await assert.rejects(exec(4n, 1000n), NOT_APPROVED, 'other op');
  await assert.rejects(exec(0n, 1001n), NOT_APPROVED, 'other time');
  await assert.rejects(exec(0n, 1000n, { attestor: newMachineKey().pk }), NOT_APPROVED, 'unused field still bound');
});

test('C1b-EBT-4 (negative): an approval for another EBT deployment cannot be used here', { skip }, async () => {
  const { exec, actionHash, approve, council, deployEbt } = await setup();
  const other = await deployEbt(council);
  await approve(actionHash(other, 0n, 1000n)); // approved for `other`
  await assert.rejects(exec(0n, 1000n), NOT_APPROVED);
  await exec(0n, 1000n, {}, other); // and it does work there
});

test('C1b-EBT-5 (negative): approvals in a different council do not count', { skip }, async () => {
  const { exec, actionHash, approve, deployCouncil, e } = await setup();
  const rogue = await deployCouncil(); // same keys, different contract
  await approve(actionHash(e, 0n, 1000n), [0, 1], rogue);
  await assert.rejects(exec(0n, 1000n), NOT_APPROVED);
});

test('C1b-EBT-6 (negative): an executed approval cannot be replayed', { skip }, async () => {
  const { exec, actionHash, approve, e } = await setup();
  await approve(actionHash(e, 0n, 1000n));
  await exec(0n, 1000n);
  await assert.rejects(exec(0n, 1000n), /Action already executed/);
});

test('C1b-EBT-7 (negative): ops 1, 2 (LD v3) and 3 (authority rotation) are gone; unknown ops rejected', { skip }, async () => {
  const { exec, actionHash, approve, e } = await setup();
  for (const op of [1n, 2n, 3n, 5n]) {
    await approve(actionHash(e, op, 1000n));
    await assert.rejects(exec(op, 1000n), /execMultisigOp: bad op/, `op ${op}`);
  }
});

test('C1b-EBT-8 (negative): a timestamp in the future is rejected', { skip }, async () => {
  const { exec, actionHash, approve, e } = await setup();
  const future = BigInt(Math.floor(Date.now() / 1000) + 86400 * 365);
  await approve(actionHash(e, 0n, future));
  await assert.rejects(exec(0n, future), /timestamp cannot be in the future/);
});

test('C1b-EBT-9: 2-of-3 approval executes each council operation', { skip }, async () => {
  const { exec, actionHash, approve, e } = await setup();
  await approve(actionHash(e, 0n, 1000n));
  await exec(0n, 1000n);
  assert.equal(hex(e.ledger()._livingDividendAddress.value.bytes), hex(LD.bytes));

  await approve(actionHash(e, 4n, 1002n));
  await exec(4n, 1002n);
  assert.deepEqual(e.ledger()._escrowAttestorPubkey, ATTESTOR);
});
