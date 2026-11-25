// @ts-check
// Persistent, encrypted wallet state for the deploy wallet (Preprod gate G3b).
//
// A fresh wallet replays the chain from genesis on every start (DUST history
// included: hours on Preprod). This keeps the synced state of the three
// wallets (shielded, unshielded, DUST) and the transaction history in ONE
// file, so every ceremony step resumes from where the last one stopped, and a
// step that fails part-way resumes from the last save.
//
// The file:
//   - is encrypted (AES-256-GCM). The key is derived from the wallet seed
//     (HKDF-SHA256, fresh random salt per save), so the file is useless without
//     the seed and a different seed cannot open it. The format, the network
//     ID and the indexer it was synced from are authenticated (AAD): a
//     Preprod state never opens on another network or another indexer;
//   - never contains the seed: the snapshots the SDK writes are wallet state
//     (coins, cursors, derived keys), which is why the file is encrypted;
//   - is owner-only (icacls on Windows, chmod 600 elsewhere), refused inside a
//     git checkout, and replaced atomically (temp file + rename), so a crash
//     mid-save leaves the previous good state.
// A state file that cannot be read is an error, never a silent full resync:
// move it away by hand to start over.
//
// The wallet is configured exactly as tooling/midnight-providers.mjs
// createWallet does (that module is hashed into the devnet pass manifest, so
// it is not changed here); the returned context has the same shape
// ({ wallet, unshieldedKeystore }) plus save() and close().
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import * as Rx from 'rxjs';
import {
  DustWallet, InMemoryTransactionHistoryStorage, mergeWalletEntries, PublicKey, ShieldedWallet,
  UnshieldedWallet, WalletEntrySchema, WalletFacade, WalletSeeds, createKeystore,
} from '@midnightntwrk/wallet-sdk';
import { gitWorkTreeOf, ownerOnly } from './wallet-lib.mjs';

export const STATE_FORMAT = 'pp-wallet-state-v1';
const INFO = Buffer.from('pollpower/deploy-wallet-state/v1');

const seedBytes = (/** @type {string} */ seedHex) => {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error('wallet seed must be 32 bytes hex');
  return Buffer.from(seedHex, 'hex');
};
const aad = (/** @type {string} */ networkId, /** @type {string} */ source) => Buffer.from(`${STATE_FORMAT}|${networkId}|${source}`);

/**
 * The indexer a state was synced from, without query string (no tokens): a
 * state synced from one indexer (e.g. the Blockfrost bridge) is not reused
 * against another (our own node), which may number events differently.
 */
export const stateSource = (/** @type {{ indexer: string }} */ net) => { const u = new URL(net.indexer); return `${u.host}${u.pathname}`; };

/** Default state file next to a seed file: <dir>/<name>.wallet-state */
export const defaultStateFile = (/** @type {string} */ seedFile) => path.resolve(seedFile).replace(/\.seed$/i, '') + '.wallet-state';

/**
 * @param {{ shielded: string, unshielded: string, dust: string, txHistory: string }} snapshot
 * @param {string} seedHex @param {string} networkId @param {string} source indexer (stateSource)
 * @returns {string} the file content (JSON)
 */
export function encryptState(snapshot, seedHex, networkId, source) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = Buffer.from(hkdfSync('sha256', seedBytes(seedHex), salt, INFO, 32));
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(networkId, source));
  const ct = Buffer.concat([c.update(JSON.stringify(snapshot), 'utf8'), c.final()]);
  key.fill(0);
  return JSON.stringify({
    format: STATE_FORMAT, networkId, source, savedAt: new Date().toISOString(),
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  });
}

/**
 * @param {string} content @param {string} seedHex @param {string} networkId @param {string} source
 * @returns {{ shielded: string, unshielded: string, dust: string, txHistory: string }}
 */
export function decryptState(content, seedHex, networkId, source) {
  let f;
  try { f = JSON.parse(content); } catch { throw new Error('wallet state file is not valid JSON'); }
  if (f?.format !== STATE_FORMAT) throw new Error(`wallet state file format ${JSON.stringify(f?.format)} is not ${STATE_FORMAT}`);
  if (f.networkId !== networkId) throw new Error(`wallet state file is for network ${JSON.stringify(f.networkId)}, not ${JSON.stringify(networkId)}`);
  if (f.source !== source) throw new Error(`wallet state file was synced from indexer ${JSON.stringify(f.source)}, not ${JSON.stringify(source)}; use a separate state file for this endpoint`);
  const key = Buffer.from(hkdfSync('sha256', seedBytes(seedHex), Buffer.from(f.salt, 'base64'), INFO, 32));
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAAD(aad(networkId, source));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(f.ct, 'base64')), d.final()]).toString('utf8');
    return JSON.parse(pt);
  } catch {
    throw new Error('wallet state file does not open with this seed on this network (wrong seed, other network, or modified)');
  } finally {
    key.fill(0);
  }
}

/** Atomic owner-only write: temp file in the same directory, ACL, rename. */
export function writeStateFile(/** @type {string} */ file, /** @type {string} */ content) {
  const abs = checkStatePath(file);
  const tmp = `${abs}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
  try {
    ownerOnly(tmp);
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return abs;
}

/** @returns {string} the absolute path, after refusing a path inside a git checkout or a missing directory */
export function checkStatePath(/** @type {string} */ file) {
  if (!file) throw new Error('wallet state file path required');
  const abs = path.resolve(file);
  const repo = gitWorkTreeOf(path.dirname(abs));
  if (repo) throw new Error(`REFUSING: wallet state file ${abs} is inside a git checkout (${repo}); it holds wallet state, keep it outside every repository`);
  if (!fs.existsSync(path.dirname(abs))) throw new Error(`REFUSING: directory ${path.dirname(abs)} does not exist`);
  return abs;
}

/**
 * Starts the wallet from the state file if it exists (resuming its sync), or
 * fresh from the seed if it does not. Saves while syncing (every
 * `saveEveryMs`, so a long first sync survives an interruption), and on
 * save()/close().
 * @param {{ seedHex: string, net: import('../midnight-network.mjs').MidnightNetwork, stateFile: string,
 *   saveEveryMs?: number, log?: (s: string) => void }} o
 */
export async function openPersistentWallet({ seedHex, net, stateFile, saveEveryMs = 60_000, log = (s) => console.log(s) }) {
  const abs = checkStatePath(stateFile);
  const restored = fs.existsSync(abs) ? decryptState(fs.readFileSync(abs, 'utf8'), seedHex, net.networkId, stateSource(net)) : null;
  const txHistoryStorage = restored
    ? InMemoryTransactionHistoryStorage.restore(restored.txHistory, WalletEntrySchema, mergeWalletEntries)
    : new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);
  const configuration = WalletFacade.resolveConfiguration({
    networkId: net.networkId,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(net.nodeWS),
    provers: { v9: { kind: 'server', url: new URL(net.proofServer) } },
    indexerClientConnection: { indexerHttpUrl: net.indexer, indexerWsUrl: net.indexerWS },
    txHistoryStorage,
  });
  const seeds = WalletSeeds.fromMasterSeed(seedBytes(seedHex));
  const unshieldedKeystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, configuration.networkId);
  const wallet = await WalletFacade.init({
    configuration,
    shielded: (config) => (restored ? ShieldedWallet(config).restore(restored.shielded) : ShieldedWallet(config).startWithSeed(seeds.shielded)),
    unshielded: (config) => (restored
      ? UnshieldedWallet(config).restore(restored.unshielded)
      : UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore))),
    dust: (config) => (restored ? DustWallet(config).restore(restored.dust) : DustWallet(config).startWithSeed(seeds.dust)),
  });
  await wallet.start(seeds);
  log(`[wallet-state] ${restored ? 'resumed from' : 'no state yet, full sync; will save to'} ${abs}`);

  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(async () => {
      const snapshot = {
        shielded: await wallet.shielded.serializeState(),
        unshielded: await wallet.unshielded.serializeState(),
        dust: await wallet.dust.serializeState(),
        txHistory: await txHistoryStorage.serialize(),
      };
      writeStateFile(abs, encryptState(snapshot, seedHex, net.networkId, stateSource(net)));
    });
    return saving;
  };
  const timer = setInterval(() => { save().catch((e) => log(`[wallet-state] periodic save failed: ${e?.message ?? e}`)); }, saveEveryMs);
  timer.unref();
  // Save once the wallet first reports synced, so the expensive part is kept at once.
  const firstSynced = Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)))
    .then(() => save())
    .then(() => log(`[wallet-state] synced; saved ${abs}`))
    .catch(() => { /* stopped before sync */ });
  const close = async () => {
    clearInterval(timer);
    await save();
    await /** @type {any} */ (wallet).stop?.();
  };
  return { wallet, unshieldedKeystore, save, close, restored: Boolean(restored), stateFile: abs, firstSynced };
}
