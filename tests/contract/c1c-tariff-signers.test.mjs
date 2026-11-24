// WI16-C-1c (TariffRegistry): validator and operator signatures are verified
// in-circuit.
//
// Before WI-16:
//  - registerSchedule asserted `signature_valid(validatorAttestor, actionHash,
//    sig)` with `validatorAttestor` a free argument and `signature_valid` a
//    prover-supplied witness: the "validator verdict" checked nothing.
//  - the council-approved actionHash left out operatorPubkey and
//    refRateFiatPerKwh, so whoever submitted an approved registration first
//    chose the schedule's operator (the key that may retune its splits) and its
//    reference rate.
//  - retuneClass asserted `signature_valid(operatorId, retuneAuthHash, sig)`.
// The witnesses below include that LYING `signature_valid`.
//
// Now:
//  - constructor(council, governanceRoot, refRateFiatPerKwh, validatorPk)
//  - the validator is a Jubjub key in the ledger, rotated only with council
//    approval (setValidator);
//  - registerScheduleActionHash binds nodeId, scheduleHash, operator key id,
//    refRate, effectiveEpoch, currentEpoch and the registry address; the
//    validator signs signerMessage(actionHash) and the council approves actionHash;
//  - a schedule stores operatorKeyId(pk) = persistentHash(pk); retuneClass takes
//    the operator's Jubjub key, checks its id, and verifies the signature on
//    signerMessage(retuneAuthHash(...)).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, createWorld, b32, runtimePersistentHash, padTag } from '../parity/harness.mjs';
import { newCouncilKey, approvalDigest, signDigest } from './council-signer.mjs';
import { garbageSignature } from './owner-signer.mjs';
import { newMachineKey, signMessage } from './machine-signer.mjs';

const NAME = 'tariff-registry-v1';
const skip = buildExists(NAME) && buildExists('multisig-v8') ? false : 'builds missing: run `npm run build:contracts` (multisig-v8 needs --zk)';
const DEPTH = 24;
const REF_RATE = 100n;
const NOW = 1000n;

// Charter tree of one node: all-left path with zero siblings.
const NODE = b32(0x0e);
const ZERO = b32(0);
const charterProof = { siblings: Array(12).fill(ZERO), indices: Array(12).fill(false) };
const charterRoot = (() => {
  let h = runtimePersistentHash([padTag('pp:fed:charter:leaf'), NODE]);
  for (let i = 0; i < 12; i++) h = runtimePersistentHash([padTag('pp:fed:charter:node'), h, ZERO]);
  return h;
})();

const unused = (n) => () => { throw new Error(`witness ${n} must not be called`); };
const witnesses = {
  signature_valid: (ctx) => [ctx.privateState, true], // the PoC's lying witness
  charter_membership_proof: (ctx) => [ctx.privateState, charterProof],
  witness_divmod: unused('witness_divmod'),
  action_log_path_bits: (ctx, seq) => [ctx.privateState, Array.from({ length: DEPTH }, (_, i) => ((seq >> BigInt(i)) & 1n) === 1n)],
};

async function setup() {
  const world = createWorld();
  const ms = await loadContract('multisig-v8');
  const tr = await loadContract(NAME);
  const keys = Array.from({ length: 7 }, newCouncilKey);
  const council = world.register(await deploy(ms, {}, [keys.map((k) => k.point), 3n, 2n], {}, { world }), ms, 'multisig-v8');
  const validator = newMachineKey();
  const deployTr = async () => {
    const t = await deploy(tr, witnesses, [{ bytes: council.addressBytes }, charterRoot, REF_RATE, validator.pk], {}, { world });
    await t.call('bootstrapActionLog', BigInt(DEPTH));
    return t;
  };
  const t = await deployTr();
  const approve = async (hash, slots = [0, 1]) => {
    for (const i of slots) {
      await council.call('approve', hash, BigInt(i), signDigest(approvalDigest(ms, council.addressBytes, hash, 0n), keys[i].sk));
    }
  };
  const P = tr.pureCircuits;
  return { tr, P, t, council, validator, deployTr, approve };
}

// ------------------------------------------------------ registerSchedule ---

const operator = newMachineKey();
const REG = (P) => ({
  nodeId: NODE, scheduleHash: b32(0x5c), operatorKeyId: P.operatorKeyId(operator.pk), refRate: REF_RATE, effectiveEpoch: 1n,
});
const regHash = (P, target, r) => P.registerScheduleActionHash(
  target.addressBytes, r.nodeId, r.scheduleHash, r.operatorKeyId, r.refRate, r.effectiveEpoch, target.ledger()._currentEpoch);
const register = (target, r, sig) =>
  target.call('registerSchedule', r.nodeId, r.scheduleHash, r.operatorKeyId, r.refRate, r.effectiveEpoch, sig, NOW);
const BAD_VALIDATOR = /VALIDATOR_VERDICT_INVALID/;

test('C1c-TR-0: no signature witness left; the validator is a Jubjub key in the ledger', { skip }, async () => {
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, NAME, 'compiler', 'contract-info.json'), 'utf8'));
  assert.ok(!info.witnesses.some((w) => w.name === 'signature_valid'), 'signature_valid must be gone');
  const { t, validator } = await setup();
  assert.equal(t.ledger()._validatorPk.x, validator.pk.x);
  assert.equal(t.ledger()._validatorPk.y, validator.pk.y);
});

test('C1c-TR-V1 (negative, PoC): a lying witness and a garbage validator signature cannot register', { skip }, async () => {
  const { P, t, approve } = await setup();
  const r = REG(P);
  await approve(regHash(P, t, r)); // even with the council's approval
  await assert.rejects(register(t, r, garbageSignature()), BAD_VALIDATOR);
});

test('C1c-TR-V2 (negative): the validator verdict must come from the registry\'s validator key', { skip }, async () => {
  const { P, t, approve } = await setup();
  const r = REG(P);
  await approve(regHash(P, t, r));
  await assert.rejects(register(t, r, signMessage(P.signerMessage(regHash(P, t, r)), newMachineKey().sk)), BAD_VALIDATOR);
  await assert.rejects(register(t, r, signMessage(P.signerMessage(regHash(P, t, r)), operator.sk)), BAD_VALIDATOR, 'operator key');
});

test('C1c-TR-V3 (negative, front-run): an approved registration cannot be resubmitted with another operator or rate', { skip }, async () => {
  const { P, t, approve, validator } = await setup();
  const r = REG(P);
  const h = regHash(P, t, r);
  await approve(h);
  const sig = signMessage(P.signerMessage(h), validator.sk);
  const thief = newMachineKey();
  await assert.rejects(register(t, { ...r, operatorKeyId: P.operatorKeyId(thief.pk) }, sig), BAD_VALIDATOR, 'operator swapped');
  await assert.rejects(register(t, { ...r, refRate: 1000n }, sig), BAD_VALIDATOR, 'refRate swapped');
  // Even with a validator verdict for the swapped values, the council approved the original only.
  const swapped = { ...r, operatorKeyId: P.operatorKeyId(thief.pk) };
  await assert.rejects(register(t, swapped, signMessage(P.signerMessage(regHash(P, t, swapped)), validator.sk)),
    /FEDERATION_APPROVAL_INVALID/);
});

test('C1c-TR-V4 (negative): a validator verdict for another registry is refused here', { skip }, async () => {
  const { P, t, approve, validator, deployTr } = await setup();
  const other = await deployTr();
  const r = REG(P);
  await approve(regHash(P, t, r));
  await assert.rejects(register(t, r, signMessage(P.signerMessage(regHash(P, other, r)), validator.sk)), BAD_VALIDATOR);
});

test('C1c-TR-V5: validator verdict + council approval registers the schedule with its operator', { skip }, async () => {
  const { P, t, approve, validator } = await setup();
  const r = REG(P);
  await approve(regHash(P, t, r));
  await register(t, r, signMessage(P.signerMessage(regHash(P, t, r)), validator.sk));
  const sid = t.ledger()._activeScheduleByNode.lookup(NODE);
  assert.deepEqual(t.ledger()._registeredSchedules.lookup(sid).operatorPubkey, r.operatorKeyId);
});

test('C1c-TR-V6: the validator rotates only with council approval; the old key stops working', { skip }, async () => {
  const { P, t, approve, validator } = await setup();
  const next = newMachineKey();
  const rot = P.setValidatorActionHash(t.addressBytes, next.pk, t.ledger()._currentEpoch, NOW);
  await assert.rejects(t.call('setValidator', next.pk, NOW), /FEDERATION_APPROVAL_INVALID/);
  await approve(rot);
  await t.call('setValidator', next.pk, NOW);
  assert.equal(t.ledger()._validatorPk.x, next.pk.x);
  await assert.rejects(t.call('setValidator', next.pk, NOW), /FEDERATION_APPROVAL_REPLAYED/);

  const r = REG(P);
  await approve(regHash(P, t, r));
  await assert.rejects(register(t, r, signMessage(P.signerMessage(regHash(P, t, r)), validator.sk)), BAD_VALIDATOR, 'old key');
  await register(t, r, signMessage(P.signerMessage(regHash(P, t, r)), next.sk));
});

// ----------------------------------------------------------- retuneClass ---

const CLASS = b32(0xc1);
const SPLIT = { producerShareBps: 5000n, ldShareBps: 500n, opsShareBps: 2500n, daoShareBps: 1000n, operatorMarginBps: 500n, statutoryTotalBps: 500n };
const DIV = { quotient: 20n, remainder: 0n }; // 100 * 2000 / 10000

async function registered() {
  const s = await setup();
  const r = REG(s.P);
  await s.approve(regHash(s.P, s.t, r));
  await register(s.t, r, signMessage(s.P.signerMessage(regHash(s.P, s.t, r)), s.validator.sk));
  s.sid = s.t.ledger()._activeScheduleByNode.lookup(NODE);
  return s;
}
const retuneHash = (P, target, sid, split, rate, nonce, time = NOW) =>
  P.retuneAuthHash(target.addressBytes, sid, CLASS, split, rate, target.ledger()._currentEpoch, nonce, time);
const retune = (target, sid, pk, sig, { split = SPLIT, rate = 110n, nonce = 1n } = {}) =>
  target.call('retuneClass', sid, CLASS, split, rate, pk, sig, nonce, NOW, DIV, DIV);
const BAD_OP = /RETUNE_OPERATOR_SIG_INVALID/;

test('C1c-TR-O1 (negative, PoC): a lying witness and a garbage operator signature cannot retune', { skip }, async () => {
  const { t, sid } = await registered();
  await assert.rejects(retune(t, sid, operator.pk, garbageSignature()), BAD_OP);
});

test('C1c-TR-O2 (negative): only the schedule\'s operator key may retune it', { skip }, async () => {
  const { P, t, sid, validator } = await registered();
  const thief = newMachineKey();
  const msg = P.signerMessage(retuneHash(P, t, sid, SPLIT, 110n, 1n));
  await assert.rejects(retune(t, sid, thief.pk, signMessage(msg, thief.sk)), /RETUNE_OPERATOR_MISMATCH/);
  // The right public key with someone else's signature.
  await assert.rejects(retune(t, sid, operator.pk, signMessage(msg, validator.sk)), BAD_OP);
});

test('C1c-TR-O3 (negative): the operator signature binds the split, the rate and the nonce', { skip }, async () => {
  const { P, t, sid } = await registered();
  const sig = signMessage(P.signerMessage(retuneHash(P, t, sid, SPLIT, 110n, 1n)), operator.sk);
  const moved = { ...SPLIT, producerShareBps: 4000n, daoShareBps: 2000n };
  await assert.rejects(retune(t, sid, operator.pk, sig, { split: moved }), BAD_OP, 'split');
  await assert.rejects(retune(t, sid, operator.pk, sig, { rate: 115n }), BAD_OP, 'rate');
});

test('C1c-TR-O4: the operator retunes with its own signature, once per nonce', { skip }, async () => {
  const { P, t, sid } = await registered();
  const sig = signMessage(P.signerMessage(retuneHash(P, t, sid, SPLIT, 110n, 1n)), operator.sk);
  await retune(t, sid, operator.pk, sig);
  await assert.rejects(retune(t, sid, operator.pk, sig), /RETUNE_NONCE_MISMATCH/);
});
