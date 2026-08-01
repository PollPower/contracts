import { WebSocket } from "ws";
import * as Rx from "rxjs";
import { Buffer } from "buffer";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { getNetworkId, setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
setNetworkId("preview");
const CONFIG = {
  indexer: "https://indexer.preview.midnight.network/api/v3/graphql",
  indexerWS: "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
  node: "https://rpc.preview.midnight.network",
  proofServer: "http://127.0.0.1:6300",
  privateStateId: "tariff-registry-state"
};
globalThis.WebSocket = WebSocket;
function deriveKeys(seed) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, "hex"));
  if (hdWallet.type !== "seedOk") throw new Error("Invalid seed");
  const result = hdWallet.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (result.type !== "keysDerived") throw new Error("Key derivation failed");
  hdWallet.hdWallet.clear();
  return result.keys;
}
async function createWallet(seed) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
  const indexerClientConnection = {
    indexerHttpUrl: CONFIG.indexer,
    indexerWsUrl: CONFIG.indexerWS
  };
  const configuration = {
    networkId,
    indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: {
      additionalFeeOverhead: 300000000000000n,
      feeBlocksMargin: 5
    },
    relayURL: new URL(CONFIG.node.replace(/^http/, "ws")),
    provingServerUrl: new URL(CONFIG.proofServer)
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (config) => UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (config) => DustWallet(config).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust)
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}
async function createProviders(walletCtx, customZkConfigPath) {
  const state = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced))
  );
  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1e3) }
      );
      const signFn = (payload) => walletCtx.unshieldedKeystore.signData(payload);
      const signed = await walletCtx.wallet.signRecipe(recipe, signFn);
      return walletCtx.wallet.finalizeRecipe(signed);
    },
    submitTx: (tx) => walletCtx.wallet.submitTransaction(tx)
  };
  const defaultZkConfigPath = customZkConfigPath ?? "/tmp/nonexistent-default-zk-config";
  const zkConfigProvider = new NodeZkConfigProvider(defaultZkConfigPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: CONFIG.privateStateId,
      privateStoragePasswordProvider: () => "pollpower-tariff-registry-deploy-2026!",
      accountId: state.shielded.coinPublicKey.toHexString(),
      walletProvider
    }),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider
  };
}
function withZkConfigDir(providers, zkConfigDir) {
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigDir);
  return {
    ...providers,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider)
  };
}
export {
  createProviders,
  createWallet,
  deriveKeys,
  withZkConfigDir
};
