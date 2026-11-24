// Record a statutory-lane KES remittance (ops). Verifies the existing log
// (hash chain + every anchor) BEFORE appending, appends, then anchors the new
// head in the ops log and the council Telegram group.
//
//   node tooling/tariff/remit.mjs verify
//   node tooling/tariff/remit.mjs record --lane <id> --authority <name> --ebt <n> --kes <n> \
//        --ref <receipt/M-Pesa/bank ref> --covers <last settle event id> --by <who>
//
// Env: REMITTANCE_LOG, REMITTANCE_OPS_LOG (both required; the ops log is
// ~/pollpower-ops/ops.log on kenya, backed up nightly to md0 by Joi; keep both outside the
// repo and backed up), WATCHER_TELEGRAM_TOKEN_FILE + WATCHER_TELEGRAM_CHAT_ID
// (the council group; optional until the bot exists, then expected).
import { createRemittanceLog, anchorHead, readAnchors, checkAnchors } from './lane-remittance.mjs';
import { readSecretFile } from '../watcher/alert-channels.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (/** @type {string} */ k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const need = (/** @type {string} */ k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };

try {
  const log = createRemittanceLog(need('REMITTANCE_LOG'));
  const opsLog = need('REMITTANCE_OPS_LOG');
  const records = log.records();
  checkAnchors(records, readAnchors(opsLog));
  if (cmd === 'verify') {
    console.log(`[remit] log OK: ${records.length} record(s), chain intact, all ${readAnchors(opsLog).length} anchor(s) match; head ${records.at(-1)?.hash ?? '(empty)'}`);
  } else if (cmd === 'record') {
    const rec = log.append({
      lane: arg('--lane'), authority: arg('--authority'), ebtAmount: arg('--ebt'), kesAmount: arg('--kes'),
      reference: arg('--ref'), coversThroughEventId: Number(arg('--covers')), recordedBy: arg('--by'),
    });
    const telegram = process.env.WATCHER_TELEGRAM_TOKEN_FILE
      ? { token: readSecretFile(process.env.WATCHER_TELEGRAM_TOKEN_FILE, 'Telegram bot token'), chatId: need('WATCHER_TELEGRAM_CHAT_ID') }
      : undefined;
    const a = await anchorHead(rec, { opsLogFile: opsLog, telegram });
    console.log(`[remit] recorded #${rec.seq} (${rec.ebtAmount} EBT / KES ${rec.kesAmount}, ref ${rec.reference}); head ${rec.hash}`);
    console.log(`[remit] anchor: ops log ${a.opsLog}; Telegram ${a.telegram}`);
    if (a.telegram !== 'sent') console.warn('[remit] post the head hash above to the council group by hand');
  } else {
    throw new Error('usage: remit.mjs verify | record --lane --authority --ebt --kes --ref --covers --by');
  }
} catch (e) {
  console.error(`[remit] ${String(/** @type {any} */ (e)?.message ?? e)}`);
  process.exit(1);
}
