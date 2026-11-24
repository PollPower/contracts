// Statutory lane remittance (Garrett, 2026-11-25): the lane's slice is minted
// on chain to a council-approved statutory account controlled by PollPower;
// PollPower remits to the authority in KES off-chain and logs every
// remittance. Accrual is recomputed from public settle events; the log is
// hash-chained (tamper-evident) and can never claim more than accrued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPollPowerRemit } from '../tariff/lane.mjs';
import { createRemittanceLog, laneAccrual, reconcile } from '../tariff/lane-remittance.mjs';

const b32 = (x) => new Uint8Array(32).fill(x);
const ACCOUNT = b32(0x72);
const lane = (o = {}) => ({ scheduleId: b32(1), laneKindByte: 1n, leviedBy: b32(0x71), bpsShare: 300n, remitAddress: ACCOUNT,
  basis: 0n, applicabilityHash: b32(3), statuteRefHash: b32(4), effectiveEpoch: 1n, remittanceMode: 1n, ...o });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-')), 'remit.jsonl');
const REC = (o = {}) => ({ lane: 'kind1-71', authority: 'Kenya Revenue Authority', ebtAmount: '300', kesAmount: '4500',
  reference: 'MPESA-QX12AB34', coversThroughEventId: 10, recordedBy: 'ops', ...o });

test('LR-1: a lane remitting on chain to a PollPower statutory account passes', () => {
  assert.doesNotThrow(() => assertPollPowerRemit(lane(), [ACCOUNT]));
});

test('LR-2 (negative): any other remit address, off-chain mode, or an empty account list is refused', () => {
  assert.throws(() => assertPollPowerRemit(lane({ remitAddress: b32(0x99) }), [ACCOUNT]), /not a PollPower statutory account/);
  assert.throws(() => assertPollPowerRemit(lane({ remittanceMode: 0n }), [ACCOUNT]), /remittanceMode 1/);
  assert.throws(() => assertPollPowerRemit(lane(), []), /no PollPower statutory accounts/);
});

test('LR-3: accrual is the lane slice of every settle, apportioned exactly as the contract does', () => {
  // class: producer 6200 (incl. margin), ops 2000, ld 1000, dao 500, lane 300
  const bps = { producer: 6200n, ops: 2000n, ld: 1000n, dao: 500n, lanes: [300n] };
  const events = [{ id: 3, amount: 10_000n }, { id: 7, amount: 12_345n }, { id: 9, amount: 7n }];
  const a = laneAccrual({ events, bps, laneIndex: 0 });
  // 10000 -> 300; 12345 -> 370 or 371 by largest remainder; 7 -> 0 or 1
  assert.equal(a.byEvent.length, 3);
  assert.equal(a.byEvent[0].lane, 300n);
  assert.equal(a.total, a.byEvent.reduce((s, e) => s + e.lane, 0n));
  assert.equal(a.throughEventId, 9);
});

test('LR-4: the log is append-only and hash-chained; reconcile reports what is still owed', () => {
  const f = tmp();
  const log = createRemittanceLog(f);
  log.append(REC({ ebtAmount: '300', coversThroughEventId: 3 }));
  log.append(REC({ ebtAmount: '200', reference: 'BANK-0042', coversThroughEventId: 7 }));
  const recs = createRemittanceLog(f).records();
  assert.equal(recs.length, 2);
  assert.equal(recs[1].prevHash, recs[0].hash);
  const r = reconcile({ accrued: { total: 671n, throughEventId: 9 }, records: recs });
  assert.deepEqual(r, { accrued: 671n, remitted: 500n, outstanding: 171n, throughEventId: 9 });
});

test('LR-5 (negative): edited, removed or reordered records break the chain', () => {
  const f = tmp();
  const log = createRemittanceLog(f);
  log.append(REC({ coversThroughEventId: 3 }));
  log.append(REC({ reference: 'BANK-2', coversThroughEventId: 7 }));
  log.append(REC({ reference: 'BANK-3', coversThroughEventId: 9 }));
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  fs.writeFileSync(f, `${lines[0].replace('"300"', '"30"')}\n${lines[1]}\n${lines[2]}\n`);
  assert.throws(() => createRemittanceLog(f).records(), /tampered|chain/);
  fs.writeFileSync(f, `${lines[0]}\n${lines[2]}\n`);
  assert.throws(() => createRemittanceLog(f).records(), /tampered|chain/);
  fs.writeFileSync(f, `${lines[1]}\n${lines[0]}\n${lines[2]}\n`);
  assert.throws(() => createRemittanceLog(f).records(), /tampered|chain/);
});

test('LR-6 (negative): malformed records are refused before they are written', () => {
  const log = createRemittanceLog(tmp());
  assert.throws(() => log.append(REC({ reference: '' })), /reference/);
  assert.throws(() => log.append(REC({ kesAmount: '-5' })), /kesAmount/);
  assert.throws(() => log.append(REC({ ebtAmount: '1.5' })), /ebtAmount/);
  log.append(REC({ coversThroughEventId: 7 }));
  assert.throws(() => log.append(REC({ coversThroughEventId: 5 })), /coversThroughEventId/);
  assert.throws(() => log.append(REC({ reference: 'MPESA-QX12AB34', coversThroughEventId: 8 })), /reference.*already/);
});

test('LR-7 (negative): a log that claims more remitted than accrued is refused', () => {
  const f = tmp();
  createRemittanceLog(f).append(REC({ ebtAmount: '900', coversThroughEventId: 9 }));
  assert.throws(() => reconcile({ accrued: { total: 671n, throughEventId: 9 }, records: createRemittanceLog(f).records() }), /more than accrued/);
});
