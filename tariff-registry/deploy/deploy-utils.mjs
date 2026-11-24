// =============================================================================
// PollPower Tariff-Registry — deploy utils (ledger 9 / Midnight.js 5 adapter)
// =============================================================================
// WI-16: the ledger 8 wiring that lived here (hardcoded Preview endpoints,
// HDWallet key derivation, wallet SDK 1.x, a password in source) is replaced by
// the shared modules in ../../tooling. This file keeps the old export names so
// the ceremony, populate and rollout scripts keep importing it unchanged.
//
// Environment (see ../../.env.example):
//   MIDNIGHT_NETWORK_ID, MIDNIGHT_INDEXER_URL, MIDNIGHT_NODE_URL   (required)
//   MIDNIGHT_INDEXER_WS_URL, MIDNIGHT_NODE_WS_URL, MIDNIGHT_PROOF_SERVER_URL,
//   MIDNIGHT_TX_TTL_SECONDS                                          (optional)
//   MIDNIGHT_PRIVATE_STATE_PASSWORD                                  (required for providers)
// =============================================================================
import { loadNetworkConfig, describeNetwork } from '../../tooling/midnight-network.mjs';
import * as shared from '../../tooling/midnight-providers.mjs';

const PRIVATE_STATE_STORE = 'tariff-registry-state';

let cached;
/** The network configuration, read from the environment once. */
export function network() {
  cached ??= loadNetworkConfig();
  return cached;
}

/** @param {string} seedHex master wallet seed (hex), supplied at run time */
export async function createWallet(seedHex) {
  const net = network();
  console.log(`[deploy-utils] ${describeNetwork(net)}`);
  return shared.createWallet(seedHex, net);
}

/**
 * @param {Awaited<ReturnType<typeof createWallet>>} walletCtx
 * @param {string} zkConfigDir contract build directory (keys/, zkir/, compiler/)
 */
export async function createProviders(walletCtx, zkConfigDir) {
  if (!zkConfigDir) throw new Error('createProviders: zkConfigDir is required');
  return shared.createProviders(walletCtx, network(), {
    zkConfigDir,
    privateStateStoreName: PRIVATE_STATE_STORE,
    privateStatePassword: process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? '',
  });
}

/** Same providers, re-rooted at another build directory. */
export function withZkConfigDir(providers, zkConfigDir) {
  return shared.withZkConfigDir(providers, network(), zkConfigDir);
}

export const waitForSync = shared.waitForSync;
