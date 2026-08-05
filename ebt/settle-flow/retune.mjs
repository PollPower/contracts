// EBT v8 settle-flow — STEP A: emit retuneClass (kind 2) on the pilot monolith
// registry 556fe46f. Advances _actionSeq 5->6 and populates _classEntries.
// Coherent split: statutoryTotalBps=1785 (matches the enumerated statutory lane),
// producer 4643 / ops 2000 / ld 1572 / dao 0 / operatorMargin 0 = 10000.
//
// Run as plain .mjs under node from ~/contracts/ebt (symlinked node_modules realm),
// from a CLEAN cwd. OWNER_SEED env = deploy seed (submitter/DUST). Operator sig
// uses the audit-writer PEM (schedule.operatorPubkey = 3e64530c...).
import { WebSocket } from 'ws'; globalThis.WebSocket = WebSocket;
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import * as Rx from 'rxjs';

import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import {
  CompactTypeBytes, CompactTypeVector, persistentHash,
} from '@midnight-ntwrk/compact-runtime';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
(ed).hashes.sha512 = sha512;

const REG = '556fe46f8dfd5234e97974bfd8b455ef4ea8c785641d80a4d7c12530a3776dd9';
// Full monolith build STAGED under a run dir whose node_modules symlinks to the
// settlement-api realm (WASM ChargedState class unification). contract/index.js
// here defines all 18 circuits incl retuneClass; deployed verifier matches.
const REG_BUILD = '/home/pollpower/contracts/ebt/retune-full-run';
const OPERATOR_PEM = '/home/pollpower/contracts/tariff-registry/deploy/artifacts/audit-writer-2026-07-31T03-55-44-865Z.pem';
const INDEXER = 'https://indexer.preview.midnight.network/api/v3/graphql';
const INDEXER_WS = 'wss://indexer.preview.midnight.network/api/v3/graphql/ws';
const NODE_WS = 'wss://rpc.preview.midnight.network';
const PROOF = 'http://127.0.0.1:6300';

const SCHEDULE_ID = '0a0ca2e41632da85802a34207c58883f54cc2a1375ca77887c7b8dc682df101a';
// classPath — free choice, must match mirror+settle. Use a documented tag.
const CLASS_PATH = 'c1a55a7400000000000000000000000000000000000000000000000000000001'; // "class-a" pilot classPath

const hx = (s) => new Uint8Array(Buffer.from(String(s).replace(/^0x/, ''), 'hex'));
const hx32 = (s) => { const u = hx(s); if (u.length !== 32) throw new Error(`expected 32-byte hex, got ${u.length}`); return u; };
const toHex = (u) => Buffer.from(u).toString('hex');
const B32 = new CompactTypeBytes(32);

// Coherent split (sum 10000). statutoryTotalBps=1785 == statutory lane's bps.
const SPLIT = {
  producerShareBps:  4643n,
  ldShareBps:        1572n,
  opsShareBps:       2000n,
  daoShareBps:       0n,
  operatorMarginBps: 0n,
  statutoryTotalBps: 1785n,
};
const RATE = 28n;                 // in-band (refRate 28 ± 20%)
const NONCE = 1n;                 // first retune
// checkedDivide(refRate*bandBps, 10000) = checkedDivide(28*2000, 10000)=56000/10000
const DIV = { quotient: 5n, remainder: 6000n };

function fieldBytes32(v) {
  // (Uint as Field) as Bytes<32> — canonical little? Registry helper uses
  // convertFieldToBytes via compiler; but for OUR-side we only need to build
  // sig message identically to the circuit's retuneAuthHash. We rely on the
  // runtime to build the in-circuit hash; the operator sig is over retuneAuthHash
  // which the runtime discloses to the witness. So we DON'T precompute it here —
  // we sign inside the witness using the messageHash handed to us. (see below)
  throw new Error('unused');
}

async function main() {
  setNetworkId('preview');
  const seedHex = (process.env.OWNER_SEED || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('OWNER_SEED must be 64-hex');

  // Operator signing key (ed25519 PEM). We sign the messageHash the runtime hands
  // to the signature_valid witness — that IS retuneAuthHash. So the witness both
  // signs AND returns true, and the on-chain assert(signature_valid(...)) holds.
  const operatorKey = createPrivateKey(fs.readFileSync(OPERATOR_PEM, 'utf8'));

  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledgerV8.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = ledgerV8.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derived.keys[Roles.NightExternal], networkId);
  const configuration = {
    networkId,
    indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300000000000000n, feeBlocksMargin: 5 },
    relayURL: new URL(NODE_WS),
    provingServerUrl: new URL(PROOF),
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: (c) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c) => DustWallet(c).startWithSecretKey(dustSecretKey, ledgerV8.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  console.log('waiting for owner wallet sync...');
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced), Rx.timeout(240000)));
  console.log('owner wallet synced. dust:', String(state.dust?.balance ? state.dust.balance(new Date()) : 'n/a'));

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl) {
      const recipe = await wallet.balanceUnboundTransaction(tx,
        { shieldedSecretKeys, dustSecretKey }, { ttl: ttl ?? new Date(Date.now() + 30*60*1000) });
      const signed = await wallet.signRecipe(recipe, (payload) => unshieldedKeystore.signData(payload));
      return wallet.finalizeRecipe(signed);
    },
    submitTx: (tx) => wallet.submitTransaction(tx),
  };
  const pdp = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const zkConfigProvider = new NodeZkConfigProvider(REG_BUILD);

  // Witnesses for the registry contract.
  const witnesses = {
    signature_valid: (ctx, _pubkey, messageHash, _signature) => {
      // Sign the exact messageHash the circuit built (retuneAuthHash). The
      // operator sig arg passed in is ignored by our witness; we produce a real
      // ed25519 sig over messageHash and verify it => true.
      const sig = new Uint8Array(nodeSign(null, Buffer.from(messageHash), operatorKey));
      let ok = false; try { ok = ed.verify(sig, messageHash, _pubkey); } catch {}
      console.log('[witness] signature_valid msgHash=', toHex(messageHash), 'ok=', ok);
      return [ctx.privateState ?? ctx, ok];
    },
    multisig_signature_valid: (ctx, _payload, _authorityHash) => [ctx.privateState ?? ctx, false],
    charter_membership_proof: (ctx, _nodeId) => [ctx.privateState ?? ctx, {
      siblings: Array.from({ length: 12 }, () => new Uint8Array(32)),
      indices: Array.from({ length: 12 }, () => false),
    }],
    action_log_path_bits: (ctx, seq) => {
      const bits = []; let x = BigInt(seq);
      for (let i = 0; i < 24; i++) { bits.push((x & 1n) === 1n); x >>= 1n; }
      return [ctx.privateState ?? ctx, bits];
    },
  };
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'reg-retune-ceremony',
      privateStoragePasswordProvider: () => 'RegRetuneCeremony2026-pw',
      accountId: state.shielded.coinPublicKey.toHexString(),
      walletProvider,
    }),
    publicDataProvider: pdp,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
  const regModule = await import(pathToFileURL(path.join(REG_BUILD, 'contract', 'index.js')).href);
  const compiled = CompiledContract.make('tariff-registry', regModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(REG_BUILD),
  );
  const contract = await findDeployedContract(providers, {
    contractAddress: REG, compiledContract: compiled,
    privateStateId: 'reg-retune-ceremony', initialPrivateState: {},
  });

  const scheduleId = hx32(SCHEDULE_ID);
  const classPath = hx32(CLASS_PATH);
  const operatorId = hx32('3e64530c332524b85a8d4c53e2699392da6dc31a4080c5a2f1655261179ca6af');
  const operatorSignature = new Uint8Array(64); // ignored by our witness
  const currentTime = BigInt(Math.floor(Date.now() / 1000));

  console.log('=== retuneClass args ===');
  console.log('scheduleId :', SCHEDULE_ID);
  console.log('classPath  :', CLASS_PATH);
  console.log('split      :', JSON.stringify(SPLIT, (k,v)=>typeof v==='bigint'?String(v):v));
  console.log('rate       :', String(RATE), 'nonce:', String(NONCE), 'time:', String(currentTime));
  console.log('div        :', JSON.stringify(DIV,(k,v)=>String(v)));

  console.log('submitting retuneClass...');
  const tx = await contract.callTx.retuneClass(
    scheduleId, classPath, SPLIT, RATE, operatorId, operatorSignature, NONCE, currentTime, DIV, DIV);
  const txHash = tx?.public?.txHash ?? tx?.public?.txId ?? tx?.txHash ?? tx?.txId ?? 'unknown';
  console.log('RETUNE_CLASS SUBMITTED. txHash:', txHash);
  process.exit(0);
}
main().catch((e) => {
  console.error('FATAL:', e?.message || String(e));
  let cur = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.cause) { console.error(`  cause[${i}]:`, cur.cause?.message || String(cur.cause)); cur = cur.cause; }
    else break;
  }
  console.error('STACK:', e?.stack);
  // dump own enumerable props
  try { console.error('PROPS:', JSON.stringify(e, Object.getOwnPropertyNames(e).filter(k=>k!=='stack'))); } catch {}
  process.exit(1);
});
