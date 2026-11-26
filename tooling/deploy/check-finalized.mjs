// @ts-check
// Read-only: checkFinalized for deployed contracts (every audited verifier key
// present and identical, nothing extra, maintenance authority locked), straight
// from the indexer. No wallet, no transaction.
//
//   node tooling/deploy/check-finalized.mjs [ebt ld ...] [--record <ceremony record>]
//
// Default record: build/preprod/ceremony-record.json; default contracts: all
// four (council tr ebt ld). Exit 0 only if every one passes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ROOT, buildDir, liveState } from './network.mjs';
import { checkFinalized } from './finalize.mjs';

export const BUILDS = { council: 'multisig-v8', tr: 'tariff-registry-v1', ebt: 'ebt-v8', ld: 'living-dividend-v3' };

/** @returns {{ key: string, build: string, address: string }[]} */
export function targets(/** @type {any} */ rec, /** @type {string[]} */ keys) {
  const want = keys.length ? keys : Object.keys(BUILDS);
  return want.map((key) => {
    const build = /** @type {Record<string, string>} */ (BUILDS)[key];
    if (!build) throw new Error(`unknown contract "${key}" (one of ${Object.keys(BUILDS).join(', ')})`);
    if (!rec[key]) throw new Error(`${key} is not in the record (not deployed yet?)`);
    return { key, build, address: String(rec[key]) };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--record');
  const recFile = path.resolve(i >= 0 ? String(argv[i + 1]) : path.join(ROOT, 'build', 'preprod', 'ceremony-record.json'));
  const keys = argv.filter((a, j) => !a.startsWith('--') && !(i >= 0 && j === i + 1));
  const { loadNetworkConfig, describeNetwork } = await import('../midnight-network.mjs');
  const net = loadNetworkConfig();
  console.log(`[check] ${describeNetwork(net)}; record ${recFile}`);
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  const pdp = indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS });
  const dn = { providersFor: () => ({ publicDataProvider: pdp }) };
  let ok = true;
  for (const t of targets(rec, keys)) {
    const st = await liveState(dn, t.build, t.address);
    if (!st) { ok = false; console.log(`[check] ${t.key} ${t.address}: NO STATE from the indexer`); continue; }
    const r = checkFinalized(st, buildDir(t.build));
    ok &&= r.ok;
    console.log(`[check] ${t.key} (${t.build}) ${t.address}: ${r.ok ? 'FINALIZED (all audited verifier keys, authority locked)' : `NOT FINALIZED: ${r.problems.join(', ')}`}`);
  }
  if (!ok) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => process.exit(0), (e) => { console.error(`[check] ${String(e?.message ?? e)}`); process.exit(1); });
}
