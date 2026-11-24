// @ts-check
// Entry point pp-settle-service loads (EBT_CHAIN_MODULE) where the contracts
// checkout lives (kenya). Builds the fee-paying wallet + Midnight.js providers
// from env and returns the EBT settle chain adapter. The wallet seed is passed
// in by the caller (from its own env) and never logged.
import { WebSocket } from 'ws';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createWallet, createProviders } from '../midnight-providers.mjs';
import { createEbtSettleChain } from './ebt-settle-chain.mjs';

/** @type {any} */ (globalThis).WebSocket ??= WebSocket;

/**
 * @param {{ walletSeedHex: string, ebtBuildDir: string, ebtAddress: string, env?: NodeJS.ProcessEnv, log?: any }} o
 */
export async function openEbtSettleChain({ walletSeedHex, ebtBuildDir, ebtAddress, env = process.env, log = console }) {
  const net = loadNetworkConfig(env);
  log.log(`[settle-chain] ${describeNetwork(net)}; EBT ${ebtAddress}`);
  const ctx = await createWallet(walletSeedHex, net);
  const providers = await createProviders(ctx, net, {
    zkConfigDir: ebtBuildDir,
    privateStateStoreName: env.SETTLE_PRIVATE_STATE_STORE ?? 'pp-settle-service',
    privateStatePassword: env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? '',
  });
  return createEbtSettleChain({ providers, ebtBuildDir, ebtAddress, log });
}
