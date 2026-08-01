// =============================================================================
// PollPower Tariff-Registry — Local Deploy Utils
// =============================================================================
// Local copy of the subset of /opt/pollpower/settlement-api/src/utils.ts needed
// by deploy-wi15.1.ts. Lives inside tariff-registry so all @midnight-ntwrk/*
// imports resolve within tariff-registry's node_modules realm, avoiding the
// dual-package CostModel _assertClass failure hit on 2026-07-31 when this
// module was loaded from settlement-api's tree.
//
// SCOPE: exports only createWallet, createProviders, withZkConfigDir, deriveKeys.
// Does NOT include the top-level EBTContract/compiledContract block from
// settlement-api's utils.ts — tariff-registry's deploy path builds its own
// compiled contracts per sibling.
//
// Written 2026-07-31 03:5X UTC as part of Option 4 charter-membership-mirror fix.
// =============================================================================

import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';

// Midnight SDK — ALL imports resolve against tariff-registry/node_modules
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// Inlined CONFIG (from settlement-api's src/config.ts, same values)
setNetworkId('preview');
const CONFIG = {
  indexer: 'https://indexer.preview.midnight.network/api/v3/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  privateStateId: 'tariff-registry-state',
};

// WebSocket polyfill for Node.js
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// =============================================================================
// Key Derivation
// =============================================================================

export function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');

  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');

  hdWallet.hdWallet.clear();
  return result.keys;
}

// =============================================================================
// Wallet Creation
// =============================================================================

export async function createWallet(seed: string) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const indexerClientConnection = {
    indexerHttpUrl: CONFIG.indexer,
    indexerWsUrl: CONFIG.indexerWS,
  };

  const configuration = {
    networkId,
    indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
    provingServerUrl: new URL(CONFIG.proofServer),
  };

  const wallet = await WalletFacade.init({
    configuration,
    shielded: (config: typeof configuration) =>
      ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config: typeof configuration) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config: typeof configuration) =>
      DustWallet(config).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// =============================================================================
// Provider Setup
// =============================================================================

export async function createProviders(
  walletCtx: Awaited<ReturnType<typeof createWallet>>,
  customZkConfigPath?: string,
) {
  const state = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signData(payload);
      const signed = await walletCtx.wallet.signRecipe(recipe, signFn);
      return walletCtx.wallet.finalizeRecipe(signed);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  // Default zkConfigPath here is a placeholder; deploy-wi15.1 always passes
  // customZkConfigPath (via BUILD_ROOT) and also swaps per-sibling via
  // withZkConfigDir before each contract call.
  const defaultZkConfigPath = customZkConfigPath ?? '/tmp/nonexistent-default-zk-config';
  const zkConfigProvider = new NodeZkConfigProvider(defaultZkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: CONFIG.privateStateId,
      privateStoragePasswordProvider: () => 'pollpower-tariff-registry-deploy-2026!',
      accountId: state.shielded.coinPublicKey.toHexString(),
      walletProvider,
    } as any),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

/**
 * Returns a shallow-cloned providers object with a new zkConfigProvider
 * (and matching proofProvider) rooted at `zkConfigDir`.
 */
export function withZkConfigDir<P extends { zkConfigProvider: any; proofProvider: any }>(
  providers: P,
  zkConfigDir: string,
): P {
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigDir);
  return {
    ...providers,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
  };
}
