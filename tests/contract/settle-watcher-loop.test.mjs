// Settle watcher loop (runbook docs/runbooks/hat-settle-watcher.md): every
// settleChip event is re-verified against the chip's on-chain record; a
// problem alerts EVERY council member (revocation is 2-of-3, so two approvals
// must be gathered quickly). Alerts are not lost to one member's endpoint
// failing, and the same event never alerts twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExists } from '../parity/harness.mjs';
import { settleWorld } from './settle-world.mjs';
import { restoreEventValue } from '../../tooling/events/event-codec.mjs';
import { createWatcher } from '../../tooling/watcher/settle-watcher-loop.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;
const MEMBERS = ['garrett', 'member1', 'member2'];

/** Indexer-shaped Misc events from the in-memory EBT's last call. */
function indexerEvents(w, firstId) {
  return w.ebt.events().map((e, i) => {
    const { bytes } = restoreEventValue(e.data.content.value[0]);
    return { id: firstId + i, eventType: 'Misc', name: bytes.subarray(0, 32).toString('hex'), payload: bytes.subarray(32).toString('hex') };
  });
}
function sinks(failing = new Set()) {
  const got = Object.fromEntries(MEMBERS.map((m) => [m, []]));
  const list = MEMBERS.map((m) => ({ member: m, send: async (a) => { if (failing.has(m)) throw new Error(`${m} endpoint down`); got[m].push(a); } }));
  return { got, list };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppw-')), 'watcher-state.json');
const chipLookup = (w) => async (pk) => (w.ebt.ledger()._chips.member(pk) ? w.ebt.ledger()._chips.lookup(pk) : null);
const quiet = { log() {}, warn() {}, error() {} };

test('WL-1: a genuine settle raises no alert; the cursor advances and persists', { skip }, async () => {
  const w = await settleWorld();
  await w.settle(10_000n);
  const s = sinks();
  const stateFile = tmp();
  const wt = createWatcher({ chipLookup: chipLookup(w), sinks: s.list, stateFile, log: quiet });
  const r = await wt.process(indexerEvents(w, 10));
  assert.deepEqual(r, { checked: 1, alerts: 0 });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastId, 10);
  for (const m of MEMBERS) assert.deepEqual(s.got[m], []);
});

test('WL-2 (negative): a tampered chip signature alerts every council member once', { skip }, async () => {
  const w = await settleWorld();
  await w.settle(10_000n);
  const evs = indexerEvents(w, 20);
  const p = Buffer.from(evs[0].payload, 'hex');
  p[64] ^= 0x01;                                    // flip a bit of chipSigR (word 2)
  evs[0].payload = p.toString('hex');
  const s = sinks();
  const wt = createWatcher({ chipLookup: chipLookup(w), sinks: s.list, stateFile: tmp(), log: quiet });
  assert.deepEqual(await wt.process(evs), { checked: 1, alerts: 1 });
  for (const m of MEMBERS) {
    assert.equal(s.got[m].length, 1, m);
    assert.deepEqual(s.got[m][0].problems, ['bad_chip_signature']);
    assert.equal(s.got[m][0].eventId, 20);
    assert.match(s.got[m][0].action, /revokeChip/);
  }
  assert.deepEqual(await wt.process(evs), { checked: 0, alerts: 0 }, 'already processed: no second alert');
});

test('WL-3 (negative): one member endpoint down does not block the others and is retried', { skip }, async () => {
  const w = await settleWorld();
  await w.settle(10_000n);
  const evs = indexerEvents(w, 30);
  const p = Buffer.from(evs[0].payload, 'hex');
  p[64] ^= 0x01;
  evs[0].payload = p.toString('hex');
  const stateFile = tmp();
  const down = new Set(['member2']);
  const s = sinks(down);
  const wt = createWatcher({ chipLookup: chipLookup(w), sinks: s.list, stateFile, log: quiet });
  await wt.process(evs);
  assert.equal(s.got.garrett.length, 1);
  assert.equal(s.got.member1.length, 1);
  assert.equal(s.got.member2.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pendingAlerts.length, 1, 'undelivered alert persisted');
  down.delete('member2');
  await wt.retryPending();
  assert.equal(s.got.member2.length, 1, 'delivered on retry');
  assert.equal(s.got.garrett.length, 1, 'not re-sent to members who already got it');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pendingAlerts.length, 0);
});

test('WL-4 (negative): a settleChip event from a chip that is not registered alerts; malformed events alert too', { skip }, async () => {
  const w = await settleWorld();
  await w.settle(10_000n);
  const evs = indexerEvents(w, 40);
  const s = sinks();
  const wt = createWatcher({ chipLookup: async () => null, sinks: s.list, stateFile: tmp(), log: quiet });
  await wt.process(evs);
  assert.deepEqual(s.got.garrett[0].problems, ['chip_not_registered']);
  const s2 = sinks();
  const wt2 = createWatcher({ chipLookup: chipLookup(w), sinks: s2.list, stateFile: tmp(), log: quiet });
  const name = Buffer.alloc(32); name.write('pp:ebt:v9:settleChip');
  await wt2.process([{ id: 50, eventType: 'Misc', name: name.toString('hex'), payload: 'ab'.repeat(300) }]);
  assert.match(s2.got.member1[0].problems[0], /undecodable/);
});

test('WL-5: other event types are skipped without alerts', { skip }, async () => {
  const w = await settleWorld();
  const s = sinks();
  const wt = createWatcher({ chipLookup: chipLookup(w), sinks: s.list, stateFile: tmp(), log: quiet });
  const name = Buffer.alloc(32); name.write('pp:ld:v3:claim');
  assert.deepEqual(await wt.process([{ id: 60, eventType: 'Misc', name: name.toString('hex'), payload: '00'.repeat(256) }]), { checked: 0, alerts: 0 });
});
