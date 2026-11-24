// WI16-C-1b (TariffRegistry): federation-gated operations ask Multisig v8
// `isApproved` through a ledger 9 cross-contract call; replay protection stays
// in the registry (_consumedFederationApprovals).
//
// Before WI-16, consumeFederationApproval asserted
// `multisig_signature_valid(actionHash, _federationAuthority)`, a
// prover-supplied witness. The witnesses below include a LYING
// multisig_signature_valid that always answers true: before the fix that is
// the PoC; after it the witness no longer exists and cannot be reached.
//
// Exercised op: setNationalContext (op 4). Its action hash, as computed in the
// circuit: persistentHash([pad("pp:tariff:v1:setNationalContext"), self,
// currentEpoch, ldFloorBps, opsFloorBps, sanityBandPct]) with integers as
// (x as Field) as Bytes<32> (little-endian, WI16-T-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, createWorld, b32, hex, runtimePersistentHash, padTag } from '../parity/harness.mjs';
import { newCouncilKey, approvalDigest, signDigest } from './council-signer.mjs';

const NAME = 'tariff-registry-v1';
const skip = buildExists(NAME) && buildExists('multisig-v8') ? false : 'builds missing: run `npm run build:contracts` (multisig-v8 needs --zk)';
const DEPTH = 24;
const NOT_APPROVED = /FEDERATION_APPROVAL_INVALID/;

const unused = (n) => () => { throw new Error(`witness ${n} must not be called`); };
const witnesses = {
  signature_valid: unused('signature_valid'),
  multisig_signature_valid: (ctx) => [ctx.privateState, true], // the PoC's lying witness
  charter_membership_proof: unused('charter_membership_proof'),
  witness_divmod: unused('witness_divmod'),
  // Safe witness: the circuit rebuilds `seq` from these bits and rejects a mismatch.
  action_log_path_bits: (ctx, seq) => [ctx.privateState, Array.from({ length: DEPTH }, (_, i) => ((seq >> BigInt(i)) & 1n) === 1n)],
};

const le32 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 0; x > 0n; i++, x >>= 8n) b[i] = Number(x & 0xffn); return b; };

async function setup() {
  const world = createWorld();
  const ms = await loadContract('multisig-v8');
  const tr = await loadContract(NAME);
  const keys = Array.from({ length: 7 }, newCouncilKey);
  const deployCouncil = async () =>
    world.register(await deploy(ms, {}, [keys.map((k) => k.point), 3n, 2n], {}, { world }), ms, 'multisig-v8');
  const council = await deployCouncil();
  const deployTr = async (c) => {
    const t = await deploy(tr, witnesses, [{ bytes: c.addressBytes }, b32(0xa2), 100n], {}, { world });
    await t.call('bootstrapActionLog', BigInt(DEPTH));
    return t;
  };
  const t = await deployTr(council);
  const ctxHash = (target, [ld, ops, band]) => runtimePersistentHash([
    padTag('pp:tariff:v1:setNationalContext'), target.addressBytes,
    le32(target.ledger()._currentEpoch), le32(ld), le32(ops), le32(band),
  ]);
  const approve = async (hash, slots = [0, 1], on = council) => {
    for (const i of slots) {
      await on.call('approve', hash, BigInt(i), signDigest(approvalDigest(ms, on.addressBytes, hash, 0n), keys[i].sk));
    }
  };
  const setCtx = (args, target = t, time = 1000n) => target.call('setNationalContext', ...args.map(BigInt), time);
  return { tr, t, council, deployCouncil, deployTr, ctxHash, approve, setCtx };
}

const CTX = [300, 2500, 25];

test('C1b-TR-0: no council witness left; the council is a sealed contract reference; op 5 gone', { skip }, async () => {
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, NAME, 'compiler', 'contract-info.json'), 'utf8'));
  assert.ok(Array.isArray(info.witnesses));
  assert.ok(!info.witnesses.some((w) => w.name === 'multisig_signature_valid'), 'multisig_signature_valid must be gone');
  assert.ok(!info.circuits.some((c) => c.name === 'setFederationAuthority'), 'setFederationAuthority must be gone');
  const { t, council } = await setup();
  assert.equal(hex(t.ledger()._council.bytes), hex(council.addressBytes));
  assert.equal(t.ledger()._federationAuthority, undefined);
});

test('C1b-TR-1 (negative, PoC): a lying witness and no approvals cannot set the national context', { skip }, async () => {
  const { setCtx, t } = await setup();
  await assert.rejects(setCtx(CTX), NOT_APPROVED);
  assert.equal(t.ledger()._hasPendingContext, false);
});

test('C1b-TR-2 (negative): one approval of a 2-of-3 council is not enough', { skip }, async () => {
  const { setCtx, ctxHash, approve, t } = await setup();
  await approve(ctxHash(t, CTX), [2]);
  await assert.rejects(setCtx(CTX), NOT_APPROVED);
});

test('C1b-TR-3 (negative): an approval binds the values', { skip }, async () => {
  const { setCtx, ctxHash, approve, t } = await setup();
  await approve(ctxHash(t, CTX));
  await assert.rejects(setCtx([300, 2500, 26]), NOT_APPROVED);
});

test('C1b-TR-4 (negative): an approval for another registry cannot be used here', { skip }, async () => {
  const { setCtx, ctxHash, approve, council, deployTr } = await setup();
  const other = await deployTr(council);
  await approve(ctxHash(other, CTX)); // approved for `other`, same council
  await assert.rejects(setCtx(CTX), NOT_APPROVED); // not usable on `t`
  await setCtx(CTX, other); // works where it was approved
});

test('C1b-TR-5 (negative): approvals in a different council do not count', { skip }, async () => {
  const { setCtx, ctxHash, approve, deployCouncil, t } = await setup();
  const rogue = await deployCouncil();
  await approve(ctxHash(t, CTX), [0, 1], rogue);
  await assert.rejects(setCtx(CTX), NOT_APPROVED);
});

test('C1b-TR-6 (negative): an executed approval cannot be replayed', { skip }, async () => {
  const { setCtx, ctxHash, approve, t } = await setup();
  await approve(ctxHash(t, CTX));
  await setCtx(CTX);
  await assert.rejects(setCtx(CTX), /FEDERATION_APPROVAL_REPLAYED/);
});

test('C1b-TR-7: 2-of-3 approval sets the national context and logs the action', { skip }, async () => {
  const { setCtx, ctxHash, approve, t } = await setup();
  const h = ctxHash(t, CTX);
  const seqBefore = t.ledger()._actionSeq;
  await approve(h);
  await setCtx(CTX);
  const L = t.ledger();
  assert.equal(L._hasPendingContext, true);
  assert.equal(L._pendingLDFloorBps, 300n);
  assert.equal(L._pendingOpsFloorBps, 2500n);
  assert.equal(L._pendingSanityBandPct, 25n);
  assert.equal(L._consumedFederationApprovals.member(h), true, 'JS action hash == circuit action hash');
  assert.equal(L._actionSeq, seqBefore + 1n);
});
