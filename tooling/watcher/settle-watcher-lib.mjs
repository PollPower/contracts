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
// Event payload (8 x 32 bytes, see EBT settle): sessionID, chipPubkey,
// chipSigR, chipSigS, chipHwId, chipSessionUwh, chipUptimeMs, chipNonce
// (integers little-endian). Chip pre-image (firmware pp_attest.h):
//   "pollpower:hat:attest:v1" || ieee(8) || userid(4 BE) || sessionID[0..16]
//   || uwh(8 BE) || uptime_ms(8 BE) || nonce(8 BE), signed as SHA-512 digest.
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

export const SETTLE_CHIP_EVENT = 'pp:ebt:v9:settleChip';
const NAME = (() => { const b = Buffer.alloc(32); b.write(SETTLE_CHIP_EVENT, 'utf8'); return b; })();
const le = (b) => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };
const be = (x, n) => { const b = Buffer.alloc(n); let v = BigInt(x); for (let i = n - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** Finds settleChip name+payload blocks (288 bytes) in event byte strings:
 *  local runtime events (name || payload) or indexer `raw` VersionedLogItem bytes. */
export function findSettleChipEvents(byteStrings) {
  const out = [];
  for (const raw of byteStrings) {
    const b = Buffer.from(raw);
    // The runtime's value encoding drops trailing zero bytes (a 288-byte event
    // can arrive shorter), so zero-pad each block back to 288 bytes.
    for (let i = b.indexOf(NAME); i >= 0; i = b.indexOf(NAME, i + 1)) {
      const block = Buffer.alloc(288);
      b.copy(block, 0, i, Math.min(i + 288, b.length));
      out.push(block);
    }
  }
  return out;
}

export function decodeSettleChipEvent(block) {
  const w = (i) => Buffer.from(block.subarray(32 + 32 * i, 64 + 32 * i));
  return {
    sessionId: w(0), chipPubkey: w(1), chipSig: Buffer.concat([w(2), w(3)]), chipHwId: w(4),
    sessionUwh: le(w(5)), uptimeMs: le(w(6)), nonce: le(w(7)),
  };
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
