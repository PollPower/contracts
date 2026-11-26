// G16 (post-deploy setup) on the compiled contracts, in the Preprod order and
// from the Preprod starting state: TariffRegistry deployed with the zero
// charter root (K2) and 3200 (K3), EBT bound to it, nothing else. Every call is
// what tooling/g16/g16-lib.mjs plans, so the scripts run exactly this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExists, loadContract, deploy, createWorld, b32, hex } from '../parity/harness.mjs';
import { newCouncilKey, approvalDigest, signDigest } from './council-signer.mjs';
import { newOwnerKey, signOwnerAction } from './owner-signer.mjs';
import { newMachineKey, signMessage } from './machine-signer.mjs';
import { ActionLogTree } from './settle-world.mjs';
import {
  parseG16Params, charterTree, planBootstrap, planCharter, planSchedule, planRetune, planLane, planEbtMirror, planK5Swap,
  advanceEpochActionHash,
} from '../../tooling/g16/g16-lib.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;
const T0 = 1000n;
const h = (b) => hex(b);
const pt = (p) => ({ x: String(p.x), y: String(p.y) });

function rawParams(keys, o = {}) {
  return {
    charter: { nodeIds: [h(b32(0x0e)), h(b32(0x0f)), h(b32(0x10))] },
    refRateFiatPerKwh: '3200',
    schedule: { nodeId: h(b32(0x10)), scheduleHashHex: h(b32(0x5c)), operatorPk: pt(keys.operator.pk) },
    class: { classPathHex: h(b32(0xc1)), rateFiatPerKwh: '3200',
      split: { producerShareBps: '5700', ldShareBps: '1000', opsShareBps: '2000', daoShareBps: '500', operatorMarginBps: '500', statutoryTotalBps: '300' } },
    statutoryAccounts: [h(b32(0x72))],
    lanes: [{ laneKindByte: '1', leviedByHex: h(b32(0x71)), bpsShare: '300', remitAddressHex: h(b32(0x72)), basis: '0',
      applicabilityHashHex: h(b32(0x73)), statuteRefHashHex: h(b32(0x74)), remittanceMode: '1' }],
    meterAuthority: { newPk: pt(keys.newHat.pk) },
    ...o,
  };
}

/** The Preprod state after the ceremony: council, TR (zero root, 3200), EBT. */
async function preprodWorld() {
  const world = createWorld();
  const ms = await loadContract('multisig-v8');
  const trMod = await loadContract('tariff-registry-v1');
  const ebtMod = await loadContract('ebt-v8');
  const councilKeys = Array.from({ length: 7 }, newCouncilKey);   // 3 live slots (count 3), the rest padding
  const council = world.register(await deploy(ms, {}, [councilKeys.map((k) => k.point), 3n, 2n], {}, { world }), ms, 'multisig-v8');
  const approve = async (hash, slots = [0, 2]) => {
    for (const i of slots) await council.call('approve', hash, BigInt(i), signDigest(approvalDigest(ms, council.addressBytes, hash, 0n), councilKeys[i].sk));
  };
  const keys = { validator: newMachineKey(), operator: newMachineKey(), owner: newOwnerKey(), hat: newMachineKey(), newHat: newMachineKey(), escrow: newMachineKey() };
  const charter = { proof: null };   // the witness answers from the params under test
  const tr = await deploy(trMod, {
    charter_membership_proof: (ctx, nodeId) => [ctx.privateState, charter.proof(nodeId)],
    witness_divmod: (ctx, n, d) => [ctx.privateState, { quotient: n / d, remainder: n % d }],
    action_log_path_bits: (ctx, seq) => [ctx.privateState, Array.from({ length: 24 }, (_, i) => ((seq >> BigInt(i)) & 1n) === 1n)],
  }, [{ bytes: council.addressBytes }, b32(0), 3200n, keys.validator.pk], {}, { world });
  world.register(tr, trMod, 'tariff-registry-v1');
  const ebt = await deploy(ebtMod, {}, [keys.owner.pk, keys.hat.pk, { bytes: council.addressBytes }, { bytes: b32(0x21) }, { bytes: b32(0x23) },
    keys.escrow.pk, { bytes: tr.addressBytes }], {}, { world });
  const g = parseG16Params(rawParams(keys), { refRate: 3200n });
  charter.proof = g.charterProof;
  const actionLog = () => {
    const L = tr.ledger(), tree = new ActionLogTree(), entries = [];
    for (let i = 0n; i < L._actionSeq; i++) { const e = L._actionLog.lookup(i); entries.push(e); tree.append(e.payloadHash); }
    return { tree, entries };
  };
  const run = async (c, plan) => c.call(plan.circuit, ...plan.args);
  const steps = {
    bootstrap: () => run(tr, planBootstrap(tr.ledger())),
    charter: async () => { const p = planCharter(tr.addressBytes, tr.ledger(), g, T0); await approve(p.actionHash); await run(tr, p); },
    schedule: async () => {
      const p = planSchedule(trMod.pureCircuits, tr.addressBytes, tr.ledger(), g, T0);
      await approve(p.actionHash);
      p.args[5] = signMessage(p.signerMessage, keys.validator.sk);
      await run(tr, p);
    },
    retune: async () => { const p = planRetune(trMod.pureCircuits, tr.addressBytes, tr.ledger(), g, T0); p.args[5] = signMessage(p.signerMessage, keys.operator.sk); await run(tr, p); },
    lane: async (i = 0) => { const p = planLane(tr.addressBytes, tr.ledger(), g, i, T0); await approve(p.actionHash); await run(tr, p); },
    mirror: async () => { const { tree, entries } = actionLog(); for (const c of planEbtMirror(tr.ledger(), ebt.ledger(), g, tree, entries)) await run(ebt, c); },
    k5: async () => {
      const p = planK5Swap(ebt.ledger(), g);
      await ebt.call(p.circuit, ...p.args, signOwnerAction(ebtMod, ebt, p.circuit, p.args, { sk: keys.owner.sk }));
    },
  };
  return { world, tr, trMod, ebt, ebtMod, council, approve, keys, g, steps, actionLog, charter };
}

test('G16-1: the full setup in the Preprod order, then every plan reports done', { skip }, async () => {
  const w = await preprodWorld();
  for (const s of ['bootstrap', 'charter', 'schedule', 'retune', 'lane', 'mirror', 'k5']) await w.steps[s]();
  const L = w.tr.ledger();
  assert.equal(L._currentEpoch, 1n);
  assert.equal(h(L._governanceRoot), h(w.g.charterRoot));
  assert.equal(L._refRateFiatPerKwh, 3200n, 'K3 re-passed unchanged');
  const sid = L._activeScheduleByNode.lookup(b32(0x10));
  const rec = L._registeredSchedules.lookup(sid);
  assert.equal(rec.refRateFiatPerKwh, 3200n);
  assert.equal(rec.effectiveEpoch, 2n, 'effective the epoch after the charter epoch');
  const E = w.ebt.ledger();
  assert.equal(E._scheduleLiveMirror.lookup(sid), true);
  assert.equal(E._classSplitMirror.isEmpty(), false);
  assert.equal(E._registeredLanesMirror.size(), 1n);
  assert.equal(E._meterAuthorityPubkey.x, w.keys.newHat.pk.x, 'K5 swapped');
  assert.equal(E._ownerNonce, 1n);
  // Idempotent: a resumed run changes nothing.
  assert.ok(planBootstrap(L).done);
  assert.ok(planCharter(w.tr.addressBytes, L, w.g, T0).done);
  assert.ok(planSchedule(w.trMod.pureCircuits, w.tr.addressBytes, L, w.g, T0).done);
  assert.ok(planRetune(w.trMod.pureCircuits, w.tr.addressBytes, L, w.g, T0).done);
  assert.ok(planLane(w.tr.addressBytes, L, w.g, 0, T0).done);
  const { tree, entries } = w.actionLog();
  assert.deepEqual(planEbtMirror(L, E, w.g, tree, entries), []);
  assert.ok(planK5Swap(E, w.g).done);
});

test('G16-2: the JS advanceEpoch hash is the one the registry consumes; any other rate or root is refused', { skip }, async () => {
  const w = await preprodWorld();
  await w.steps.bootstrap();
  const tr = w.tr.addressBytes;
  await w.approve(advanceEpochActionHash(tr, 0n, 1n, 3201n, w.g.charterRoot));
  await assert.rejects(w.tr.call('advanceEpoch', 1n, 3200n, w.g.charterRoot, T0), /FEDERATION_APPROVAL_INVALID/);
  await w.approve(advanceEpochActionHash(tr, 0n, 1n, 3200n, b32(0x99)));
  await assert.rejects(w.tr.call('advanceEpoch', 1n, 3200n, w.g.charterRoot, T0), /FEDERATION_APPROVAL_INVALID/);
  await w.approve(advanceEpochActionHash(tr, 0n, 1n, 3200n, w.g.charterRoot), [0]);   // one of three
  await assert.rejects(w.tr.call('advanceEpoch', 1n, 3200n, w.g.charterRoot, T0), /FEDERATION_APPROVAL_INVALID/);
  await w.approve(advanceEpochActionHash(tr, 0n, 1n, 3200n, w.g.charterRoot), [2]);   // the second of three
  await w.tr.call('advanceEpoch', 1n, 3200n, w.g.charterRoot, T0);
  assert.equal(w.tr.ledger()._currentEpoch, 1n);
  assert.equal(hex(w.tr.ledger()._governanceRoot), hex(w.g.charterRoot));
});

test('G16-3 (negative): a node outside the charter cannot get a schedule, even with a council approval', { skip }, async () => {
  const w = await preprodWorld();
  await w.steps.bootstrap();
  await w.steps.charter();
  assert.throws(() => charterTree(w.g.nodeIds).proof(b32(0x44)), /not in the charter/);
  const P = w.trMod.pureCircuits;
  const outsider = b32(0x44);
  const opId = P.operatorKeyId(w.keys.operator.pk);
  const ah = P.registerScheduleActionHash(w.tr.addressBytes, outsider, b32(0x5c), opId, 3200n, 2n, 1n);
  await w.approve(ah);
  w.charter.proof = () => w.g.charterProof(b32(0x10));   // a real proof, for another node
  await assert.rejects(w.tr.call('registerSchedule', outsider, b32(0x5c), opId, 3200n, 2n, signMessage(P.signerMessage(ah), w.keys.validator.sk), T0));
});

test('G16-4 (negative): steps out of order are refused before any transaction', { skip }, async () => {
  const w = await preprodWorld();
  assert.throws(() => planCharter(w.tr.addressBytes, w.tr.ledger(), w.g, T0), /bootstrap/);
  await w.steps.bootstrap();
  assert.throws(() => planSchedule(w.trMod.pureCircuits, w.tr.addressBytes, w.tr.ledger(), w.g, T0), /charter root first/);
  await w.steps.charter();
  assert.throws(() => planLane(w.tr.addressBytes, w.tr.ledger(), w.g, 0, T0), /schedule first/);
  assert.throws(() => planRetune(w.trMod.pureCircuits, w.tr.addressBytes, w.tr.ledger(), w.g, T0), /schedule first/);
  await w.steps.schedule();
  const { tree, entries } = w.actionLog();
  assert.throws(() => planEbtMirror(w.tr.ledger(), w.ebt.ledger(), w.g, tree, entries), /retune the class first/);
  await w.steps.retune();
  const l2 = w.actionLog();
  assert.throws(() => planEbtMirror(w.tr.ledger(), w.ebt.ledger(), w.g, l2.tree, l2.entries), /not registered yet/);
});

test('G16-5 (negative): the K5 swap needs the owner key over exactly these arguments', { skip }, async () => {
  const w = await preprodWorld();
  const p = planK5Swap(w.ebt.ledger(), w.g);
  const other = newMachineKey();
  const forged = signOwnerAction(w.ebtMod, w.ebt, p.circuit, [1n, p.args[1], other.pk], { sk: w.keys.owner.sk });
  await assert.rejects(w.ebt.call(p.circuit, ...p.args, forged), /Only owner/);
  const notOwner = signOwnerAction(w.ebtMod, w.ebt, p.circuit, p.args, { sk: newOwnerKey().sk });
  await assert.rejects(w.ebt.call(p.circuit, ...p.args, notOwner), /Only owner/);
  await w.steps.k5();
  assert.equal(w.ebt.ledger()._meterAuthorityPubkey.y, w.keys.newHat.pk.y);
});

test('G16-6 (negative): bad parameters are refused before anything is planned', { skip }, async () => {
  const k = { operator: newMachineKey(), newHat: newMachineKey() };
  const bad = (o, re) => assert.throws(() => parseG16Params(rawParams(k, o), { refRate: 3200n }), re);
  bad({ refRateFiatPerKwh: '3300' }, /differs from K3/);
  bad({ charter: { nodeIds: [h(b32(0x0e)), h(b32(0x0e))] } }, /duplicate charter node/);
  bad({ charter: { nodeIds: [h(b32(0))] } }, /cannot be zero/);
  bad({ charter: { nodeIds: [h(b32(0x0e))] } }, /schedule.nodeId is not in charter/);
  const base = rawParams(k);
  bad({ class: { ...base.class, rateFiatPerKwh: '3841' } }, /outside the ±20% band/);
  bad({ class: { ...base.class, split: { ...base.class.split, daoShareBps: '501' } } }, /sums to 10001/);
  bad({ class: { ...base.class, split: { ...base.class.split, ldShareBps: '100', daoShareBps: '1400' } } }, /LD floor/);
  bad({ lanes: [{ ...base.lanes[0], remitAddressHex: h(b32(0x99)) }] }, /not a PollPower statutory account/);
  bad({ lanes: [{ ...base.lanes[0], remittanceMode: '0' }] }, /remittanceMode 1/);
  bad({ lanes: [{ ...base.lanes[0], bpsShare: '200' }] }, /lanes sum to 200/);
  bad({ lanes: [{ ...base.lanes[0], leviedByHex: h(b32(0)) }] }, /leviedByHex cannot be zero/);
  bad({ schedule: { ...base.schedule, operatorPk: { x: '1', y: '2' } } }, /operatorPk/);
  bad({ meterAuthority: { newPk: { x: '5', y: '7' } } }, /meterAuthority.newPk/);
  assert.ok(parseG16Params(rawParams(k), { refRate: 3200n }).charterRoot);
});
