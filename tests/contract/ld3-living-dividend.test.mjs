// Living Dividend v3 (design: docs/design/living-dividend-v3-design.md).
//
// Runs LD v3 against a real EBT v8 that accrues dividend through real settles
// (settle-world.mjs), a real Multisig v8 council, and cross-contract calls
// checked against the callees' real verifier keys.
//
// What v2.2.x got wrong and these tests pin down:
//  - member and council checks were prover-supplied witnesses (WI16-C-1):
//    now a member signs with a Jubjub key (in-circuit Schnorr, per-member
//    nonce, LD address in the message); the council approves via Multisig v8;
//  - custody was an off-chain pool wallet: now EBT mints straight to the
//    member's payout address inside the claim transaction, from a budget it
//    can never overdraw;
//  - accrual was fed by a keeper (bumpOnMint): now LD reads EBT's accrued
//    total itself before every membership change.
// Garrett's choices (2026-11-24): (a) dividend accrued while nobody is
// registered stays unminted in EBT's budget; (b) history as events, state
// maps only where needed; (c) payout-address changes are member-signed and
// take effect after a delay (72 h proposed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, b32, hex, padTag } from '../parity/harness.mjs';
import { garbageSignature } from './owner-signer.mjs';
import { newMachineKey, signMessage } from './machine-signer.mjs';
import { settleWorld, T0 } from './settle-world.mjs';
import { restoreEventValue, payloadWords } from '../../tooling/events/event-codec.mjs';

const NAME = 'living-dividend-v3';
const need = [NAME, 'ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')} (ebt-v8 and multisig-v8 need --zk)`;

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const DELAY = 3n * DAY; // payout-change delay (proposal: 72 h)
const divmod = (ctx, n, d) => [ctx.privateState, { quotient: n / d, remainder: n % d }];

async function setup({ bind = true } = {}) {
  const w = await settleWorld();
  const mod = await loadContract(NAME);
  w.world.register(w.ebt, w.ebtMod, 'ebt-v8');
  const deployLd = async () => {
    const ld = await deploy(mod, { witness_divmod: divmod }, [{ bytes: w.ebt.addressBytes }, { bytes: w.council.addressBytes }], {}, { world: w.world });
    ld.setTime(NOW);
    return ld;
  };
  const ld = await deployLd();
  if (bind) {
    const h = w.ebtMod.pureCircuits.councilActionHash(w.ebt.addressBytes, 0n, { bytes: ld.addressBytes }, w.keys.escrow.pk, T0);
    await w.approve(h);
    await w.ebt.call('execMultisigOp', 0n, { bytes: ld.addressBytes }, w.keys.escrow.pk, T0);
  }
  const P = mod.pureCircuits;
  let kyc = 0;
  const newMember = (n) => ({ key: newMachineKey(), payout: { bytes: b32(0x30 + n) } });
  const register = async (m, target = ld, time = NOW) => {
    m.kyc = b32(0xd0 + (kyc++ % 40));
    m.id = P.memberId(m.key.pk);
    const h = P.registerActionHash(target.addressBytes, m.key.pk, m.payout, m.kyc, time);
    await w.approve(h);
    await target.call('register', m.key.pk, m.payout, m.kyc, time);
    return m;
  };
  const nonce = (m, target = ld) => target.ledger()._members.lookup(m.id).nonce;
  const sign = (m, action, digest, { target = ld, sk = m.key.sk, n } = {}) =>
    signMessage(P.memberMessage(target.addressBytes, padTag(action), m.id, digest, n ?? nonce(m, target)), sk);
  const claim = (m, time = NOW, opts = {}) =>
    (opts.target ?? ld).call('claim', m.id, time, opts.sig ?? sign(m, 'claim', P.timeDigest(time), opts));
  const touch = (m, time, opts = {}) =>
    (opts.target ?? ld).call('touchLiveness', m.id, time, opts.sig ?? sign(m, 'touchLiveness', P.timeDigest(time), opts));
  const member = (m, target = ld) => target.ledger()._members.lookup(m.id);
  /** Events of the last call on `target`, as {name, words: [hex x8]}. */
  // Events restored to their exact layout (the runtime drops trailing zeros).
  const events = (target = ld) => target.events().map((e) => {
    const { name, bytes } = restoreEventValue(e.data.content.value[0]);
    return { name, words: payloadWords(bytes) };
  });
  return Object.assign(w, { mod, P, ld, deployLd, newMember, register, nonce, sign, claim, touch, member, events });
}
const le = (b) => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };

// ------------------------------------------------------------ structure ---

test('LD3-0: no member or council witness; constructor binds EBT and the council', { skip }, async () => {
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, NAME, 'compiler', 'contract-info.json'), 'utf8'));
  const witnesses = info.witnesses.map((x) => x.name);
  assert.deepEqual(witnesses, ['witness_divmod'], 'only the checked division helper may remain');
  for (const gone of ['bumpOnMint', 'executePayout', 'setMultisigAuthority']) {
    assert.ok(!info.circuits.some((c) => c.name === gone), `${gone} must be gone`);
  }
  const s = await setup();
  assert.equal(hex(s.ld.ledger()._ebt.bytes), hex(s.ebt.addressBytes));
  assert.equal(hex(s.ld.ledger()._council.bytes), hex(s.council.addressBytes));
  // EBT never references LD (no re-entry path): its contract types are the council and
  // the TariffRegistry anchor (fix #5).
  const ebtSrc = fs.readFileSync(path.join(BUILD, '..', '..', 'ebt', 'ebt-v8.compact'), 'utf8');
  assert.deepEqual([...ebtSrc.matchAll(/^contract (\w+)/gm)].map((m) => m[1]), ['Council', 'TariffRegistryAnchor']);   // fix #5: EBT reads TR's root
});

// ----------------------------------------------------------- accounting ---

test('LD3-1: a member claims their share; EBT mints it to their payout address in the same call', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const b = await s.register(s.newMember(2));
  await s.settle(10000n); // dividend slice 1000
  await s.claim(a);
  assert.equal(s.ebt.ledger()._dividendMinted, 500n);
  assert.equal(s.ld.ledger()._totalClaimed, 500n);
  const ev = s.events().find((e) => e.name === 'pp:ld:v3:claim');
  assert.ok(ev, 'claim event');
  assert.equal(hex(ev.words[0]), hex(a.id));
  assert.equal(hex(ev.words[1]), hex(a.payout.bytes));
  assert.equal(le(ev.words[2]), 500n);
  await s.claim(b);
  assert.equal(s.ebt.ledger()._dividendMinted, 1000n);
  // Nothing more to claim: a second claim pays 0 and mints nothing.
  await s.claim(a);
  assert.equal(s.ebt.ledger()._dividendMinted, 1000n);
});

test('LD3-2: a new member gets nothing that accrued before they joined', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  await s.settle(10000n);                  // 1000, all for a
  const b = await s.register(s.newMember(2));
  await s.settle(10000n);                  // 1000, split a/b
  await s.claim(b);
  assert.equal(s.ld.ledger()._totalClaimed, 500n);
  await s.claim(a);
  assert.equal(s.ld.ledger()._totalClaimed, 2000n);
  assert.equal(s.ebt.ledger()._dividendMinted, 2000n);
});

test('LD3-3: (a) dividend accrued with no members stays unminted in EBT\'s budget', { skip }, async () => {
  const s = await setup();
  await s.settle(10000n);                  // 1000 while nobody is registered
  const a = await s.register(s.newMember(1));
  assert.equal(s.ld.ledger()._heldWhileEmpty, 1000n);
  await s.claim(a);
  assert.equal(s.ebt.ledger()._dividendMinted, 0n, 'the first member does not receive it');
  assert.equal(s.ebt.ledger()._dividendAccrued, 1000n, 'it stays in the budget');
});

test('LD3-4: rounding never overdraws: 3 members share 1000; total paid <= accrued', { skip }, async () => {
  const s = await setup();
  const ms = [];
  for (let i = 1; i <= 3; i++) ms.push(await s.register(s.newMember(i)));
  await s.settle(10000n);
  for (const m of ms) await s.claim(m);
  assert.equal(s.ld.ledger()._totalClaimed, 999n);
  assert.ok(s.ebt.ledger()._dividendMinted <= s.ebt.ledger()._dividendAccrued);
});

test('LD3-5: unregister (council) forfeits unclaimed growth; the member can no longer claim', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const b = await s.register(s.newMember(2));
  await s.settle(10000n);
  const h = s.P.unregisterActionHash(s.ld.addressBytes, b.id, NOW);
  await assert.rejects(s.ld.call('unregister', b.id, NOW), /Council has not approved/);
  await s.approve(h);
  await s.ld.call('unregister', b.id, NOW);
  assert.equal(s.ld.ledger()._live, 1n);
  await assert.rejects(s.claim(b), /Not a live member/);
  await s.claim(a);
  assert.equal(s.ld.ledger()._totalClaimed, 500n, 'b\'s 500 stays unminted in EBT');
});

// -------------------------------------------------------- authorization ---

test('LD3-A1 (negative, PoC): a garbage member signature cannot claim', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  await s.settle(10000n);
  await assert.rejects(s.claim(a, NOW, { sig: garbageSignature() }), /Bad member signature/);
  assert.equal(s.ebt.ledger()._dividendMinted, 0n);
});

test('LD3-A2 (negative): one member cannot claim for another', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const b = await s.register(s.newMember(2));
  await s.settle(10000n);
  await assert.rejects(s.claim(a, NOW, { sk: b.key.sk }), /Bad member signature/);
});

test('LD3-A3 (negative): a used claim signature cannot be replayed (nonce)', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const sig = s.sign(a, 'claim', s.P.timeDigest(NOW));
  await s.claim(a, NOW, { sig });
  assert.equal(s.nonce(a), 1n);
  await assert.rejects(s.claim(a, NOW, { sig }), /Bad member signature/);
});

test('LD3-A4 (negative): a member signature for another LD deployment is refused', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const other = await s.deployLd();
  await assert.rejects(s.claim(a, NOW, { sig: s.sign(a, 'claim', s.P.timeDigest(NOW), { target: other, n: 0n }) }), /Bad member signature/);
});

test('LD3-A5 (negative): a signature for one action cannot be used for another', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const touchSig = s.sign(a, 'touchLiveness', s.P.timeDigest(NOW));
  await assert.rejects(s.claim(a, NOW, { sig: touchSig }), /Bad member signature/);
});

test('LD3-A6 (negative): registration needs the council; approval binds key, payout and KYC; no replay', { skip }, async () => {
  const s = await setup();
  const m = s.newMember(1);
  m.kyc = b32(0xee);
  await assert.rejects(s.ld.call('register', m.key.pk, m.payout, m.kyc, NOW), /Council has not approved/);
  const h = s.P.registerActionHash(s.ld.addressBytes, m.key.pk, m.payout, m.kyc, NOW);
  await s.approve(h);
  await assert.rejects(s.ld.call('register', m.key.pk, { bytes: b32(0x99) }, m.kyc, NOW), /Council has not approved/, 'payout swapped');
  await assert.rejects(s.ld.call('register', newMachineKey().pk, m.payout, m.kyc, NOW), /Council has not approved/, 'key swapped');
  await s.ld.call('register', m.key.pk, m.payout, m.kyc, NOW);
  await assert.rejects(s.ld.call('register', m.key.pk, m.payout, m.kyc, NOW), /Action already executed/);
});

test('LD3-A7 (negative): one registration per key and per KYC job', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const again = { ...a, kyc: b32(0xef) };
  const h1 = s.P.registerActionHash(s.ld.addressBytes, a.key.pk, a.payout, again.kyc, NOW);
  await s.approve(h1);
  await assert.rejects(s.ld.call('register', a.key.pk, a.payout, again.kyc, NOW), /Already registered/);
  const c = s.newMember(3);
  const h2 = s.P.registerActionHash(s.ld.addressBytes, c.key.pk, c.payout, a.kyc, NOW);
  await s.approve(h2);
  await assert.rejects(s.ld.call('register', c.key.pk, c.payout, a.kyc, NOW), /KYC job already used/);
});

test('LD3-A8 (negative): an unbound LD cannot mint: EBT refuses and the claim fails as a whole', { skip }, async () => {
  const s = await setup();
  const rogue = await s.deployLd();          // same EBT, never bound
  const a = await s.register(s.newMember(1), rogue);
  await s.settle(10000n);
  await assert.rejects(s.claim(a, NOW, { target: rogue }), /Only the bound Living Dividend/);
  assert.equal(s.member(a, rogue).nonce, 0n, 'member state unchanged');
  assert.equal(s.ebt.ledger()._dividendMinted, 0n);
});

// ------------------------------------------ (c) payout-address changes ---

const request = (s, m, newPayout, time, opts = {}) =>
  s.ld.call('requestPayoutChange', m.id, newPayout, time, opts.sig ?? s.sign(m, 'requestPayoutChange', s.P.payoutDigest(newPayout, time), opts));

test('LD3-P1: a member-signed payout change takes effect only after 72 h; claims meanwhile go to the old address', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const NEW = { bytes: b32(0x55) };
  await request(s, a, NEW, NOW);
  assert.equal(s.ld.ledger()._pendingPayouts.lookup(a.id).effectiveAt, NOW + DELAY);
  await s.settle(10000n);
  await s.claim(a);
  assert.equal(hex(s.events().find((e) => e.name === 'pp:ld:v3:claim').words[1]), hex(a.payout.bytes), 'old address');
  s.ld.setTime(NOW + DELAY - 1n);
  await assert.rejects(s.ld.call('confirmPayoutChange', a.id), /Payout change not yet effective/);
  s.ld.setTime(NOW + DELAY);
  await s.ld.call('confirmPayoutChange', a.id);   // anyone may confirm once due
  assert.equal(hex(s.member(a).payout.bytes), hex(NEW.bytes));
  assert.equal(s.ld.ledger()._pendingPayouts.member(a.id), false);
});

test('LD3-P2 (negative): payout changes need the member\'s own, fresh, unreplayed signature', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const b = await s.register(s.newMember(2));
  const NEW = { bytes: b32(0x55) };
  await assert.rejects(request(s, a, NEW, NOW, { sig: garbageSignature() }), /Bad member signature/);
  await assert.rejects(request(s, a, NEW, NOW, { sk: b.key.sk }), /Bad member signature/);
  const sig = s.sign(a, 'requestPayoutChange', s.P.payoutDigest(NEW, NOW));
  await assert.rejects(request(s, a, { bytes: b32(0x56) }, NOW, { sig }), /Bad member signature/, 'signature binds the address');
  await request(s, a, NEW, NOW, { sig });
  await assert.rejects(request(s, a, NEW, NOW, { sig }), /Bad member signature/, 'replay');
  // Backdating the request (to shorten the delay) is refused.
  const old = NOW - 2n * 3600n;
  await assert.rejects(request(s, a, NEW, old), /Stale timestamp/);
});

test('LD3-P3: the member or the council can cancel a pending change', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const NEW = { bytes: b32(0x55) };
  await request(s, a, NEW, NOW);
  await s.ld.call('cancelPayoutChange', a.id, NOW, s.sign(a, 'cancelPayoutChange', s.P.timeDigest(NOW)));
  assert.equal(s.ld.ledger()._pendingPayouts.member(a.id), false);
  s.ld.setTime(NOW + 1n);
  await request(s, a, NEW, NOW + 1n);
  const h = s.P.cancelPayoutActionHash(s.ld.addressBytes, a.id, NOW + 1n);
  await assert.rejects(s.ld.call('councilCancelPayoutChange', a.id, NOW + 1n), /Council has not approved/);
  await s.approve(h);
  await s.ld.call('councilCancelPayoutChange', a.id, NOW + 1n);
  s.ld.setTime(NOW + 1n + DELAY);
  await assert.rejects(s.ld.call('confirmPayoutChange', a.id), /No pending payout change/);
  assert.equal(hex(s.member(a).payout.bytes), hex(a.payout.bytes));
});

// --------------------------------------------------------------- pruning ---

test('LD3-R1: inactive members are pruned after 180 days + 30 days\' grace; a touch cancels it', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const b = await s.register(s.newMember(2));
  const T = NOW + 180n * DAY;
  s.ld.setTime(T - 1n);
  await assert.rejects(s.ld.call('proposePrune', a.id, T - 1n), /Member is within the activity window/);
  s.ld.setTime(T);
  await s.ld.call('proposePrune', a.id, T);
  await s.ld.call('proposePrune', b.id, T);
  await assert.rejects(s.ld.call('proposePrune', a.id, T), /Prune already pending/);
  await s.touch(b, T);                                // b is alive
  assert.equal(s.ld.ledger()._pendingPrunes.member(b.id), false);
  s.ld.setTime(T + 30n * DAY - 1n);
  await assert.rejects(s.ld.call('executePrune', a.id), /Prune grace period not elapsed/);
  s.ld.setTime(T + 30n * DAY);
  await s.ld.call('executePrune', a.id);
  assert.equal(s.member(a).isLive, false);
  assert.equal(s.ld.ledger()._live, 1n);
  await assert.rejects(s.ld.call('executePrune', b.id), /No pending prune/);
});

test('LD3-R2 (negative): a prune cannot be backdated to skip the grace period', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  const late = NOW + 400n * DAY;                     // long inactive
  s.ld.setTime(late);
  await assert.rejects(s.ld.call('proposePrune', a.id, NOW + 180n * DAY), /Stale timestamp/);
});

test('LD3-R3 (negative): a garbage or replayed liveness signature does not keep a member alive', { skip }, async () => {
  const s = await setup();
  const a = await s.register(s.newMember(1));
  await assert.rejects(s.touch(a, NOW, { sig: garbageSignature() }), /Bad member signature/);
  const sig = s.sign(a, 'touchLiveness', s.P.timeDigest(NOW));
  await s.touch(a, NOW, { sig });
  await assert.rejects(s.touch(a, NOW, { sig }), /Bad member signature/);
});
