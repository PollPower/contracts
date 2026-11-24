// @ts-check
// Settle watcher loop (runbook: docs/runbooks/hat-settle-watcher.md).
//
// Every EBT settleChip event read from the indexer is restored to its exact
// layout, decoded, and re-verified against the chip's ON-CHAIN record (EBT
// _chips): registered, active, hardware id, Ed25519 signature over the chip's
// native attestation. Any problem alerts EVERY council member at once
// (revocation is 2-of-3; there is no single-member suspend). Per member,
// delivery is independent: an endpoint that is down does not block the others,
// and its alert is kept and retried. State (last event id, undelivered alerts)
// survives restarts; an event is never alerted twice.
import fs from 'node:fs';
import path from 'node:path';
import { restoreIndexerMiscEvent } from '../events/event-codec.mjs';
import { SETTLE_CHIP_EVENT, decodeSettleChipEvent, verifySettleChipEvent } from './settle-watcher-lib.mjs';

/**
 * @param {{
 *   chipLookup: (chipPubkey: Uint8Array) => Promise<any>,
 *   sinks: { member: string, send: (alert: any) => Promise<void> }[],
 *   stateFile: string,
 *   log?: any,
 * }} o
 */
export function createWatcher({ chipLookup, sinks, stateFile, log = console }) {
  if (!sinks.length) throw new Error('watcher needs at least one council alert sink');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { lastId: -1, pendingAlerts: [] }; }
  };
  const save = (/** @type {any} */ st) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };

  /** Sends `alert` to every member not yet in `alert.deliveredTo`; returns true when all have it. */
  const deliver = async (/** @type {any} */ alert) => {
    for (const s of sinks) {
      if (alert.deliveredTo.includes(s.member)) continue;
      try {
        await s.send({ ...alert, deliveredTo: undefined });
        alert.deliveredTo.push(s.member);
      } catch (e) {
        log.error(`[watcher] alert ${alert.eventId} to ${s.member} failed: ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 120)}`);
      }
    }
    return sinks.every((s) => alert.deliveredTo.includes(s.member));
  };

  return {
    /** Checks events with id > lastId; returns { checked, alerts }. */
    async process(/** @type {any[]} */ events) {
      const st = load();
      let checked = 0; let alerts = 0;
      for (const e of [...events].sort((a, b) => a.id - b.id)) {
        if (e.id <= st.lastId) continue;
        let restored;
        try { restored = restoreIndexerMiscEvent(e); } catch (err) {
          // Only events claiming to be settleChip matter; anything else is skipped.
          const nameHex = String(e.name ?? '');
          if (!Buffer.from(nameHex, 'hex').toString('utf8').startsWith(SETTLE_CHIP_EVENT)) { st.lastId = e.id; continue; }
          restored = { name: SETTLE_CHIP_EVENT, error: String(/** @type {any} */ (err)?.message ?? err) };
        }
        if (restored.name !== SETTLE_CHIP_EVENT) { st.lastId = e.id; continue; }
        checked++;
        let problems; let ev;
        if (restored.error) {
          problems = [`undecodable: ${restored.error}`];
        } else {
          ev = decodeSettleChipEvent(restored.bytes);
          problems = verifySettleChipEvent(ev, await chipLookup(ev.chipPubkey)).problems;
        }
        if (problems.length) {
          alerts++;
          const alert = {
            kind: 'settle-watcher-alert', eventId: e.id, txId: e.transactionId ?? null, problems,
            chipPubkey: ev ? Buffer.from(ev.chipPubkey).toString('hex') : null,
            sessionId: ev ? Buffer.from(ev.sessionId).toString('hex') : null,
            action: 'Council: verify, then 2-of-3 revokeChip for this chip; treat the meter-authority key as suspect if several chips fail (runbook).',
            at: new Date().toISOString(), deliveredTo: /** @type {string[]} */ ([]),
          };
          log.warn(`[watcher] ALERT event ${e.id}: ${problems.join(', ')}`);
          if (!(await deliver(alert))) st.pendingAlerts.push(alert);
        }
        st.lastId = e.id;
        save(st);   // after every event: a crash never re-alerts or skips
      }
      save(st);
      return { checked, alerts };
    },
    /** Retries alerts some member has not received yet. */
    async retryPending() {
      const st = load();
      const left = [];
      for (const a of st.pendingAlerts) if (!(await deliver(a))) left.push(a);
      st.pendingAlerts = left;
      save(st);
      return left.length;
    },
    state: load,
  };
}

/** A council alert sink posting JSON to a member's webhook (Signal bridge, email relay, ...). */
export function webhookSink(/** @type {string} */ member, /** @type {string} */ url, /** @type {string | undefined} */ token) {
  return {
    member,
    async send(/** @type {any} */ alert) {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ member, ...alert }), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  };
}
