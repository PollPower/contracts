// Shared configuration for the EBT settle-flow scripts (WI-16, ledger 9).
//
// Before WI-16 each script hardcoded the Preview endpoints, the Preview
// contract addresses (gone since the 2026-11-07 Preview reset), kenya build
// paths and a private-state password. All of that now comes from here.
//
// Environment:
//   MIDNIGHT_NETWORK_ID, MIDNIGHT_INDEXER_URL, MIDNIGHT_NODE_URL, ... (see ../../tooling/midnight-network.mjs)
//   EBT_ADDRESS, REGISTRY_ADDRESS        deployed contract addresses (hex)
//   EBT_BUILD_DIR, REGISTRY_BUILD_DIR    default: <repo>/build/l9/ebt-v8, <repo>/build/l9/tariff-registry-v1
//   OWNER_SEED                           owner wallet master seed, hex (supplied at run time, never stored)
//   MIDNIGHT_PRIVATE_STATE_PASSWORD      level private-state store password
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { loadNetworkConfig, describeNetwork } from '../../tooling/midnight-network.mjs';
import { createWallet, createProviders } from '../../tooling/midnight-providers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const EBT_BUILD = process.env.EBT_BUILD_DIR ?? path.join(REPO, 'build', 'l9', 'ebt-v8');
export const REG_BUILD = process.env.REGISTRY_BUILD_DIR ?? path.join(REPO, 'build', 'l9', 'tariff-registry-v1');

let net;
export function network() {
  if (!net) {
    net = loadNetworkConfig();
    console.log(`[settle-flow] ${describeNetwork(net)}`);
  }
  return net;
}

/** @param {'EBT_ADDRESS' | 'REGISTRY_ADDRESS'} name */
export function contractAddress(name) {
  const v = (process.env[name] ?? '').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be a 64-hex contract address`);
  return v.toLowerCase();
}

export function publicDataProvider() {
  const n = network();
  return indexerPublicDataProvider({ queryURL: n.indexer, subscriptionURL: n.indexerWS });
}

/**
 * Reads a contract's public state and decodes it with this repo's runtime
 * (Midnight.js 5 returns serialized, era-tagged state).
 * @returns {Promise<import('@midnight-ntwrk/compact-runtime').StateValue>} the state's `data`, ready for `ledger()`
 */
export async function readContractData(pdp, address) {
  const read = await pdp.queryContractState(address);
  if (!read) throw new Error(`no contract state at ${address}`);
  return read.contractState.deserialize({ v9: ContractState }).data;
}

/**
 * Owner wallet (OWNER_SEED) + providers rooted at `zkConfigDir`.
 * @param {string} zkConfigDir
 * @param {string} privateStateStoreName
 */
export async function ownerProviders(zkConfigDir, privateStateStoreName) {
  const seedHex = (process.env.OWNER_SEED ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('OWNER_SEED must be 64-hex');
  const n = network();
  const walletCtx = await createWallet(seedHex, n);
  console.log('waiting for owner wallet sync...');
  const providers = await createProviders(walletCtx, n, {
    zkConfigDir,
    privateStateStoreName,
    privateStatePassword: process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? '',
  });
  console.log('owner wallet synced.');
  return { walletCtx, providers };
}
