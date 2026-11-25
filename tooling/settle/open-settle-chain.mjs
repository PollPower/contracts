// @ts-check
// Entry point pp-settle-service loads (EBT_CHAIN_MODULE) where the contracts
// checkout lives (the node host). Builds the fee-paying wallet + Midnight.js providers
// from env and returns the EBT settle chain adapter. The wallet seed is passed
// in by the caller (from its own env) and never logged.
//
// Registry gate (fix #5): the adapter refuses to open without the
// TariffRegistry (TARIFF_REGISTRY_ADDRESS, TARIFF_REGISTRY_BUILD_DIR, or the
// registryAddress / registryBuildDir arguments). The providers resolve the
// registry's module and ZK keys, so EBT's syncRegistryRoot (a cross-contract
// call) can be proven here.
import { WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { serialProofProvider } from '../proving/serial-proof-provider.mjs';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createWallet, createProviders } from '../midnight-providers.mjs';
import { createEbtSettleChain } from './ebt-settle-chain.mjs';

/** @type {any} */ (globalThis).WebSocket ??= WebSocket;

/**
 * @param {{ walletSeedHex: string, ebtBuildDir: string, ebtAddress: string, registryAddress?: string, registryBuildDir?: string,
 *           env?: NodeJS.ProcessEnv, log?: any }} o
 */
export async function openEbtSettleChain({
  walletSeedHex, ebtBuildDir, ebtAddress, env = process.env, log = console,
  registryAddress = env.TARIFF_REGISTRY_ADDRESS ?? '', registryBuildDir = env.TARIFF_REGISTRY_BUILD_DIR ?? '',
}) {
  if (!registryAddress || !registryBuildDir) {
    throw new Error('REGISTRY_GATE_REQUIRED: set TARIFF_REGISTRY_ADDRESS and TARIFF_REGISTRY_BUILD_DIR for the settle adapter');
  }
  const net = loadNetworkConfig(env);
  log.log(`[settle-chain] ${describeNetwork(net)}; EBT ${ebtAddress}; TariffRegistry ${registryAddress}`);
  const ctx = await createWallet(walletSeedHex, net);
  const providers = await createProviders(ctx, net, {
    zkConfigDir: ebtBuildDir,
    privateStateStoreName: env.SETTLE_PRIVATE_STATE_STORE ?? 'pp-settle-service',
    privateStatePassword: env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? '',
  });
  // Cross-contract: EBT.syncRegistryRoot calls the TariffRegistry's actionLogAnchor.
  const trAddr = String(registryAddress).replace(/^0x/, '').toLowerCase();
  const contractModuleProvider = {
    resolve: (/** @type {string} */ a) => (String(a).replace(/^0x/, '').toLowerCase() === trAddr
      ? () => import(pathToFileURL(path.join(registryBuildDir, 'contract', 'index.js')).href) : undefined),
  };
  const zk = new ZKConfigRegistry([providers.zkConfigProvider, new NodeZkConfigProvider(registryBuildDir)]);
  const gated = { ...providers, contractModuleProvider, proofProvider: serialProofProvider({ url: net.proofServer, zkConfigProvider: zk }) };
  return createEbtSettleChain({ providers: gated, ebtBuildDir, ebtAddress, registryAddress, registryBuildDir, log });
}
