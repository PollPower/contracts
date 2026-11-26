// @ts-check
// Read-only check of one council action, from the indexer (no wallet, no
// transaction): the pending file council-approve.mjs wrote, against the chain.
//
//   node tooling/council/council-action-check.mjs --pending <pending.json>
//        [--expect executed|approved|pending] [--record <ceremony record>]
//        [--council-keys <council-keys.json>] [--inputs <inputs.json> --g16 <params>]
//
// Checks: the pending file's addresses equal the ceremony record; the council's
// slots equal the council file (when given), its epoch and threshold; how many
// slots approved the action hash (never which: the count only); whether the
// target contract consumed it (runs once); the action's own read-back (e.g.
// EBT binds the LD; the TR has the charter root); every contract involved is
// still finalized. --expect (default executed) sets what must hold for exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, buildDir, loadModule, liveState } from '../deploy/network.mjs';
import { checkFinalized } from '../deploy/finalize.mjs';
import { slotsFromLedger, assertSlotsMatchFile } from './council-approval-lib.mjs';
import { approvalKeyOf, reader, actionKeyOf } from './council-approve.mjs';
import { actionOf } from './council-actions.mjs';
import { hexToBytes } from '../tangem/ring-signature.mjs';
import { loadG16 } from '../g16/g16-context.mjs';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

const BUILD_OF = /** @type {Record<string, string>} */ ({ council: 'multisig-v8', tr: 'tariff-registry-v1', ebt: 'ebt-v8', ld: 'living-dividend-v3' });

/**
 * @param {{ p: any, rec: any, ledger: (b: string, a: string) => Promise<any>, finalized: (b: string, a: string) => Promise<boolean>,
 *   councilFile?: any, ctx: any, expect?: 'executed' | 'approved' | 'pending' }} o
 * @returns {Promise<{ ok: boolean, lines: [boolean | null, string][] }>}
 */
export async function checkCouncilAction({ p, rec, ledger, finalized, councilFile, ctx, expect = 'executed' }) {
  /** @type {[boolean | null, string][]} */
  const lines = [];
  const name = actionKeyOf(p);
  const action = actionOf(name);
  lines.push([null, `action ${name}: ${action.label}`]);
  const involved = ['council', action.target.key, ...(name === 'ld-bind' ? ['ld'] : [])];
  lines.push([involved.every((k) => String(p[k] ?? '').toLowerCase() === String(rec[k] ?? '').toLowerCase()), `pending file addresses = ceremony record (${involved.join(', ')})`]);
  const msL = await ledger('multisig-v8', p.council);
  const slots = slotsFromLedger(msL);
  if (councilFile) {
    let same = true;
    try { assertSlotsMatchFile(slots, councilFile.council); } catch { same = false; }
    lines.push([same, 'council slots = council file']);
  }
  const epoch = BigInt(msL._epoch), threshold = Number(msL._threshold);
  lines.push([epoch === BigInt(p.epoch), `council epoch ${epoch} (prepared at ${p.epoch}), threshold ${threshold}`]);
  const key = approvalKeyOf(hexToBytes(p.actionHash), epoch);
  const n = msL._approvals.member(key) ? slots.filter((s) => msL._approvals.lookup(key).member(BigInt(s.slot))).length : 0;
  const tL = await ledger(action.target.build, p[action.target.key]);
  const consumed = tL[action.target.consumed].member(hexToBytes(p.actionHash));
  if (expect === 'pending') {
    lines.push([!consumed, `not executed yet (${n} of ${slots.length} approvals)`]);
  } else {
    lines.push([n >= threshold, `approvals recorded: ${n} of ${slots.length} (threshold ${threshold})`]);
    lines.push([expect === 'executed' ? consumed : !consumed, expect === 'executed' ? `${action.target.key.toUpperCase()} consumed the action ${p.actionHash} (runs once)` : 'not executed yet']);
  }
  if (expect === 'executed') for (const [ok, msg] of await action.verify(ctx, p)) lines.push([ok, msg]);
  for (const k of involved.filter((k) => k !== 'council').concat('council')) lines.push([await finalized(BUILD_OF[k], p[k]), `${k} still finalized`]);
  return { ok: lines.every(([ok]) => ok !== false), lines };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const expect = /** @type {any} */ (arg('--expect') ?? 'executed');
  if (!['executed', 'approved', 'pending'].includes(expect)) throw new Error('--expect must be executed, approved or pending');
  const pf = arg('--pending');
  if (!pf) throw new Error('--pending <pending.json> is required');
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const { loadNetworkConfig, describeNetwork } = await import('../midnight-network.mjs');
  const net = loadNetworkConfig();
  if (p.network !== net.networkId) throw new Error(`the pending file is for ${p.network}, this is ${net.networkId}`);
  const recFile = path.resolve(String(arg('--record') ?? path.join(ROOT, 'build', 'preprod', 'ceremony-record.json')));
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  const inputs = arg('--inputs') ? JSON.parse(fs.readFileSync(String(arg('--inputs')), 'utf8')) : null;
  const g16 = arg('--g16') ? loadG16(String(arg('--g16')), inputs) : null;
  const rd = reader(net);
  const pdp = indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS });
  const dn = { providersFor: () => ({ publicDataProvider: pdp }) };
  const finalized = async (/** @type {string} */ b, /** @type {string} */ a) => { const st = await liveState(dn, b, a); return !!st && checkFinalized(st, buildDir(b)).ok; };
  const councilFile = arg('--council-keys') ? JSON.parse(fs.readFileSync(String(arg('--council-keys')), 'utf8')) : undefined;
  console.log(`[check] ${describeNetwork(net)}; record ${recFile}`);
  const r = await checkCouncilAction({ p, rec, ledger: rd.ledger, finalized, councilFile, ctx: { inputs, g16, ledger: rd.ledger, module: loadModule }, expect });
  for (const [ok, msg] of r.lines) console.log(`${ok === null ? '    ' : ok ? 'OK  ' : 'FAIL'} ${msg}`);
  console.log(r.ok ? `[check] ${expect.toUpperCase()}: all checks pass` : '[check] FAILED');
  if (!r.ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => process.exit(0), (e) => { console.error(`[check] ${String(e?.message ?? e)}`); process.exit(1); });
}
