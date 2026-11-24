// Settle-event watcher core (Garrett 2026-11-24; runbook:
// docs/runbooks/hat-settle-watcher.md).
//
// Ledger 9 cannot verify Ed25519, so EBT settle cannot check the HAT chip's own
// signature. Every settle emits pp:ebt:v9:settleChip with the chip's native
// attestation; this module re-verifies it against the chip's ON-CHAIN
// registered record (EBT _chips) and reports problems. Any problem is an alert
// to all council members (revocation is 2-of-3; there is no single-member
// suspend).
//
// Event (exact layout 288 bytes, tooling/events/event-codec.mjs): name(32) ||
// sessionID, chipPubkey, chipSigR, chipSigS, chipHwId, chipSessionUwh,
// chipUptimeMs, chipNonce (32 bytes each; integers little-endian). The runtime
// drops trailing zero bytes, so events are restored to exactly 288 bytes (and
// refused if longer) before decoding; the signature is checked over the
// pre-image rebuilt from the restored fields. Chip pre-image (firmware
// pp_attest.h): "pollpower:hat:attest:v1" || ieee(8) || userid(4 BE) ||
// sessionID[0..16] || uwh(8 BE) || uptime_ms(8 BE) || nonce(8 BE), signed as
// its SHA-512 digest.
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { restoreEventValue, payloadWords, nameField } from '../events/event-codec.mjs';

export const SETTLE_CHIP_EVENT = 'pp:ebt:v9:settleChip';
const NAME = nameField(SETTLE_CHIP_EVENT);
const le = (b) => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };
const le32 = (x) => { const b = Buffer.alloc(32); let v = BigInt(x); for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const be = (x, n) => { const b = Buffer.alloc(n); let v = BigInt(x); for (let i = n - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/**
 * settleChip events, restored to exactly 288 bytes. Each input is one event
 * value (name || payload, possibly trimmed of trailing zeros). An input that
 * holds the event name at offset 0 but is longer than 288 bytes is refused.
 * Inputs whose event is a different type are skipped.
 */
export function findSettleChipEvents(values) {
  const out = [];
  for (const v of values) {
    const b = Buffer.from(v);
    if (b.length < 32 || !b.subarray(0, 32).equals(NAME)) {
      if (b.length >= 32 && b.indexOf(NAME) > 0) throw new Error('settleChip name not at offset 0: unknown framing, refusing to guess');
      continue;
    }
    out.push(restoreEventValue(b, SETTLE_CHIP_EVENT).bytes);
  }
  return out;
}

export function decodeSettleChipEvent(full) {
  if (full.length !== 288) throw new Error(`settleChip must be 288 bytes, got ${full.length}`);
  const w = payloadWords(full).map((x) => Buffer.from(x));
  return {
    sessionId: w[0], chipPubkey: w[1], chipSig: Buffer.concat([w[2], w[3]]), chipHwId: w[4],
    sessionUwh: le(w[5]), uptimeMs: le(w[6]), nonce: le(w[7]),
  };
}

/** The exact 288-byte event the contract emits for these fields (round-trip checks). */
export function encodeSettleChipEvent(ev) {
  return Buffer.concat([NAME, Buffer.from(ev.sessionId), Buffer.from(ev.chipPubkey), Buffer.from(ev.chipSig),
    Buffer.from(ev.chipHwId), le32(ev.sessionUwh), le32(ev.uptimeMs), le32(ev.nonce)]);
}

export function attestDigest(ev) {
  const hw = Buffer.from(ev.chipHwId);
  const pre = Buffer.concat([Buffer.from('pollpower:hat:attest:v1', 'utf8'), hw.subarray(0, 8), hw.subarray(8, 12),
    Buffer.from(ev.sessionId).subarray(0, 16), be(ev.sessionUwh, 8), be(ev.uptimeMs, 8), be(ev.nonce, 8)]);
  return crypto.createHash('sha512').update(pre).digest();
}

/**
 * @param ev decoded event; @param chip the on-chain ChipRecord for ev.chipPubkey (or null)
 * @param opts.amount the settle's minted amount, if known (from the tx / settle log)
 * @returns { ok, problems: string[] }
 */
export function verifySettleChipEvent(ev, chip, opts = {}) {
  const problems = [];
  if (!chip) return { ok: false, problems: ['chip_not_registered'] };
  if (!chip.active) problems.push('chip_revoked');
  if (!same(chip.hwId, ev.chipHwId)) problems.push('hw_id_mismatch');
  let sigOk = false;
  try { sigOk = ed25519.verify(ev.chipSig, attestDigest(ev), ev.chipPubkey); } catch { sigOk = false; }
  if (!sigOk) problems.push('bad_chip_signature');
  if (opts.amount !== undefined && BigInt(opts.amount) !== ev.sessionUwh / 1000n) problems.push('amount_mismatch');
  return { ok: problems.length === 0, problems };
}
