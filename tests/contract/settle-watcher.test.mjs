// Settle-event watcher (Garrett 2026-11-24): ledger 9 cannot verify the HAT
// chip's Ed25519 signature, so the watcher re-verifies every pp:ebt:v9:settleChip
// event against the chip's ON-CHAIN registered key and alerts on mismatch.
// The key case: a countersigned SIGN_HASH-style signature (e.g. a compromised
// meter-authority key) IS accepted by the contract, and the watcher catches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { buildExists, b32 } from '../parity/harness.mjs';
import { settleWorld, T0, CLASS } from './settle-world.mjs';
import { settleHatArgs, chipHwId, sessionFrom16 } from './hat-signer.mjs';
import { signMessage } from './machine-signer.mjs';
import { findSettleChipEvents, decodeSettleChipEvent, verifySettleChipEvent } from '../../tooling/watcher/settle-watcher-lib.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;

const localEventBytes = (w) => w.ebt.events().map((e) => Buffer.from(e.data.content.value[0]));
const registry = (w) => (pk) => (w.ebt.ledger()._chips.member(pk) ? w.ebt.ledger()._chips.lookup(pk) : null);

test('W-1: an honest settle event verifies against the registered chip key', { skip }, async () => {
  const w = await settleWorld();
  const { fields } = await w.settle(10000n);
  const evs = findSettleChipEvents(localEventBytes(w));
  assert.equal(evs.length, 1);
  const ev = decodeSettleChipEvent(evs[0]);
  assert.equal(ev.sessionUwh, fields.chipSessionUwh);
  const r = verifySettleChipEvent(ev, registry(w)(ev.chipPubkey), { amount: fields.amount });
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('W-2 (negative): a countersigned SIGN_HASH-style signature mints on chain, and the watcher flags it', { skip }, async () => {
  const w = await settleWorld();
  // A compromised / buggy service countersigns a record whose "chip signature"
  // is the chip signing a host hash (SIGN_HASH), not its native attestation.
  const f = {
    sessionID: sessionFrom16(new Uint8Array(16).fill(0x31)), amount: 10000n, producerKey: b32(0x63),
    producerAddr: { bytes: b32(0x64) }, meterKeyHash: b32(0x65), chipHwId: chipHwId(w.keys.chip),
    chipSessionUwh: 10_000_123n, chipUptimeMs: 1n, chipNonce: 999n,
  };
  const rec = w.ebtMod.pureCircuits.settleRecordDigest(w.ebt.addressBytes, f.sessionID, f.amount, f.producerKey, f.producerAddr,
    f.meterKeyHash, f.chipHwId, f.chipSessionUwh, f.chipUptimeMs, f.chipNonce);
  const sig = ed25519.sign(rec, w.keys.chip.sk);                     // SIGN_HASH over a host-chosen hash
  const s = { chipPubkey: w.keys.chip.pk, chipSigR: sig.slice(0, 32), chipSigS: sig.slice(32) };
  s.hatSig = signMessage(w.ebtMod.pureCircuits.hatMessage(w.ebt.addressBytes, rec, s.chipPubkey, s.chipSigR, s.chipSigS), w.keys.hat.sk);
  await w.ebt.call('settle', ...settleHatArgs(f, s), w.scheduleId, CLASS, 1n, 2n, [b32(0), b32(0), b32(0), b32(0)],
    [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n], 6500n, 2000n, 1000n, 500n, 6500n, 2000n, 1000n, 500n, T0);   // accepted on chain
  const ev = decodeSettleChipEvent(findSettleChipEvents(localEventBytes(w))[0]);
  const r = verifySettleChipEvent(ev, registry(w)(ev.chipPubkey), { amount: f.amount });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('bad_chip_signature'), r.problems.join(','));
});

test('W-3 (negative): unregistered / revoked chip, hardware-id or amount mismatch are flagged', () => {
  const chip = { sk: ed25519.utils.randomSecretKey() };
  chip.pk = ed25519.getPublicKey(chip.sk);
  chip.ieee = Buffer.alloc(8, 0x6a);
  chip.userid = 9;
  const hw = chipHwId(chip);
  const ev = { sessionId: Buffer.alloc(32), chipPubkey: chip.pk, chipSig: new Uint8Array(64), chipHwId: hw, sessionUwh: 5000n, uptimeMs: 1n, nonce: 1n };
  assert.deepEqual(verifySettleChipEvent(ev, null).problems, ['chip_not_registered']);
  const rec = { hwId: hw, active: false };
  assert.ok(verifySettleChipEvent(ev, rec).problems.includes('chip_revoked'));
  assert.ok(verifySettleChipEvent(ev, { hwId: b32(9), active: true }).problems.includes('hw_id_mismatch'));
  assert.ok(verifySettleChipEvent(ev, { hwId: hw, active: true }, { amount: 6n }).problems.includes('amount_mismatch'));
});

test('W-4: events are found in raw indexer bytes (name + payload inside a VersionedLogItem)', () => {
  const name = Buffer.alloc(32); name.write('pp:ebt:v9:settleChip');
  const payload = Buffer.alloc(256, 7);
  const raw = Buffer.concat([Buffer.from([1, 9, 0, 0]), name, payload, Buffer.from([0xee])]);
  const found = findSettleChipEvents([raw]);
  assert.equal(found.length, 1);
  assert.equal(found[0].length, 288);
});
