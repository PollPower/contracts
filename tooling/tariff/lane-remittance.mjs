// @ts-check
// Statutory lane remittance log and reconciliation (Garrett, 2026-11-25).
//
// On chain, every settle mints the lane's slice to PollPower's statutory
// account (council-approved remit address). Off chain, PollPower pays the
// authority in KES and records each payment here. The log is append-only
// JSONL, fsynced, and hash-chained (each record carries the previous record's
// hash), so any edit, removal or reordering is detected on read.
//
// laneAccrual recomputes what the lane has accrued from the public settle
// events with the contract's own apportionment (largest remainder over the
// class split + lanes); reconcile() reports accrued / remitted / outstanding
// and refuses a log that claims more than accrued.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { slicesFor } from '../settle/settle-plan.mjs';

const GENESIS = '0'.repeat(64);
const FIELDS = ['lane', 'authority', 'ebtAmount', 'kesAmount', 'reference', 'coversThroughEventId', 'recordedBy'];
const canonical = (/** @type {any} */ r) => JSON.stringify(Object.fromEntries([...FIELDS, 'seq', 'at', 'prevHash'].map((k) => [k, r[k]])));
const hashOf = (/** @type {any} */ r) => crypto.createHash('sha256').update(canonical(r)).digest('hex');

export function createRemittanceLog(/** @type {string} */ file) {
  const read = () => {
    if (!fs.existsSync(file)) return [];
    const out = [];
    let prev = GENESIS;
    for (const [i, line] of fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).entries()) {
      let r;
      try { r = JSON.parse(line); } catch { throw new Error(`remittance log tampered: line ${i + 1} is not JSON`); }
      if (r.seq !== i || r.prevHash !== prev || r.hash !== hashOf(r)) throw new Error(`remittance log tampered: hash chain broken at record ${i}`);
      prev = r.hash;
      out.push(r);
    }
    return out;
  };
  return {
    /** Every record, chain-verified. */
    records: read,
    /** Validates and appends one remittance. */
    append(/** @type {any} */ rec) {
      const recs = read();
      const int = (/** @type {string} */ k) => { if (!/^(0|[1-9][0-9]*)$/.test(String(rec[k]))) throw new Error(`${k} must be a non-negative integer string`); };
      int('ebtAmount'); int('kesAmount');
      for (const k of ['lane', 'authority', 'reference', 'recordedBy']) if (!String(rec[k] ?? '').trim()) throw new Error(`${k} is required`);
      if (!Number.isInteger(rec.coversThroughEventId) || rec.coversThroughEventId < 0) throw new Error('coversThroughEventId must be an event id');
      const last = recs.filter((r) => r.lane === rec.lane).at(-1);
      if (last && rec.coversThroughEventId < last.coversThroughEventId) throw new Error(`coversThroughEventId ${rec.coversThroughEventId} is before the last record's ${last.coversThroughEventId}`);
      if (recs.some((r) => r.reference === rec.reference)) throw new Error(`reference ${rec.reference} already recorded`);
      const r = { ...Object.fromEntries(FIELDS.map((k) => [k, rec[k]])), seq: recs.length, at: new Date().toISOString(), prevHash: recs.at(-1)?.hash ?? GENESIS };
      const full = { ...r, hash: hashOf(r) };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'a', 0o600);
      try { fs.writeSync(fd, `${JSON.stringify(full)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return full;
    },
  };
}

/**
 * The lane's accrued slice over settle events { id, amount } (amount = minted,
 * floor(uWh / 1000)), apportioned as settle does: slicesFor(amount,
 * [producer, ops, ld, dao, ...lanes]).
 * @param {{ events: { id: number, amount: bigint }[], bps: { producer: bigint, ops: bigint, ld: bigint, dao: bigint, lanes: bigint[] }, laneIndex: number }} p
 */
export function laneAccrual({ events, bps, laneIndex }) {
  const vec = [bps.producer, bps.ops, bps.ld, bps.dao, ...bps.lanes];
  const byEvent = [...events].sort((a, b) => a.id - b.id).map((e) => ({ id: e.id, lane: slicesFor(BigInt(e.amount), vec)[4 + laneIndex] }));
  return { byEvent, total: byEvent.reduce((s, e) => s + e.lane, 0n), throughEventId: byEvent.at(-1)?.id ?? -1 };
}

/** Accrued vs remitted for one lane; refuses a log claiming more than accrued. */
export function reconcile(/** @type {{ accrued: { total: bigint, throughEventId: number }, records: any[] }} */ { accrued, records }) {
  const remitted = records.reduce((s, r) => s + BigInt(r.ebtAmount), 0n);
  if (remitted > accrued.total) throw new Error(`remittance log claims ${remitted} EBT remitted, more than accrued ${accrued.total}`);
  return { accrued: accrued.total, remitted, outstanding: accrued.total - remitted, throughEventId: accrued.throughEventId };
}
