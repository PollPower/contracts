// LD v3, EBT side: the dividend budget and its callees, plus the settle /
// mirror fixes that protect what flows into that budget.
//
// Dividend budget (design: living-dividend-v3-design.md, "EBT v9 side"):
//   - settle adds the dividend slice to _dividendAccrued (nothing is minted
//     until a member claims); _pendingDiv, _dividendRecipient and the
//     claimSplit dividend branch are gone.
//   - dividendAccrued() and mintDividend(member, amount) are witness-free
//     callees. mintDividend only answers the bound Living Dividend contract
//     (kernel.caller()) and never mints past _dividendAccrued.
//   - The council binds LD once (execMultisigOp op 0); ops 1 (clear LD) and
//     2 (dividend recipient) are gone.
//
// Settle / mirror findings (new, found while building the full settle path
// for these tests; PoC run on the pre-fix build):
//   WI16-E-1 settle took the ld/ops/dao bps as free arguments, checked only
//            to sum to 10000 with the mirrored statutory total: a settle with
//            ldBps = 0 skipped the dividend (and ops/dao) entirely.
//   WI16-E-2 mirror writes were not monotonic: an older registry entry (still
//            provable in the append-only log) could be re-mirrored, rolling a
//            class back to an old split or a retired schedule back to live.
//   WI16-E-3 EventProof.actionSeq was not tied to the Merkle path, so any
//            sequence number (lane freshness) could be claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, b32, hex, runtimePersistentHash, padTag } from '../parity/harness.mjs';
import { signOwnerAction } from './owner-signer.mjs';
import { settleWorld, SPLIT, T0, CLASS } from './settle-world.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8', 'fixture-dividend-caller'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')} (ebt-v8 and multisig-v8 need --zk)`;

const le32 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 0; x > 0n; i++, x >>= 8n) b[i] = Number(x & 0xffn); return b; };
const MEMBER = { bytes: b32(0x77) };

async function world() {
  const w = await settleWorld();
  const fx = await loadContract('fixture-dividend-caller');
  w.world.register(w.ebt, w.ebtMod, 'ebt-v8'); // EBT as a callee: needs its real verifier keys
  const caller = async () => deploy(fx, {}, [{ bytes: w.ebt.addressBytes }], {}, { world: w.world });
  const bind = async (ld, time = T0) => {
    const h = w.ebtMod.pureCircuits.councilActionHash(w.ebt.addressBytes, 0n, { bytes: ld.addressBytes }, w.keys.escrow.pk, time);
    await w.approve(h);
    await w.ebt.call('execMultisigOp', 0n, { bytes: ld.addressBytes }, w.keys.escrow.pk, time);
  };
  return Object.assign(w, { caller, bind });
}

// ------------------------------------------------------- dividend budget ---

test('LD3-EBT-D0: the dividend is a budget in EBT; the old pending/recipient path is gone', { skip }, async () => {
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, 'ebt-v8', 'compiler', 'contract-info.json'), 'utf8'));
  const names = info.circuits.map((c) => c.name);
  assert.ok(names.includes('dividendAccrued') && names.includes('mintDividend'));
  const w = await world();
  const L = w.ebt.ledger();
  assert.equal(L._dividendAccrued, 0n);
  assert.equal(L._dividendMinted, 0n);
  for (const gone of ['_pendingDiv', '_dividendRecipient', '_dividendMintedLog', '_dividendEventSeq']) {
    assert.equal(L[gone], undefined, `${gone} must be removed`);
  }
  await assert.rejects(w.ownerCall('claimSplit', [1n, T0]), /Bad split kind/);
});

test('LD3-EBT-D1: settle accrues the dividend slice into the budget (nothing minted)', { skip }, async () => {
  const w = await world();
  const { divAmt } = await w.settle(10000n);
  assert.equal(divAmt, 1000n);
  assert.equal(w.ebt.ledger()._dividendAccrued, 1000n);
  await w.settle(5000n);
  assert.equal(w.ebt.ledger()._dividendAccrued, 1500n);
  assert.equal(w.ebt.ledger()._dividendMinted, 0n);
});

test('LD3-EBT-D2 (negative): mintDividend called directly (not from a contract) is refused', { skip }, async () => {
  const w = await world();
  await w.settle(10000n);
  await assert.rejects(w.ebt.call('mintDividend', MEMBER, 1n), /Only the bound Living Dividend/);
});

test('LD3-EBT-D3 (negative): a contract that is not the bound LD cannot mint', { skip }, async () => {
  const w = await world();
  await w.settle(10000n);
  const rogue = await w.caller();
  await assert.rejects(rogue.call('pull', MEMBER, 1n), /Only the bound Living Dividend/, 'nothing bound yet');
  const ld = await w.caller();
  await w.bind(ld);
  await assert.rejects(rogue.call('pull', MEMBER, 1n), /Only the bound Living Dividend/, 'another contract is bound');
});

test('LD3-EBT-D4 (negative): the bound LD can never mint past the accrued budget', { skip }, async () => {
  const w = await world();
  const ld = await w.caller();
  await w.bind(ld);
  await assert.rejects(ld.call('pull', MEMBER, 1n), /Exceeds dividend budget/, 'empty budget');
  await w.settle(10000n); // accrues 1000
  await ld.call('pull', MEMBER, 600n);
  await ld.call('pull', MEMBER, 400n);
  assert.equal(w.ebt.ledger()._dividendMinted, 1000n);
  assert.equal(w.ebt.ledger()._totalSupply, 10000n, 'dividend mints were already counted at settle');
  await assert.rejects(ld.call('pull', MEMBER, 1n), /Exceeds dividend budget/, 'budget used up');
  await assert.rejects(ld.call('pull', MEMBER, 0n), /amount must be positive/);
});

test('LD3-EBT-D5: dividendAccrued is readable through a cross-contract call', { skip }, async () => {
  const w = await world();
  await w.settle(10000n);
  const reader = await w.caller();
  await reader.call('read');
  assert.equal(reader.ledger().lastRead, 1000n);
});

test('LD3-EBT-D6 (negative): LD is bound once; the old clear/recipient ops are gone', { skip }, async () => {
  const w = await world();
  const ld = await w.caller();
  const other = await w.caller();
  await w.bind(ld);
  assert.equal(hex(w.ebt.ledger()._livingDividendAddress.value.bytes), hex(ld.addressBytes));
  await assert.rejects(w.bind(other, T0 + 1n), /Living Dividend already bound/);
  for (const op of [1n, 2n]) {
    const h = w.ebtMod.pureCircuits.councilActionHash(w.ebt.addressBytes, op, { bytes: ld.addressBytes }, w.keys.escrow.pk, T0 + 2n);
    await w.approve(h);
    await assert.rejects(w.ebt.call('execMultisigOp', op, { bytes: ld.addressBytes }, w.keys.escrow.pk, T0 + 2n), /bad op/);
  }
});

// ------------------------------------------------- settle / mirror fixes ---

test('WI16-E-1 (negative, PoC): settle must use the class split; ld/ops/dao cannot be zeroed or moved', { skip }, async () => {
  const w = await world();
  await assert.rejects(w.settle(10000n, { ld: 0n, ops: 0n, dao: 0n }), /SPLIT_OFF_CLASS/, 'all to producer');
  await assert.rejects(w.settle(10000n, { ld: 0n }), /SPLIT_OFF_CLASS/, 'dividend to producer');
  await assert.rejects(w.settle(10000n, { ld: 500n, ops: 2500n }), /SPLIT_OFF_CLASS/, 'dividend to ops');
  assert.equal(w.ebt.ledger()._dividendAccrued, 0n);
  await w.settle(10000n);
  assert.equal(w.ebt.ledger()._dividendAccrued, 1000n);
});

async function advanceRoot(w) {
  w.syncTree();
  const seq = w.entries.length - 1;
  void seq;
  await w.sync();   // fix #5: the root comes from the registry, not the owner
}

test('WI16-E-2a (negative, PoC): an older class entry cannot be re-mirrored over a newer one', { skip }, async () => {
  const w = await world();
  const SPLIT2 = { ...SPLIT, statutoryTotalBps: 500n, producerShareBps: 5500n };
  await w.retune(SPLIT2, 100n, 2n, T0 + 7200n);
  await advanceRoot(w);
  await w.mirrorClass(2, SPLIT2, 100n, T0 + 7200n);
  await assert.rejects(w.mirrorClass(1, SPLIT), /MIRROR_STALE_ENTRY/);
  // The class keeps its 500-bps statutory share: a settle without the lane fails.
  await assert.rejects(w.settle(10000n), /LANE_SUM_MISMATCH/);
});

test('WI16-E-2b (negative, PoC): a retired schedule cannot be made live again by replaying its registration', { skip }, async () => {
  const w = await world();
  const epochHash = runtimePersistentHash([padTag('pp:tariff:v1:advanceEpoch'), w.tr.addressBytes, le32(0), le32(1), le32(100), w.tr.ledger()._governanceRoot]);
  await w.approve(epochHash);
  await w.tr.call('advanceEpoch', 1n, 100n, w.tr.ledger()._governanceRoot, T0);
  const retireHash = runtimePersistentHash([padTag('pp:tariff:v1:retireSchedule'), w.tr.addressBytes, w.scheduleId, le32(1)]);
  await w.approve(retireHash);
  await w.tr.call('retireSchedule', w.scheduleId, T0);
  await advanceRoot(w);
  const retireSeq = w.entries.length - 1;
  const retired = w.tr.ledger()._registeredSchedules.lookup(w.scheduleId);
  await w.ebt.call('mirrorScheduleLifecycle', w.entries[retireSeq], retired, w.tree.proof(retireSeq));
  assert.equal(w.ebt.ledger()._scheduleLiveMirror.lookup(w.scheduleId), false);
  await assert.rejects(w.mirrorSchedule(0), /MIRROR_STALE_ENTRY/);
  await assert.rejects(w.settle(10000n), /SCHEDULE_NOT_LIVE/);
});

test('WI16-E-2c (negative): the same entry cannot be applied twice', { skip }, async () => {
  const w = await world();
  await assert.rejects(w.mirrorClass(1, SPLIT), /MIRROR_STALE_ENTRY/);
  await assert.rejects(w.mirrorSchedule(0), /MIRROR_STALE_ENTRY/);
});

test('WI16-E-3 (negative, PoC): a proof\'s actionSeq must match its Merkle path', { skip }, async () => {
  const w = await world();
  const SPLIT2 = { ...SPLIT, opsShareBps: 2500n, producerShareBps: 5500n };
  await w.retune(SPLIT2, 100n, 2n, T0 + 7200n);
  await advanceRoot(w);
  for (const forged of [999n, 1n, 3n]) {
    await assert.rejects(
      w.ebt.call('mirrorClassStatutoryTotal', w.entries[2], w.scheduleId, CLASS, SPLIT2, 100n, T0 + 7200n, w.tree.proof(2, forged)),
      /EVENT_PROOF_INVALID/, `actionSeq ${forged}`);
  }
  await w.mirrorClass(2, SPLIT2, 100n, T0 + 7200n); // the true seq (2) works
});
