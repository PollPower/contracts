// Fix #5 (registry-root anchor, docs/design/registry-root-anchor-design.md):
// EBT reads the TariffRegistry's action-log root on chain, through a ledger 9
// cross-contract call (TR `actionLogAnchor`, EBT `syncRegistryRoot`). No key,
// and no constructor argument, chooses the root any more.
//
// Written first. On the pre-fix build RA-1 runs the owner-key PoC (a forged
// root pays a forged lane) and fails on purpose; the rest fail because the
// anchor does not exist yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExists, loadContract, deploy, b32, runtimePersistentHash, padTag, hex } from '../parity/harness.mjs';
import { settleWorld, ActionLogTree, CLASS, T0, charterProof } from './settle-world.mjs';
import { signSettle, chipHwId, sessionFrom16 } from './hat-signer.mjs';
import { signOwnerAction } from './owner-signer.mjs';
import { newOwnerKey } from './owner-signer.mjs';
import { newMachineKey } from './machine-signer.mjs';
import { planSettleArgs } from '../../tooling/settle/settle-plan.mjs';
import { registerLaneActionHash, findLane } from '../../tooling/tariff/lane.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8', 'fixture-registry-anchor'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;

const ATTACKER = b32(0xaa);
// Class with a 300-bps statutory share (producer 5700 + margin 500 + ld 1000 + ops 2000 + dao 500 + 300).
const SPLIT_L = { producerShareBps: 5700n, ldShareBps: 1000n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 300n };
const laneFor = (w, o = {}) => ({
  scheduleId: w.scheduleId, laneKindByte: 1n, leviedBy: b32(0x71), bpsShare: 300n, remitAddress: b32(0x72),
  basis: 0n, applicabilityHash: b32(0x73), statuteRefHash: b32(0x74), effectiveEpoch: 1n, remittanceMode: 1n, ...o,
});
const laneArgs = (l) => [l.scheduleId, l.laneKindByte, l.leviedBy, l.bpsShare, l.remitAddress, l.basis,
  l.applicabilityHash, l.statuteRefHash, l.effectiveEpoch, l.remittanceMode];

const le32 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
/** TariffRegistry's lane payload hash (laneActionPayloadHash), for forging entries. */
const lanePayload = (kind, r) => runtimePersistentHash([
  padTag('pp:tariff:v1:actionPayload'), le32(kind), r.scheduleId, le32(r.laneKindByte), r.leviedBy, le32(r.bpsShare),
  r.remitAddress, le32(r.basis), r.applicabilityHash, r.statuteRefHash, le32(r.effectiveEpoch), le32(r.retiredEpoch),
  le32(r.remittanceMode), le32(r.registeredAt),
]);

/** An attacker's lane (remit to the attacker) appended to a copy of the real log: a well-formed tree and proof. */
function forgeLane(w) {
  const record = { ...laneFor(w, { remitAddress: ATTACKER }), retiredEpoch: 0n, registeredAt: T0 };
  const payloadHash = lanePayload(1n, record);
  const entry = { kind: 1n, scheduleId: w.scheduleId, nodeId: b32(0x0e), epoch: 0n, actionHash: b32(0xab), emittedAt: T0, payloadHash };
  const tree = new ActionLogTree();
  for (const l of w.tree.leaves) tree.append(l);
  tree.append(payloadHash);
  const seq = tree.leaves.length - 1;
  return { record, entry, tree, proof: tree.proof(seq) };
}

function bundle(w, amount, n) {
  const f = {
    sessionID: sessionFrom16(new Uint8Array(16).fill(0x30 + n)), amount, producerKey: b32(0x63),
    producerAddr: { bytes: b32(0x64) }, meterKeyHash: b32(0x65), chipHwId: chipHwId(w.keys.chip),
    chipSessionUwh: amount * 1000n + 1n, chipUptimeMs: 70_000n + BigInt(n), chipNonce: 7_000n + BigInt(n),
  };
  return { f, s: signSettle(w.ebtMod, w.ebt, f, { chip: w.keys.chip, hatSk: w.keys.hat.sk }) };
}
const plan = (w, f, s) => planSettleArgs({
  ebtModule: w.ebtMod, ledger: w.ebt.ledger(), fields: f, chip: s,
  scheduleId: w.scheduleId, classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: T0,
});
// Any witness name resolves to a stub: only the circuit list is read.
const anyWitness = new Proxy({}, { get: () => () => { throw new Error('witness called'); }, has: () => true });
const circuits = (mod) => Object.keys(new mod.Contract(anyWitness).impureCircuits);

/** A look-alike registry: same `actionLogAnchor` interface, anchor set by anyone. */
async function fakeRegistry(world) {
  const mod = await loadContract('fixture-registry-anchor');
  const h = await deploy(mod, {}, [], {}, { world });
  return world.register(h, mod, 'fixture-registry-anchor');
}
/** A bare EBT (no setup) bound to `registryBytes`. */
async function bareEbt(w, registryBytes) {
  const ctor = [newOwnerKey().pk, newMachineKey().pk, { bytes: w.council.addressBytes },
    { bytes: b32(0x21) }, { bytes: b32(0x23) }, newMachineKey().pk, { bytes: registryBytes }];
  return deploy(w.ebtMod, {}, ctor, {}, { world: w.world });
}

test('RA-1 (negative, PoC): no key can install a root; a forged lane cannot be mirrored', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const forged = forgeLane(w);
  if (circuits(w.ebtMod).includes('mirrorActionLogRoot')) {
    // Pre-fix build: the owner key installs the forged root, mirrors the forged lane, and a settle pays it.
    const rootArgs = [forged.tree.root(), forged.entry];
    await w.ebt.call('mirrorActionLogRoot', ...rootArgs, forged.proof,
      signOwnerAction(w.ebtMod, w.ebt, 'mirrorActionLogRoot', rootArgs, { sk: w.keys.owner.sk }));
    await w.ebt.call('mirrorRegisterLane', forged.entry, forged.record, forged.proof);
    const { f, s } = bundle(w, 10_000n, 1);
    const args = plan(w, f, s);
    await w.ebt.call('settle', ...args);
    assert.fail(`PoC: owner key installed a forged root; settle paid ${args[19][0]} to the attacker lane ${hex(args[17][0]).slice(0, 8)}... (remit ${hex(ATTACKER).slice(0, 8)}...)`);
  }
  const names = circuits(w.ebtMod);
  for (const gone of ['mirrorActionLogRoot', 'mirrorActionLogHead']) assert.ok(!names.includes(gone), `${gone} must be gone`);
  assert.ok(!('ownerDigest_mirrorActionLogRoot' in w.ebtMod.pureCircuits));
  await assert.rejects(w.ebt.call('mirrorRegisterLane', forged.entry, forged.record, forged.proof), /EVENT_PROOF_INVALID/);
  assert.equal(w.ebt.ledger()._registeredLanesMirror.size(), 0n);
});

test('RA-2 (negative): EBT is deployed with a registry reference, not a root; the first sync installs the real root', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const ebt = await bareEbt(w, w.tr.addressBytes);
  assert.equal(hex(ebt.ledger()._registryActionLogRootMirror), hex(b32(0)), 'no root before the first sync');
  // Nothing is provable before the sync.
  await assert.rejects(ebt.call('mirrorScheduleLifecycle', w.entries[0], w.record, w.tree.proof(0)), /EVENT_PROOF_INVALID/);
  await ebt.call('syncRegistryRoot');
  const L = ebt.ledger();
  assert.equal(hex(L._registryActionLogRootMirror), hex(w.tr.ledger().registryActionLogRoot));
  assert.equal(L._registryActionLogCountMirror, w.tr.ledger()._actionSeq);
  await ebt.call('mirrorScheduleLifecycle', w.entries[0], w.record, w.tree.proof(0));
});

test('RA-3 (negative): a look-alike registry is never read; the registry reference is sealed', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const fake = await fakeRegistry(w.world);
  const forged = forgeLane(w);
  await fake.call('setAnchor', forged.tree.root(), 1000n);
  await w.ebt.call('syncRegistryRoot');
  assert.equal(hex(w.ebt.ledger()._registry.bytes), hex(w.tr.addressBytes));
  assert.equal(hex(w.ebt.ledger()._registryActionLogRootMirror), hex(w.tr.ledger().registryActionLogRoot));
  await assert.rejects(w.ebt.call('mirrorRegisterLane', forged.entry, forged.record, forged.proof), /EVENT_PROOF_INVALID/);
  // No circuit can repoint it.
  assert.deepEqual(circuits(w.ebtMod).filter((c) => /registry/i.test(c) && c !== 'syncRegistryRoot' && !/^get/.test(c)), []);
});

test('RA-4 (negative): after a sync, a lane or class entry that is not in the registry log cannot be mirrored', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const forged = forgeLane(w);
  // Proof from the attacker's tree: the root differs from the registry's.
  await assert.rejects(w.ebt.call('mirrorRegisterLane', forged.entry, forged.record, forged.proof), /EVENT_PROOF_INVALID/);
  // A real leaf position with the forged payload: the leaf differs.
  const realProof = { ...w.tree.proof(1), payloadHash: forged.entry.payloadHash };
  await assert.rejects(w.ebt.call('mirrorRegisterLane', { ...forged.entry }, forged.record, realProof), /EVENT_PROOF_INVALID|MIRROR_KIND_MISMATCH/);
  // The real class entry with a different split than the registry recorded.
  const skewed = { ...SPLIT_L, producerShareBps: 6000n, statutoryTotalBps: 0n };
  await assert.rejects(w.mirrorClass(1, skewed), /EVENT_PROOF_INVALID|MIRROR_STALE_ENTRY/);
});

test('RA-5 (negative): a registry whose log goes backwards (or rewrites its root) is refused', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const fake = await fakeRegistry(w.world);
  const ebt = await bareEbt(w, fake.addressBytes);
  await fake.call('setAnchor', b32(0x01), 5n);
  await ebt.call('syncRegistryRoot');
  assert.equal(ebt.ledger()._registryActionLogCountMirror, 5n);
  await fake.call('setAnchor', b32(0x02), 3n);
  await assert.rejects(ebt.call('syncRegistryRoot'), /REGISTRY_ROOT_REGRESSED/);
  await fake.call('setAnchor', b32(0x03), 5n);   // same count, different root: history rewritten
  await assert.rejects(ebt.call('syncRegistryRoot'), /REGISTRY_ROOT_REGRESSED/);
  await fake.call('setAnchor', b32(0x04), 6n);
  await ebt.call('syncRegistryRoot');
  assert.equal(hex(ebt.ledger()._registryActionLogRootMirror), hex(b32(0x04)));
  assert.equal(ebt.ledger()._registryActionLogHeadSeqMirror, 5n, 'head = latest entry = count - 1');
});

test('RA-6 (negative): before the registry bootstrap completes, the anchor and the sync fail', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const tr = await deploy(w.trMod, {
    charter_membership_proof: (ctx) => [ctx.privateState, charterProof],
    witness_divmod: (ctx, n, d) => [ctx.privateState, { quotient: n / d, remainder: n % d }],
    action_log_path_bits: (ctx) => [ctx.privateState, Array(24).fill(false)],
  }, [{ bytes: w.council.addressBytes }, b32(0x77), 100n, newMachineKey().pk], {}, { world: w.world });
  w.world.register(tr, w.trMod, 'tariff-registry-v1');
  await assert.rejects(tr.call('actionLogAnchor'), /ACTION_LOG_NOT_BOOTSTRAPPED/);
  await tr.call('bootstrapActionLog', 12n);   // half way
  await assert.rejects(tr.call('actionLogAnchor'), /ACTION_LOG_NOT_BOOTSTRAPPED/);
  const ebt = await bareEbt(w, tr.addressBytes);
  await assert.rejects(ebt.call('syncRegistryRoot'), /ACTION_LOG_NOT_BOOTSTRAPPED/);
  await tr.call('bootstrapActionLog', 24n);
  await ebt.call('syncRegistryRoot');
  assert.equal(hex(ebt.ledger()._registryActionLogRootMirror), hex(tr.ledger().registryActionLogRoot));
});

test('RA-7: a registry change after EBT is deployed (lane, retune): sync, re-mirror, settle pays the new split', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const lane = laneFor(w);
  await w.approve(registerLaneActionHash(w.tr.addressBytes, lane, w.tr.ledger()._currentEpoch, T0));
  await w.tr.call('registerLane', ...laneArgs(lane), charterProof, T0);
  w.syncTree();
  const seq = w.entries.length - 1;
  const rec = findLane(w.tr.ledger(), lane.scheduleId, lane.leviedBy, lane.laneKindByte);
  // Before the sync: the new entry is not provable, and the statutory share blocks settles.
  await assert.rejects(w.ebt.call('mirrorRegisterLane', w.entries[seq], rec, w.tree.proof(seq)), /EVENT_PROOF_INVALID/);
  const b1 = bundle(w, 10_000n, 1);
  assert.throws(() => plan(w, b1.f, b1.s), /LANE_SUM_MISMATCH/);
  // Anyone syncs; the lane mirrors; the planned settle pays it.
  await w.sync();
  await w.ebt.call('mirrorRegisterLane', w.entries[seq], rec, w.tree.proof(seq));
  const args = plan(w, b1.f, b1.s);
  assert.deepEqual(args[19], [300n, 0n, 0n, 0n]);
  await w.ebt.call('settle', ...args);
  // A retune after deploy: Living Dividend 1000 -> 1100, producer 5700 -> 5600.
  const NEW = { ...SPLIT_L, producerShareBps: 5600n, ldShareBps: 1100n };
  const tRetune = T0 + 7200n;
  await w.retune(NEW, 100n, 2n, tRetune);
  w.syncTree();
  const cseq = w.entries.length - 1;
  await assert.rejects(w.mirrorClass(cseq, NEW, 100n, tRetune), /EVENT_PROOF_INVALID/);
  await w.sync();
  await w.mirrorClass(cseq, NEW, 100n, tRetune);
  const b2 = bundle(w, 10_000n, 2);
  const args2 = plan(w, b2.f, b2.s);
  assert.equal(args2[22], 1100n, 'Living Dividend bps from the retuned class');
  assert.equal(args2[26], 1100n, 'dividend slice of 10000');
  await w.ebt.call('settle', ...args2);
});

test('RA-8: the anchor is witness-free and in both TR builds; EBT has syncRegistryRoot and no root-taking circuit in both builds', { skip }, async () => {
  const trMod = await loadContract('tariff-registry-v1');
  const boom = () => { throw new Error('witness called'); };
  const tr = await deploy(trMod, { charter_membership_proof: boom, witness_divmod: boom, action_log_path_bits: boom },
    [{ bytes: b32(0x01) }, b32(0x77), 100n, newMachineKey().pk], {});
  await tr.call('bootstrapActionLog', 24n);
  const a = await tr.call('actionLogAnchor');
  assert.equal(hex(a.root), hex(tr.ledger().registryActionLogRoot));
  assert.equal(a.count, 0n);
  for (const name of ['tariff-registry-v1', 'tariff-registry-v1-ceremony']) {
    if (buildExists(name)) assert.ok(circuits(await loadContract(name)).includes('actionLogAnchor'), `${name}: actionLogAnchor`);
  }
  for (const name of ['ebt-v8', 'ebt-v8-ceremony']) {
    if (!buildExists(name)) continue;
    const m = await loadContract(name);
    const c = circuits(m);
    assert.ok(c.includes('syncRegistryRoot'), `${name}: syncRegistryRoot`);
    assert.ok(!c.includes('mirrorActionLogRoot') && !c.includes('mirrorActionLogHead'), `${name}: no root/head setter`);
    assert.ok(!('ownerDigest_mirrorActionLogRoot' in m.pureCircuits), `${name}: no owner digest for roots`);
  }
});
