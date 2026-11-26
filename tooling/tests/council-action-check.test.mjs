// council-action-check.mjs (read-only council action checker) and
// dry-ring-sign.mjs (dry-run stand-in for a ring), on fake ledgers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { checkCouncilAction } from '../council/council-action-check.mjs';
import { approvalKeyOf } from '../council/council-approve.mjs';
import { drySign, councilKeysFile } from '../council/dry-ring-sign.mjs';
import { checkRingResult } from '../council/council-approval-lib.mjs';

const hx = (b) => Buffer.from(b).toString('hex');
const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const sks = [0, 1, 2].map(() => hx(secp256k1.utils.randomSecretKey()));
const pts = sks.map((sk) => { const raw = secp256k1.getPublicKey(Buffer.from(sk, 'hex'), false); return { x: big(raw.slice(1, 33)), y: big(raw.slice(33)) }; });
const A = { council: 'aa'.repeat(32), ebt: 'bb'.repeat(32), ld: 'cc'.repeat(32), tr: 'dd'.repeat(32) };
const H = '11'.repeat(32);
const set = (xs) => ({ member: (k) => xs.some((x) => hx(x) === hx(k)) });

function world({ approvedSlots = [0, 2], consumed = true, bound = A.ld, epoch = 0n } = {}) {
  const key = approvalKeyOf(Buffer.from(H, 'hex'), epoch);
  const ms = {
    _adminCount: 3n, _adminPks: { lookup: (i) => pts[Number(i)] }, _epoch: epoch, _threshold: 2n,
    _approvals: { member: (k) => hx(k) === hx(key), lookup: () => ({ member: (s) => approvedSlots.includes(Number(s)) }) },
  };
  const ebt = { _consumedCouncilActions: set(consumed ? [Buffer.from(H, 'hex')] : []),
    _livingDividendAddress: bound ? { is_some: true, value: { bytes: Buffer.from(bound, 'hex') } } : { is_some: false } };
  return async (b) => (b === 'multisig-v8' ? ms : ebt);
}
const p = { network: 'preprod', action: 'ld-bind (EBT council op 0)', ...A, epoch: '0', actionHash: H };
const run = (o = {}, extra = {}) => checkCouncilAction({
  p: { ...p, ...(extra.p ?? {}) }, rec: { ...A, ...(extra.rec ?? {}) }, ledger: world(o), finalized: async () => extra.finalized ?? true,
  councilFile: extra.councilFile ?? councilKeysFile({ council: sks }), ctx: { ledger: world(o) }, expect: extra.expect,
});

test('CK-1: an executed ld-bind passes every check; the output gives the approval count, never which slots', async () => {
  const r = await run();
  assert.equal(r.ok, true);
  const text = r.lines.map(([, m]) => m).join('\n');
  assert.match(text, /approvals recorded: 2 of 3/);
  assert.doesNotMatch(text, /slot[s]? [0-2]\b/);
});

test('CK-2 (negative): not consumed, too few approvals, another LD, other addresses, a changed council, a lost finalization all fail', async () => {
  assert.equal((await run({ consumed: false })).ok, false);
  assert.equal((await run({ approvedSlots: [0] })).ok, false);
  assert.equal((await run({ bound: 'ee'.repeat(32) })).ok, false);
  assert.equal((await run({}, { rec: { ebt: 'ff'.repeat(32) } })).ok, false);
  const other = councilKeysFile({ council: [sks[0], sks[1], hx(secp256k1.utils.randomSecretKey())] });
  assert.equal((await run({}, { councilFile: other })).ok, false);
  assert.equal((await run({}, { finalized: false })).ok, false);
  assert.equal((await run({ epoch: 1n })).ok, false, 'council rotated since prepare');
});

test('CK-3: --expect approved passes before execute and fails after; --expect pending fails once executed', async () => {
  assert.equal((await run({ consumed: false }, { expect: 'approved' })).ok, true);
  assert.equal((await run({ consumed: true }, { expect: 'approved' })).ok, false);
  assert.equal((await run({ consumed: true }, { expect: 'pending' })).ok, false);
});

test('DS-1: dry-ring-sign gives a result the submit check accepts, and refuses anything but the local devnet', () => {
  const s = { note: 'DEVNET DRY RUN ONLY', council: sks };
  const digest = '22'.repeat(32);
  const r = drySign(s, 2, { network: 'undeployed', digest });
  const slots = pts.map((q, slot) => ({ slot, ...q }));
  assert.equal(checkRingResult({ result: r, digestHex: digest, slots, claimedSlot: 2 }).slot, 2);
  assert.throws(() => drySign(s, 0, { network: 'preprod', digest }), /local devnet only/);
});
