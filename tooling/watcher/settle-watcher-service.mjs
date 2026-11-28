// @ts-check
// Settle watcher service: polls EBT's events from the indexer and runs the
// watcher loop (tooling/watcher/settle-watcher-loop.mjs) against EBT's live
// chip registry. Alerts go to the council's Telegram group AND to each council
// member by email, each channel delivered and retried on its own
// (tooling/watcher/alert-channels.mjs). Needs no wallet: it only reads.
//
// Env: MIDNIGHT_* (network), EBT_ADDRESS, EBT_BUILD_DIR, WATCHER_STATE_FILE,
// WATCHER_INTERVAL_MS (default 60000), the channel settings in
// alert-channels.mjs, and optionally WATCHER_SINKS (extra webhooks:
// [{ "member": "...", "url": "https://...", "tokenEnv": "..." }]).
//
//   node tooling/watcher/settle-watcher-service.mjs                # run
//   node tooling/watcher/settle-watcher-service.mjs --test-alert   # send one TEST alert on every channel, then exit
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { getAllContractEvents } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createWatcher, webhookSink } from './settle-watcher-loop.mjs';
import { channelsFromEnv } from './alert-channels.mjs';

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
  const { default: nodemailer } = await import('nodemailer');
  const context = { network: net.networkId, ebtAddress: need('EBT_ADDRESS') };
  const sinks = [
    ...channelsFromEnv(env, { createTransport: (o) => nodemailer.createTransport(o), context }),
    ...(env.WATCHER_SINKS ? JSON.parse(env.WATCHER_SINKS).map((/** @type {any} */ s) => webhookSink(s.member, s.url, s.tokenEnv ? env[s.tokenEnv] : undefined)) : []),
  ];
  if (process.argv.includes('--test-alert')) {
    const alert = {
      kind: 'settle-watcher-alert', eventId: 0, txId: null, problems: ['TEST_ALERT_ignore'], chipPubkey: null, sessionId: null,
      action: 'TEST ONLY: checking the watcher alert channels. No action needed.', at: new Date().toISOString(),
    };
    let failed = 0;
    for (const s of sinks) {
      try { await s.send(alert); console.log(`[watcher] test alert -> ${s.member}: delivered`); } catch (e) { failed++; console.error(`[watcher] test alert -> ${s.member}: FAILED ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)}`); }
    }
    process.exit(failed ? 1 : 0);
  }
  const svc = await createSettleWatcherService({
    publicDataProvider: indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS }),
    ebtBuildDir: need('EBT_BUILD_DIR'), ebtAddress: context.ebtAddress, sinks, stateFile: need('WATCHER_STATE_FILE'),
  });
  console.log(`[watcher] ${describeNetwork(net)}; EBT ${context.ebtAddress}; channels: ${sinks.map((s) => s.member).join(', ')}`);
  const interval = Number(env.WATCHER_INTERVAL_MS ?? 60_000);
  for (;;) {
    try {
      const r = await svc.pass();
      if (r.checked) console.log(`[watcher] checked ${r.checked} settle(s), ${r.alerts} alert(s)`);
      const pending = svc.watcher.state().pendingAlerts.length;
      if (pending) console.warn(`[watcher] ${pending} alert(s) not yet delivered on every channel; retrying next pass`);
    } catch (e) { console.error(`[watcher] pass failed: ${String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)}`); }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1]?.endsWith('settle-watcher-service.mjs')) {
  main().catch((e) => { console.error(`[watcher] fatal: ${String(e?.message ?? e)}`); process.exit(1); });
}
