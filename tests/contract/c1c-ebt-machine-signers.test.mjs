// WI16-C-1c (EBT): machine signatures are verified in-circuit.
//
// Before WI-16, settle (meter authority HAT), redeem (escrow attestor) and the
// manualReissue co-signature asserted `signature_valid(pubkey, hash, sig)`, a
// prover-supplied witness: any prover answering `true` minted EBT, redeemed
// past the solvency guard, or skipped the reissue co-signature. The witnesses
// below include that LYING `signature_valid`; after the fix the contract has
// no such witness, so it cannot be reached.
//
// Now the meter authority and the escrow attestor are Jubjub keys held in the
// ledger, and each signs the Field returned by an exported pure circuit:
//   hatMessage(self, chipDigest, chipPubkey, chipSigR, chipSigS), where
//     chipDigest(self, sessionID, amount, producerKey, producerAddr,
//                meterKeyHash, meterTime, meterCounter)
//   is what the HAT chip signs (Ed25519, checked by meter-authority-service;
//   see hat-signer.mjs and the trust-model note in the design doc)
//   escrowMessage(self, trustFloat, outstandingEbt, attestationEpoch)
//   reissueMessage(self, producerKey, producerAddr, amount, seq)
// verified with jubjubSchnorrVerify<1>. Each message carries the contract's
// own address, so a signature for one deployment is useless on another.
//
// A "signature accepted" case is shown by the call getting past the signature
// check to the next, unrelated assertion (settle: PRODUCER_NOT_ATTESTED), or
// by the call completing (manualReissue, redeem).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, b32, hex, padTag, RTlib } from '../parity/harness.mjs';
import { newOwnerKey, signOwnerAction, garbageSignature } from './owner-signer.mjs';
import { newMachineKey, signMessage } from './machine-signer.mjs';
import { newChipKey, signSettle, settleHatArgs } from './hat-signer.mjs';
import { settleWorld } from './settle-world.mjs';

const NAME = 'ebt-v8';
const skip = buildExists(NAME) ? false : 'build/l9/ebt-v8 missing: run `npm run build:contracts`';

const witnesses = {
  signature_valid: (ctx) => [ctx.privateState, true], // the PoC's lying witness
};

const OWNER = newOwnerKey();
const HAT = newMachineKey();
const ESCROW = newMachineKey();
const NOW = 10_000n;

async function setup() {
  const mod = await loadContract(NAME);
  const deployEbt = async () => {
    const c = await deploy(mod, witnesses, [
      OWNER.pk, HAT.pk, { bytes: b32(0xa2) },
      { bytes: b32(0x21) }, { bytes: b32(0x23) }, ESCROW.pk, b32(0xa4),
    ]);
    return Object.assign(c, { mod });
  };
  return { mod, e: await deployEbt(), deployEbt };
}

const ownerCall = (c, circuit, args) =>
  c.call(circuit, ...args, signOwnerAction(c.mod, c, circuit, args, { sk: OWNER.sk }));

// ---------------------------------------------------------------- settle ---

const CHIP = newChipKey();
const HAT_FIELDS = {
  sessionID: b32(0x61), amount: 0x0102030405n, producerKey: b32(0x63),
  producerAddr: { bytes: b32(0x64) }, meterKeyHash: b32(0x65), meterTime: 9000n, meterCounter: 7n,
};
// The chip part of a settle, as an honest chip would sign it for (target, f).
const chipPart = (mod, target, f) => signSettle(mod, target, f, { chip: CHIP, hatSk: HAT.sk });
// The meter-authority message for (target, f) with that chip part.
const hatMsg = (mod, target, f = HAT_FIELDS) => {
  const c = chipPart(mod, target, f);
  return mod.pureCircuits.hatMessage(target.addressBytes, c.chipDigest, c.chipPubkey, c.chipSigR, c.chipSigS);
};
// settle with fields f, an honest chip part for (c, f) unless `chip` overrides it, and HAT signature `sig`.
const settle = (c, sig, f = HAT_FIELDS, chip = {}) => c.call('settle',
  ...settleHatArgs(f, { ...chipPart(c.mod, c, f), ...chip, hatSig: sig }),
  b32(0), b32(0), 0n, 1n, [b32(0), b32(0), b32(0), b32(0)], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n],
  0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, NOW);
const BAD_HAT = /Bad HAT signature/;
const HAT_ACCEPTED = /PRODUCER_NOT_ATTESTED/; // the next check after the signature

test('C1c-EBT-0: no signature witness left; machine keys are Jubjub points', { skip }, async () => {
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, NAME, 'compiler', 'contract-info.json'), 'utf8'));
  assert.ok(!info.witnesses.some((w) => w.name === 'signature_valid'), 'signature_valid must be gone');
  const { e } = await setup();
  const L = e.ledger();
  assert.equal(L._meterAuthorityPubkey.x, HAT.pk.x);
  assert.equal(L._meterAuthorityPubkey.y, HAT.pk.y);
  assert.equal(L._escrowAttestorPubkey.x, ESCROW.pk.x);
  assert.equal(L._escrowAttestorPubkey.y, ESCROW.pk.y);
});

test('C1c-EBT-S1 (negative, PoC): a lying witness and a garbage HAT signature cannot settle', { skip }, async () => {
  const { e } = await setup();
  await assert.rejects(settle(e, garbageSignature()), BAD_HAT);
  assert.equal(e.ledger()._settledSessions.member(HAT_FIELDS.sessionID), false);
});

test('C1c-EBT-S2 (negative): a HAT signed by any key other than the meter authority is refused', { skip }, async () => {
  const { mod, e } = await setup();
  await assert.rejects(settle(e, signMessage(hatMsg(mod, e), newMachineKey().sk)), BAD_HAT);
  await assert.rejects(settle(e, signMessage(hatMsg(mod, e), ESCROW.sk)), BAD_HAT, 'escrow attestor key');
  await assert.rejects(settle(e, signMessage(hatMsg(mod, e), OWNER.sk)), BAD_HAT, 'owner key');
});

test('C1c-EBT-S3 (negative): the HAT binds amount, producer, recipient address and meter', { skip }, async () => {
  const { mod, e } = await setup();
  const sig = signMessage(hatMsg(mod, e), HAT.sk);
  await assert.rejects(settle(e, sig, { ...HAT_FIELDS, amount: HAT_FIELDS.amount + 1n }), BAD_HAT, 'amount');
  await assert.rejects(settle(e, sig, { ...HAT_FIELDS, producerKey: b32(0x73) }), BAD_HAT, 'producerKey');
  await assert.rejects(settle(e, sig, { ...HAT_FIELDS, producerAddr: { bytes: b32(0x74) } }), BAD_HAT, 'producerAddr (EBT-H-1)');
  await assert.rejects(settle(e, sig, { ...HAT_FIELDS, meterKeyHash: b32(0x75) }), BAD_HAT, 'meterKeyHash');
  await assert.rejects(settle(e, sig, { ...HAT_FIELDS, sessionID: b32(0x76) }), BAD_HAT, 'sessionID');
});

test('C1c-EBT-S3b (negative): the HAT binds the chip key, the chip signature and the meter time and counter', { skip }, async () => {
  const { mod, e } = await setup();
  const sig = signMessage(hatMsg(mod, e), HAT.sk);
  await assert.rejects(settle(e, sig, HAT_FIELDS, { chipPubkey: newChipKey().pk }), BAD_HAT, 'chip key swapped');
  await assert.rejects(settle(e, sig, HAT_FIELDS, { chipSigR: b32(0x01) }), BAD_HAT, 'chip signature R swapped');
  await assert.rejects(settle(e, sig, HAT_FIELDS, { chipSigS: b32(0x01) }), BAD_HAT, 'chip signature S swapped');
  await assert.rejects(settle(e, sig, { ...HAT_FIELDS, meterTime: 9001n }), BAD_HAT, 'meter time');
  await assert.rejects(settle(e, sig, { ...HAT_FIELDS, meterCounter: 8n }), BAD_HAT, 'meter counter');
});

test('C1c-EBT-S4 (negative): a HAT for another EBT deployment is refused here', { skip }, async () => {
  const { mod, e, deployEbt } = await setup();
  const other = await deployEbt();
  const sig = signMessage(hatMsg(mod, other), HAT.sk); // same authority key, other contract
  await assert.rejects(settle(e, sig), BAD_HAT);
  await assert.rejects(settle(other, sig), HAT_ACCEPTED); // valid where it was meant
});

test('C1c-EBT-S5: a meter-authority HAT passes the signature check', { skip }, async () => {
  const { mod, e } = await setup();
  await assert.rejects(settle(e, signMessage(hatMsg(mod, e), HAT.sk)), HAT_ACCEPTED);
});

test('C1c-EBT-S6: after the owner rotates the meter authority, only the new key signs HATs', { skip }, async () => {
  const { mod, e } = await setup();
  const next = newMachineKey();
  await ownerCall(e, 'execOwnerOp', [1n, OWNER.pk, next.pk]);
  assert.equal(e.ledger()._meterAuthorityPubkey.x, next.pk.x);
  await assert.rejects(settle(e, signMessage(hatMsg(mod, e), HAT.sk)), BAD_HAT, 'old key');
  await assert.rejects(settle(e, signMessage(hatMsg(mod, e), next.sk)), HAT_ACCEPTED, 'new key');
});

// --------------------------------------------------------- manualReissue ---

const TP = { scheduleId: b32(0x31), classPath: b32(0x32), epoch: 1n, fiatValueAtMint: 2n };
const RE = { producerKey: b32(0x41), producerAddr: { bytes: b32(0x42) }, amount: 1000n };
const reissueMsg = (mod, target, seq, r = RE) =>
  mod.pureCircuits.reissueMessage(target.addressBytes, r.producerKey, r.producerAddr, r.amount, seq);
// manualReissue's argument order is (..., currentTime, authoritySig, ownerSig); the
// owner signs the arguments before authoritySig.
const reissueCall = (c, coSig, time = NOW, r = RE) => {
  const args = [r.producerKey, r.producerAddr, r.amount, 1n, b32(0x43), TP, time];
  return c.call('manualReissue', ...args, coSig, signOwnerAction(c.mod, c, 'manualReissue', args, { sk: OWNER.sk }));
};
const NO_COSIG = /Reissue requires authority co-signature/;

test('C1c-EBT-M1 (negative, PoC): a lying witness and a garbage co-signature cannot reissue', { skip }, async () => {
  const { e } = await setup();
  await assert.rejects(reissueCall(e, garbageSignature()), NO_COSIG);
  assert.equal(e.ledger().reissuanceCount, 0n);
});

test('C1c-EBT-M2 (negative): the co-signature must come from the meter authority', { skip }, async () => {
  const { mod, e } = await setup();
  await assert.rejects(reissueCall(e, signMessage(reissueMsg(mod, e, 0n), OWNER.sk)), NO_COSIG, 'owner key');
  await assert.rejects(reissueCall(e, signMessage(reissueMsg(mod, e, 0n), ESCROW.sk)), NO_COSIG, 'escrow key');
});

test('C1c-EBT-M3 (negative): the co-signature binds the recipient address and the amount', { skip }, async () => {
  const { mod, e } = await setup();
  const coSig = signMessage(reissueMsg(mod, e, 0n), HAT.sk);
  // Before WI-16 the co-signed hash was (producerKey, amount, seq): the recipient was free.
  await assert.rejects(reissueCall(e, coSig, NOW, { ...RE, producerAddr: { bytes: b32(0x99) } }), NO_COSIG, 'recipient');
  await assert.rejects(reissueCall(e, coSig, NOW, { ...RE, amount: 999n }), NO_COSIG, 'amount');
});

test('C1c-EBT-M4 (negative): a co-signature for another EBT deployment is refused here', { skip }, async () => {
  const { mod, e, deployEbt } = await setup();
  const other = await deployEbt();
  await assert.rejects(reissueCall(e, signMessage(reissueMsg(mod, other, 0n), HAT.sk)), NO_COSIG);
});

test('C1c-EBT-M5: owner + meter-authority co-signature reissues once; the co-signature cannot be replayed', { skip }, async () => {
  const { mod, e } = await setup();
  const coSig = signMessage(reissueMsg(mod, e, 0n), HAT.sk);
  await reissueCall(e, coSig);
  assert.equal(e.ledger().reissuanceCount, 1n);
  assert.equal(e.ledger()._totalSupply, RE.amount);
  // Same co-signature after the cooldown: the sequence number moved on.
  await assert.rejects(reissueCall(e, coSig, NOW + 3600n), NO_COSIG);
  await reissueCall(e, signMessage(reissueMsg(mod, e, 1n), HAT.sk), NOW + 3600n);
  assert.equal(e.ledger().reissuanceCount, 2n);
});

// ---------------------------------------------------------------- redeem ---

const ESC = { float: 1_000_000n, outstanding: 0n, epoch: NOW };
const escrowMsg = (mod, target, a = ESC) =>
  mod.pureCircuits.escrowMessage(target.addressBytes, a.float, a.outstanding, a.epoch);
const giveBalance = (c, amount) => {
  const raw = RTlib.rawTokenType(padTag('pollpower:ebt:v8:epoch1'), c.address);
  c.setBalance(new Map([[{ tag: 'unshielded', raw }, amount]]));
};
const redeemKes = (c, sig, a = ESC, time = NOW, amount = 10n) => c.call('redeem',
  amount, b32(0x51), b32(0x52), 0n, TP, a.float, a.outstanding, a.epoch, sig, time);
const BAD_ESC = /ESCROW_ATTESTATION_SIG_INVALID/;

async function funded() {
  const s = await setup();
  await reissueCall(s.e, signMessage(reissueMsg(s.mod, s.e, 0n), HAT.sk)); // supply 1000
  giveBalance(s.e, 1000n);
  return s;
}

test('C1c-EBT-R1 (negative, PoC): a lying witness and a garbage attestation cannot redeem for KES', { skip }, async () => {
  const { e } = await funded();
  await assert.rejects(redeemKes(e, garbageSignature()), BAD_ESC);
  assert.equal(e.ledger()._totalRedeemed, 0n);
});

test('C1c-EBT-R2 (negative): the attestation must come from the escrow attestor', { skip }, async () => {
  const { mod, e } = await funded();
  await assert.rejects(redeemKes(e, signMessage(escrowMsg(mod, e), HAT.sk)), BAD_ESC, 'meter authority key');
  await assert.rejects(redeemKes(e, signMessage(escrowMsg(mod, e), OWNER.sk)), BAD_ESC, 'owner key');
});

test('C1c-EBT-R3 (negative): the attestation binds the float, the outstanding supply and the epoch', { skip }, async () => {
  const { mod, e } = await funded();
  const low = { ...ESC, float: 5n }; // attestor says the float is 5: KES redemption of 10 must fail
  const sig = signMessage(escrowMsg(mod, e, low), ESCROW.sk);
  await assert.rejects(redeemKes(e, sig, { ...low, float: 1_000_000n }), BAD_ESC, 'inflated float');
  await assert.rejects(redeemKes(e, sig, { ...low, outstanding: 1n }), BAD_ESC, 'outstanding');
  await assert.rejects(redeemKes(e, sig, { ...low, epoch: NOW + 1n }), BAD_ESC, 'epoch');
  await assert.rejects(redeemKes(e, sig, low), /SOLVENCY_GUARD_FAILED/, 'honest low float');
});

test('C1c-EBT-R4 (negative): an attestation for another EBT deployment is refused here', { skip }, async () => {
  const { mod, e, deployEbt } = await funded();
  const other = await deployEbt();
  await assert.rejects(redeemKes(e, signMessage(escrowMsg(mod, other), ESCROW.sk)), BAD_ESC);
});

test('C1c-EBT-R5: a fresh escrow attestation lets a solvent KES redemption through', { skip }, async () => {
  const { mod, e } = await funded();
  const stale = { ...ESC, epoch: 1n };
  await assert.rejects(redeemKes(e, signMessage(escrowMsg(mod, e, stale), ESCROW.sk), stale), /ESCROW_ATTESTATION_STALE/);
  await redeemKes(e, signMessage(escrowMsg(mod, e), ESCROW.sk));
  assert.equal(e.ledger()._totalRedeemed, 10n);
  assert.equal(e.ledger()._totalSupply, 990n);
});

test('C1c-EBT-P1: the signed messages are the pure circuits the services call (layout pinned)', { skip }, async () => {
  const { mod, e } = await setup();
  const T = (n) => new RTlib.CompactTypeVector(n, new RTlib.CompactTypeBytes(32));
  const le = (x) => new Uint8Array(RTlib.convertBigintToBytes(32, x, 'x'));
  const f = HAT_FIELDS;
  const c = chipPart(mod, e, f);
  assert.equal(hex(c.chipDigest), hex(RTlib.convertBigintToBytes(32, RTlib.transientHash(T(9), [
    padTag('pollpower:hat:chip:v1'), e.addressBytes, f.sessionID, le(f.amount), f.producerKey, f.producerAddr.bytes,
    f.meterKeyHash, le(f.meterTime), le(f.meterCounter)]), 'digest')), 'chipDigest layout');
  assert.equal(hatMsg(mod, e), RTlib.transientHash(T(6), [
    padTag('pollpower:ebt:v9:hat'), e.addressBytes, c.chipDigest, c.chipPubkey, c.chipSigR, c.chipSigS]));
  assert.equal(escrowMsg(mod, e), RTlib.transientHash(T(5), [
    padTag('pollpower:ebt:v9:escrow'), e.addressBytes, le(ESC.float), le(ESC.outstanding), le(ESC.epoch)]));
  assert.equal(reissueMsg(mod, e, 7n), RTlib.transientHash(T(6), [
    padTag('pollpower:ebt:v9:reissue'), e.addressBytes, RE.producerKey, RE.producerAddr.bytes, le(RE.amount), le(7n)]));
});

test('C1c-EBT-S8: a completed settle records the chip key, chip signature and meter reading in an event', { skip }, async () => {
  const w = await settleWorld();
  const { chip, fields } = await w.settle(10000n);
  const ev = w.ebt.events().map((x) => Buffer.from(x.data.content.value[0]))
    .find((b) => b.subarray(0, 32).toString('utf8').replace(/\0+$/, '') === 'pp:ebt:v9:settleChip');
  assert.ok(ev, 'settleChip event');
  const word = (i) => ev.subarray(32 + 32 * i, 64 + 32 * i);
  assert.equal(hex(word(0)), hex(fields.sessionID));
  assert.equal(hex(word(1)), hex(chip.chipPubkey));
  assert.equal(hex(word(2)), hex(chip.chipSigR));
  assert.equal(hex(word(3)), hex(chip.chipSigS));
  assert.equal(hex(word(4)), hex(chip.chipDigest));
});
