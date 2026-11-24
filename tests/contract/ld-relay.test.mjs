// LD v3 relayer pre-checks (WI-16 step 4): the relayer proves and pays for
// member actions, so it refuses anything the contract would refuse BEFORE
// spending a proof, and can never be made to act for a member without that
// member's own signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { buildExists, loadContract, padTag } from '../parity/harness.mjs';
import { newMachineKey, signMessage } from './machine-signer.mjs';
import { checkLdAction } from '../../tooling/ld/ld-relay.mjs';

const skip = buildExists('living-dividend-v3') ? false : 'living-dividend-v3 build missing';
const LD = new Uint8Array(32).fill(0x1d);
const hex = (b) => Buffer.from(b).toString('hex');
const NOW = 1_800_000_000n;

async function fixture() {
  const mod = await loadContract('living-dividend-v3');
  const P = mod.pureCircuits;
  const key = newMachineKey();
  const id = P.memberId(key.pk);
  const member = { pk: key.pk, payout: { bytes: new Uint8Array(32).fill(0x31) }, checkpoint: 0n, nonce: 4n, lastSeen: NOW - 10n, registeredAt: NOW - 100n, isLive: true };
  const members = new Map([[hex(id), member]]);
  const pending = new Map();
  const ledger = {
    _members: { member: (k) => members.has(hex(k)), lookup: (k) => members.get(hex(k)) },
    _pendingPayouts: { member: (k) => pending.has(hex(k)), lookup: (k) => pending.get(hex(k)) },
  };
  const sign = (action, digest, { sk = key.sk, nonce = 4n } = {}) => {
    const s = signMessage(P.memberMessage(LD, padTag(action), id, digest, nonce), sk);
    return { announcement: { x: String(s.announcement.x), y: String(s.announcement.y) }, response: String(s.response) };
  };
  const body = (action, extra = {}) => ({
    action, memberIdHex: hex(id), pk: { x: String(key.pk.x), y: String(key.pk.y) }, currentTime: String(NOW), ...extra,
  });
  return { mod, P, key, id, ledger, pending, sign, body };
}
const check = (f, b) => checkLdAction({ ldModule: f.mod, ledger: f.ledger, ldAddress: LD, body: b, blockTime: NOW + 5n });

test('LR-1: each member action with the member\'s own signature passes and yields the circuit args', { skip }, async () => {
  const f = await fixture();
  const claim = check(f, { ...f.body('claim'), signature: f.sign('claim', f.P.timeDigest(NOW)) });
  assert.equal(claim.circuit, 'claim');
  assert.equal(claim.args.length, 3);
  const np = '77'.repeat(32);
  const req = check(f, { ...f.body('requestPayoutChange', { newPayoutHex: np }), signature: f.sign('requestPayoutChange', f.P.payoutDigest({ bytes: Buffer.from(np, 'hex') }, NOW)) });
  assert.equal(req.circuit, 'requestPayoutChange');
  assert.equal(req.args.length, 4);
  f.pending.set(hex(f.id), { payout: { bytes: Buffer.from(np, 'hex') }, effectiveAt: NOW + 259200n });
  assert.equal(check(f, { ...f.body('cancelPayoutChange'), signature: f.sign('cancelPayoutChange', f.P.timeDigest(NOW)) }).circuit, 'cancelPayoutChange');
  assert.equal(check(f, { ...f.body('touchLiveness'), signature: f.sign('touchLiveness', f.P.timeDigest(NOW)) }).circuit, 'touchLiveness');
});

test('LR-2 (negative): forged, replayed, re-purposed or foreign signatures are refused before proving', { skip }, async () => {
  const f = await fixture();
  const other = newMachineKey();
  assert.throws(() => check(f, { ...f.body('claim'), signature: f.sign('claim', f.P.timeDigest(NOW), { sk: other.sk }) }), /signature does not verify/);
  assert.throws(() => check(f, { ...f.body('claim'), signature: f.sign('claim', f.P.timeDigest(NOW), { nonce: 3n }) }), /signature does not verify/, 'old nonce (replay)');
  assert.throws(() => check(f, { ...f.body('claim'), signature: f.sign('touchLiveness', f.P.timeDigest(NOW)) }), /signature does not verify/, 'signed for another action');
  assert.throws(() => check(f, { ...f.body('claim'), signature: f.sign('claim', f.P.timeDigest(NOW - 1n)) }), /signature does not verify/, 'signed for another time');
  const np = '77'.repeat(32);
  assert.throws(() => check(f, { ...f.body('requestPayoutChange', { newPayoutHex: '88'.repeat(32) }),
    signature: f.sign('requestPayoutChange', f.P.payoutDigest({ bytes: Buffer.from(np, 'hex') }, NOW)) }), /signature does not verify/, 'payout swapped after signing');
});

test('LR-3 (negative): wrong member, unknown member, future time, unknown action, malformed input', { skip }, async () => {
  const f = await fixture();
  const sig = f.sign('claim', f.P.timeDigest(NOW));
  const other = newMachineKey();
  assert.throws(() => check(f, { ...f.body('claim'), pk: { x: String(other.pk.x), y: String(other.pk.y) }, signature: sig }), /memberId does not match/);
  assert.throws(() => check(f, { ...f.body('claim'), memberIdHex: 'ab'.repeat(32), signature: sig }), /memberId does not match|not a member/);
  assert.throws(() => checkLdAction({ ldModule: f.mod, ledger: f.ledger, ldAddress: LD, body: { ...f.body('claim'), signature: sig }, blockTime: NOW - 1n }), /ahead of block time/);
  assert.throws(() => check(f, { ...f.body('register'), signature: sig }), /unsupported action/);
  assert.throws(() => check(f, { ...f.body('claim'), currentTime: '-1', signature: sig }), /currentTime/);
  assert.throws(() => check(f, { ...f.body('cancelPayoutChange'), signature: f.sign('cancelPayoutChange', f.P.timeDigest(NOW)) }), /no pending payout change/);
  assert.throws(() => check(f, { ...f.body('requestPayoutChange'), signature: sig }), /newPayoutHex/);
});

test('LR-4 (negative): a member that is no longer live is refused', { skip }, async () => {
  const f = await fixture();
  f.ledger._members.lookup(f.id).isLive = false;
  assert.throws(() => check(f, { ...f.body('claim'), signature: f.sign('claim', f.P.timeDigest(NOW)) }), /not live/);
});
