// T20 - escrow-attestor rotation is multisig-gated (review-pass-1 fix,
// VNEXT-DESIGN §6.4). The escrow-attestor pubkey controls whether KES
// redemptions can drain the escrow, so its rotation MUST be under the
// same multisig authority as LD binding, not the owner-only execOwnerOp.
//
// Coverage:
//   1. Multisig-approved execMultisigOp op=4 rotates _escrowAttestorPubkey.
//   2. Rotation with no matching multisig approval fails.
//   3. execOwnerOp with the old op=2 code fails at the 'bad op' assert
//      (proves the branch was removed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeEbtFixture, newEd25519, assertReverts,
  persistentHash, pad32, u64ToBytes32, bufEq,
} from '../lib.mjs';

test('T20 multisig-signed execMultisigOp op=4 rotates the escrow attestor', () => {
  const { ebt } = makeEbtFixture();
  const before = Buffer.from(ebt._escrowAttestorPubkey);
  const newAttestor = newEd25519().pubkeyBytes;
  const currentTime = 2_000_000n;

  // Off-chain multisig bundle: bind the payload hash the on-chain
  // execMultisigOp will reconstruct.
  const payload = persistentHash([
    pad32('ebt:v8:setEscrowAttestor'),
    newAttestor,
    u64ToBytes32(currentTime),
  ]);
  ebt.approveMultisig(payload);

  ebt.execMultisigOp({
    op: 4, newEscrowAttestor: newAttestor,
    currentTime, now: currentTime,
  });

  assert.ok(!bufEq(ebt._escrowAttestorPubkey, before),
            'escrow attestor pubkey should have rotated');
  assert.ok(bufEq(ebt._escrowAttestorPubkey, newAttestor),
            'escrow attestor pubkey equals new value');
});

test('T20 rotation with no multisig approval fails', () => {
  const { ebt } = makeEbtFixture();
  const before = Buffer.from(ebt._escrowAttestorPubkey);
  const newAttestor = newEd25519().pubkeyBytes;
  const currentTime = 2_000_000n;

  // Deliberately DO NOT approve the payload.
  assertReverts(
    () => ebt.execMultisigOp({
      op: 4, newEscrowAttestor: newAttestor,
      currentTime, now: currentTime,
    }),
    'setEscrowAttestor: multisig signature invalid',
  );
  // Anchor should be unchanged.
  assert.ok(bufEq(ebt._escrowAttestorPubkey, before),
            'escrow attestor pubkey unchanged on multisig failure');
});

test('T20 zero-pubkey rejected', () => {
  const { ebt } = makeEbtFixture();
  const zero = Buffer.alloc(32);
  const currentTime = 2_000_000n;

  const payload = persistentHash([
    pad32('ebt:v8:setEscrowAttestor'),
    zero, u64ToBytes32(currentTime),
  ]);
  ebt.approveMultisig(payload);

  assertReverts(
    () => ebt.execMultisigOp({
      op: 4, newEscrowAttestor: zero,
      currentTime, now: currentTime,
    }),
    'setEscrowAttestor: zero pubkey rejected',
  );
});

test('T20 no-op rotation (same pubkey) rejected', () => {
  const { ebt } = makeEbtFixture();
  const same = Buffer.from(ebt._escrowAttestorPubkey);
  const currentTime = 2_000_000n;

  const payload = persistentHash([
    pad32('ebt:v8:setEscrowAttestor'),
    same, u64ToBytes32(currentTime),
  ]);
  ebt.approveMultisig(payload);

  assertReverts(
    () => ebt.execMultisigOp({
      op: 4, newEscrowAttestor: same,
      currentTime, now: currentTime,
    }),
    'setEscrowAttestor: no-op rotation',
  );
});

test('T20 execOwnerOp with old op=2 code hits bad-op assert', () => {
  const { ebt } = makeEbtFixture();
  const attemptedAttestor = newEd25519().pubkeyBytes;

  // Op=2 was the pre-fix escrow-attestor branch in execOwnerOp. It has been
  // removed; the mirror's execOwnerOp now only accepts op=1 (setMeterAuthority)
  // beyond op=0 (transferOwnership, not covered by the JS mirror).
  assertReverts(
    () => ebt.execOwnerOp({ op: 2, newAuthorityPubkey: attemptedAttestor }),
    'execOwnerOp: bad op',
  );
});
