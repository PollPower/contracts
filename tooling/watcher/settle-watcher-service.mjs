// @ts-check
// Settle watcher service: polls EBT's events from the indexer and runs the
// watcher loop (tooling/watcher/settle-watcher-loop.mjs) against EBT's live
// chip registry. Alerts go to every council member's sink.
//
// Env: MIDNIGHT_* (network), EBT_ADDRESS, EBT_BUILD_DIR, WATCHER_STATE_FILE,
// WATCHER_SINKS = JSON [{ "member": "garrett", "url": "https://...", "tokenEnv": "WATCHER_TOKEN_GARRETT" }],
// WATCHER_INTERVAL_MS (default 60000). Needs no wallet: it only reads.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { getAllContractEvents } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createWatcher, webhookSink } from './settle-watcher-loop.mjs';

/** @type {any} */ (globalThis).WebSocket ??= WebSocket;

/**
 * One watcher bound to an EBT through a public data provider.
 * @param {{ publicDataProvider: any, ebtBuildDir: string, ebtAddress: string, sinks: any[], stateFile: string, log?: any }} o
 */
export async function createSettleWatcherService({ publicDataProvider, ebtBuildDir, ebtAddress, sinks, stateFile, log = console }) {
  const mod = await import(pathToFileURL(path.join(ebtBuildDir, 'contract', 'index.js')).href);
  const ledger = async () => {
    const read = await publicDataProvider.queryContractState(ebtAddress);
    if (!read) throw new Error(`EBT ${ebtAddress}: no state from the indexer`);
    return mod.ledger(read.contractState.deserialize({ v9: ContractState }).data);
  };
  const watcher = createWatcher({
    chipLookup: async (pk) => { const L = await ledger(); return L._chips.member(pk) ? L._chips.lookup(pk) : null; },
    sinks, stateFile, log,
  });
  return {
    watcher,
    /** One pass: retry undelivered alerts, then check every new event. */
    async pass() {
      await watcher.retryPending();
      const events = [];
      for await (const e of getAllContractEvents(publicDataProvider, { contractAddress: ebtAddress, types: ['Misc'] })) events.push(e);
      return watcher.process(events);
    },
  };
}

async function main() {
  const env = process.env;
  const need = (/** @type {string} */ k) => { const v = env[k]; if (!v) throw new Error(`${k} is required`); return v; };
  const net = loadNetworkConfig(env);
  const sinks = JSON.parse(need('WATCHER_SINKS')).map((/** @type {any} */ s) => webhookSink(s.member, s.url, s.tokenEnv ? env[s.tokenEnv] : undefined));
  if (sinks.length < 3) console.warn(`[watcher] only ${sinks.length} council sink(s) configured; the runbook needs all council members`);
  const svc = await createSettleWatcherService({
    publicDataProvider: indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS }),
    ebtBuildDir: need('EBT_BUILD_DIR'), ebtAddress: need('EBT_ADDRESS'), sinks, stateFile: need('WATCHER_STATE_FILE'),
  });
  console.log(`[watcher] ${describeNetwork(net)}; EBT ${env.EBT_ADDRESS}; ${sinks.length} council sinks`);
  const interval = Number(env.WATCHER_INTERVAL_MS ?? 60_000);
  for (;;) {
    try {
      const r = await svc.pass();
      if (r.checked) console.log(`[watcher] checked ${r.checked} settle(s), ${r.alerts} alert(s)`);
    } catch (e) { console.error(`[watcher] pass failed: ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)}`); }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1]?.endsWith('settle-watcher-service.mjs')) {
  main().catch((e) => { console.error(`[watcher] fatal: ${String(e?.message ?? e)}`); process.exit(1); });
}
