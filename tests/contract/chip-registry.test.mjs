// HAT chip registry + replay protection ON CHAIN (Garrett 2026-11-24).
// meter-authority-service already refuses unknown chips and reused sessions /
// nonces; these checks make the CONTRACT refuse them too, so a duplicate or
// rogue countersignature (e.g. a stolen service key) cannot mint:
//  - only a council-registered, active chip bound to this meter / producer /
//    payout address can back a settle (registerChip / revokeChip need 2-of-3);
//  - each chip nonce settles once (_usedChipNonces); each session once
//    (_settledSessions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExists, b32 } from '../parity/harness.mjs';
import { settleWorld, T0 } from './settle-world.mjs';
import { newChipKey, chipHwId } from './hat-signer.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;

test('CR-1 (negative): a chip that is not registered on chain cannot back a settle', { skip }, async () => {
  const w = await settleWorld();
  await assert.rejects(w.settle(10000n, {}, { chip: newChipKey() }), /CHIP_NOT_REGISTERED/);
  await w.settle(10000n);                                          // the registered chip works
});

test('CR-2 (negative): registering a chip needs 2-of-3 council approval of exactly that binding', { skip }, async () => {
  const w = await settleWorld();
  const chip = newChipKey();
  const args = [chip.pk, chipHwId(chip), w.keys.chip ? b32(0x65) : b32(0x65), b32(0x63), { bytes: b32(0x64) }, T0 + 100n];
  await assert.rejects(w.ebt.call('registerChip', ...args), /Council has not approved/, 'no approval');
  const h = w.ebtMod.pureCircuits.councilChipHash(w.ebt.addressBytes, 1n, ...args);
  await w.approve(h, [0]);
  await assert.rejects(w.ebt.call('registerChip', ...args), /Council has not approved/, 'one approval');
  await w.approve(h, [1]);
  await assert.rejects(w.ebt.call('registerChip', chip.pk, chipHwId(chip), b32(0x65), b32(0x63), { bytes: b32(0x99) }, T0 + 100n),
    /Council has not approved/, 'payout swapped');
  await w.ebt.call('registerChip', ...args);
  assert.equal(w.ebt.ledger()._chips.lookup(chip.pk).active, true);
});

test('CR-3 (negative): a chip bound to another payout address cannot settle for this one', { skip }, async () => {
  const w = await settleWorld();
  const chip = newChipKey();
  await w.registerChip(chip, { producerAddr: { bytes: b32(0x99) } });
  await assert.rejects(w.settle(10000n, {}, { chip }), /CHIP_BINDING_MISMATCH/);
});

test('CR-4 (negative): a revoked chip cannot settle', { skip }, async () => {
  const w = await settleWorld();
  await w.revokeChip(w.keys.chip);
  await assert.rejects(w.settle(10000n), /CHIP_REVOKED/);
});

test('CR-5 (negative): a chip nonce settles once, even if a countersignature is produced twice', { skip }, async () => {
  const w = await settleWorld();
  await w.settle(10000n, {}, { chipNonce: 77n });
  await assert.rejects(w.settle(10000n, {}, { chipNonce: 77n }), /CHIP_NONCE_REPLAYED/, 'new session, same chip nonce');
  await w.settle(10000n, {}, { chipNonce: 78n });
});

test('CR-6 (negative): a session settles once', { skip }, async () => {
  const w = await settleWorld();
  await w.settle(10000n, {}, { session: 5, chipNonce: 500n });
  await assert.rejects(w.settle(10000n, {}, { session: 5, chipNonce: 501n }), /Session already settled/);
});
