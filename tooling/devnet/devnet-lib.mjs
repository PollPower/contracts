// @ts-check
// WI-16: the local-devnet side of the deploy plumbing. LOCAL DEVNET ONLY
// (MIDNIGHT_NETWORK_ID=undeployed): openDevnet asserts it and uses the devnet
// genesis wallet. Everything network-agnostic lives in tooling/deploy/network.mjs
// and is shared, unchanged, with the Preprod ceremony.
//
// Endpoints come from the environment (tooling/midnight-network.mjs). Through
// the SSH tunnel to the node host's devnet:
//   MIDNIGHT_NETWORK_ID=undeployed
//   MIDNIGHT_NODE_URL=http://127.0.0.1:19944
//   MIDNIGHT_INDEXER_URL=http://127.0.0.1:18088/api/v4/graphql
//   MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:16300
import fs from 'node:fs';
import path from 'node:path';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { devnetMasterWallet, assertLocalDevnet } from './devnet-wallet.mjs';
import { ROOT, BUILD, buildDir, loadModule, compiled, openNetwork, deploy, join, liveState, finalizeContract } from '../deploy/network.mjs';

export { ROOT, BUILD, buildDir, loadModule, compiled, deploy, join, liveState, finalizeContract };

const DEVNET_DIR = path.join(ROOT, 'build', 'devnet');
// DEVNET_STATE_FILE: a separate run (e.g. the recorded demo) keeps its own state
// next to the pass state, never in it.
const STATE_FILE = (() => {
  const f = process.env.DEVNET_STATE_FILE ? path.resolve(ROOT, process.env.DEVNET_STATE_FILE) : path.join(DEVNET_DIR, 'state.json');
  if (path.dirname(f) !== DEVNET_DIR) throw new Error(`DEVNET_STATE_FILE must be a file directly in ${DEVNET_DIR}`);
  return f;
})();

/** Run state (addresses, keys' public parts, progress) for one devnet pass. */
export const state = {
  exists() { return fs.existsSync(STATE_FILE); },
  load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } },
  save(/** @type {any} */ s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2));
  },
  file: STATE_FILE,
  isDefault: STATE_FILE === path.join(DEVNET_DIR, 'state.json'),
};

export async function openDevnet() {
  const net = loadNetworkConfig();
  assertLocalDevnet(net);
  console.log(`[devnet] ${describeNetwork(net)}`);
  const ctx = await devnetMasterWallet(net);
  return openNetwork({
    net, ctx, storeName: 'wi16-devnet-stack',
    password: process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? 'Local-Devnet-Only-1',   // local devnet only
  });
}
