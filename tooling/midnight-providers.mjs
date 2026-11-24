// @ts-check
// Wallet + Midnight.js providers for PollPower tooling, on the ledger 9 set
// (Midnight.js 5.0.1, wallet SDK 2.0.1). Replaces the ledger 8 wiring that was
// copied into tariff-registry/deploy/deploy-utils.{ts,mjs} and each
// ebt/settle-flow script.
//
// Endpoints come from ./midnight-network.mjs (environment only). The wallet
// seed and the private-state password are passed in by the caller at run time;
// this module never stores or logs them.
//
// All protocol packages resolve from the repo-root node_modules (npm
// workspaces + overrides), so the contract modules, the framework and the
// wallet share one copy of each WASM package.

import WebSocket from 'ws';
import * as Rx from 'rxjs';
import {
  DustWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  PublicKey,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
  WalletSeeds,
  createKeystore,
} from '@midnightntwrk/wallet-sdk';
import { createLedger9MidnightProvider, createLedger9WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

// The wallet SDK's indexer client opens GraphQL subscriptions through the
// global WebSocket in Node.js.
// @ts-expect-error ws is API-compatible with the browser WebSocket for this use
globalThis.WebSocket ??= WebSocket;

/** @typedef {import('./midnight-network.mjs').MidnightNetwork} MidnightNetwork */

/** @param {string} hex @param {string} what */
function hexBytes(hex, what) {
  const clean = hex.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) throw new Error(`${what} must be hex`);
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/**
 * Starts a wallet facade from a master seed (hex), derived with
 * WalletSeeds.fromMasterSeed (account 0, index 0), and waits for nothing: call
 * `waitForSync` before building transactions.
 * @param {string} masterSeedHex
 * @param {MidnightNetwork} net
 */
export async function createWallet(masterSeedHex, net) {
  const configuration = WalletFacade.resolveConfiguration({
    networkId: net.networkId,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(net.nodeWS),
    provers: { v9: { kind: 'server', url: new URL(net.proofServer) } },
    indexerClientConnection: { indexerHttpUrl: net.indexer, indexerWsUrl: net.indexerWS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  });
  const seeds = WalletSeeds.fromMasterSeed(hexBytes(masterSeedHex, 'wallet seed'));
  const unshieldedKeystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, configuration.networkId);
  const wallet = await WalletFacade.init({
    configuration,
    shielded: (config) => ShieldedWallet(config).startWithSeed(seeds.shielded),
    unshielded: (config) => UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config) => DustWallet(config).startWithSeed(seeds.dust),
  });
  await wallet.start(seeds);
  return { wallet, unshieldedKeystore };
}

/** @param {Awaited<ReturnType<typeof createWallet>>} ctx */
export function waitForSync(ctx) {
  return Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
}

/**
 * Builds the Midnight.js 5 provider set for one contract build directory.
 * @param {Awaited<ReturnType<typeof createWallet>>} ctx
 * @param {MidnightNetwork} net
 * @param {{ zkConfigDir: string, privateStateStoreName: string, privateStatePassword: string }} opts
 */
export async function createProviders(ctx, net, opts) {
  if (!opts.privateStatePassword) throw new Error('privateStatePassword is required (MIDNIGHT_PRIVATE_STATE_PASSWORD)');
  const state = await waitForSync(ctx);
  const coinPublicKey = state.shielded.coinPublicKey.toHexString();
  const encryptionPublicKey = state.shielded.encryptionPublicKey.toHexString();

  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,
    async balanceTx(tx, ttl) {
      const handle = ctx.wallet.adoptTransaction(tx.serialize(), 'Unbound');
      const recipe = await ctx.wallet.balanceUnboundTransaction(handle, {
        ttl: ttl ?? new Date(Date.now() + net.ttlSeconds * 1000),
      });
      const signed = await ctx.wallet.signRecipe(recipe, ctx.unshieldedKeystore.signDataAsync);
      return ctx.wallet.finalizeRecipe(signed);
    },
  });
  const midnightProvider = createLedger9MidnightProvider(async (tx) =>
    ctx.wallet.submitTransaction(ctx.wallet.adoptTransaction(tx.serialize(), 'Finalized')),
  );

  const zkConfigProvider = new NodeZkConfigProvider(opts.zkConfigDir);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: opts.privateStateStoreName,
      privateStoragePasswordProvider: () => opts.privateStatePassword,
      accountId: coinPublicKey,
    }),
    // Subscriptions use globalThis.WebSocket (set above), as the Midnight.js
    // docs prescribe for Node.js.
    publicDataProvider: indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS }),
    zkConfigProvider,
    proofProvider: httpClientProofProvider({ url: net.proofServer, zkConfigProvider }),
    walletProvider,
    midnightProvider,
    config: { networkId: net.networkId, ttlSeconds: net.ttlSeconds },
  };
}

/**
 * Same providers, re-rooted at another contract build directory.
 * @template {{ zkConfigProvider: unknown, proofProvider: unknown }} P
 * @param {P} providers
 * @param {MidnightNetwork} net
 * @param {string} zkConfigDir
 * @returns {P}
 */
export function withZkConfigDir(providers, net, zkConfigDir) {
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigDir);
  return { ...providers, zkConfigProvider, proofProvider: httpClientProofProvider({ url: net.proofServer, zkConfigProvider }) };
}
