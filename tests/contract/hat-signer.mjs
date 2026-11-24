// The v9 settle signing flow with the HAT chip's NATIVE attestation (Garrett,
// 2026-11-24; firmware PollPower/gateway-execution, ATTEST 0x60):
//   1. the chip attests its OWN metered energy: Ed25519 (on chip) over
//      SHA-512("pollpower:hat:attest:v1" || ieee(8) || userid(4 BE) ||
//      sessionID[0..16] || session_uwh(8 BE) || uptime_ms(8 BE) || nonce(8));
//   2. meter-authority-service verifies that signature and its rules, then
//      signs hatMessage(self, settleRecordDigest(...), chipPubkey, R, S)
//      with the Jubjub meter-authority key;
//   3. settle carries the record; the circuit checks the Jubjub signature and
//      that amount == floor(session_uwh / 1000), and emits the attestation.
// The contract does not verify Ed25519 (ledger 9 has no verifier for it).
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { signMessage } from './machine-signer.mjs';

export const ATTEST_DOMAIN = 'pollpower:hat:attest:v1';

export function newChipKey() {
  const sk = ed25519.utils.randomSecretKey();
  return { sk, pk: ed25519.getPublicKey(sk), ieee: crypto.randomBytes(8), userid: crypto.randomInt(0, 2 ** 31) };
}

const be = (x, n) => { const b = Buffer.alloc(n); let v = BigInt(x); for (let i = n - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

/** chipHwId as settle takes it: ieee(8) || userid(4 BE) || zeros(20). */
export const chipHwId = (chip) => Uint8Array.from(Buffer.concat([chip.ieee, be(chip.userid, 4), Buffer.alloc(20)]));

/** The 75-byte pre-image the firmware hashes (pp_attest.h). */
export function attestPreimage({ ieee, userid, sessionId16, uwh, uptimeMs, nonce }) {
  return Buffer.concat([Buffer.from(ATTEST_DOMAIN, 'utf8'), Buffer.from(ieee), be(userid, 4), Buffer.from(sessionId16),
    be(uwh, 8), be(uptimeMs, 8), be(nonce, 8)]);
}
/** What the chip signs: SHA-512 of the pre-image (TI PureEdDSA over the digest). */
export const attestDigest = (fields) => crypto.createHash('sha512').update(attestPreimage(fields)).digest();

/** The chip's native attestation for a settle's fields (sessionID[0..16] is the chip session id). */
export function chipAttest(chip, f) {
  const sig = ed25519.sign(attestDigest({
    ieee: chip.ieee, userid: chip.userid, sessionId16: f.sessionID.slice(0, 16),
    uwh: f.chipSessionUwh, uptimeMs: f.chipUptimeMs, nonce: f.chipNonce,
  }), chip.sk);
  return { chipPubkey: chip.pk, chipSigR: sig.slice(0, 32), chipSigS: sig.slice(32, 64) };
}

/**
 * Chip attestation + meter-authority countersignature for a settle.
 * f: { sessionID, amount, producerKey, producerAddr, meterKeyHash, chipHwId,
 *      chipSessionUwh, chipUptimeMs, chipNonce }
 */
export function signSettle(mod, target, f, { chip, hatSk, addressBytes }) {
  const self = addressBytes ?? target.addressBytes;
  const a = chipAttest(chip, f);
  const recordDigest = mod.pureCircuits.settleRecordDigest(self, f.sessionID, f.amount, f.producerKey, f.producerAddr,
    f.meterKeyHash, f.chipHwId, f.chipSessionUwh, f.chipUptimeMs, f.chipNonce);
  const msg = mod.pureCircuits.hatMessage(self, recordDigest, a.chipPubkey, a.chipSigR, a.chipSigS);
  return { ...a, recordDigest, hatSig: signMessage(msg, hatSk) };
}

/** settle's argument list up to and including hatSig. */
export const settleHatArgs = (f, s) => [
  f.sessionID, f.amount, f.producerKey, f.producerAddr, f.meterKeyHash,
  f.chipHwId, f.chipSessionUwh, f.chipUptimeMs, f.chipNonce,
  s.chipPubkey, s.chipSigR, s.chipSigS, s.hatSig,
];

/** A 32-byte settle session id from a 16-byte chip session id (zero-padded). */
export const sessionFrom16 = (sid16) => Uint8Array.from(Buffer.concat([Buffer.from(sid16), Buffer.alloc(16)]));
