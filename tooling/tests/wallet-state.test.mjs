// Persistent wallet state (G3b). Throwaway seeds and temp dirs only; the
// Preprod seed file is never read here.
//
// WS-1..WS-5 run offline. WS-6 runs against the local devnet when
// WALLET_STATE_DEVNET=1 and the MIDNIGHT_* devnet variables are set: it opens
// the devnet genesis wallet twice through one state file and checks that the
// second start resumes (no full resync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  encryptState, decryptState, writeStateFile, checkStatePath, defaultStateFile, stateSource, STATE_FORMAT,
} from '../wallet/wallet-state.mjs';
import { ROOT } from '../deploy/network.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ppws-'));
const seedA = randomBytes(32).toString('hex');
const seedB = randomBytes(32).toString('hex');
const BF = stateSource({ indexer: 'https://midnight-preprod.blockfrost.io/api/v0?project_id=secret' });
const OWN = stateSource({ indexer: 'http://127.0.0.1:18089/api/v4/graphql' });
const snap = { shielded: 'S'.repeat(50), unshielded: 'U'.repeat(50), dust: 'D'.repeat(50), txHistory: '[]' };

test('WS-1: state round-trips with the same seed and network; the file never contains the seed', () => {
  const content = encryptState(snap, seedA, 'preprod', BF);
  assert.deepEqual(decryptState(content, seedA, 'preprod', BF), snap);
  const f = JSON.parse(content);
  assert.equal(f.format, STATE_FORMAT);
  assert.equal(f.networkId, 'preprod');
  const seedBuf = Buffer.from(seedA, 'hex');
  for (const form of [seedA, seedA.toUpperCase(), seedBuf.toString('base64'), seedBuf.toString('latin1')]) {
    assert.ok(!content.includes(form), 'seed must not appear in the state file');
  }
  for (const v of Object.values(snap)) assert.ok(!content.includes(v), 'state is encrypted, not plain');
  assert.notEqual(encryptState(snap, seedA, 'preprod', BF), content, 'fresh salt and IV on every save');
});

test('WS-2: another seed, another network, another indexer, or a modified file does not open (no silent resync)', () => {
  const content = encryptState(snap, seedA, 'preprod', BF);
  assert.throws(() => decryptState(content, seedB, 'preprod', BF), /does not open with this seed/);
  assert.throws(() => decryptState(content, seedA, 'undeployed', BF), /is for network "preprod"/);
  const f = JSON.parse(content);
  const flipped = Buffer.from(f.ct, 'base64'); flipped[0] ^= 1;
  assert.throws(() => decryptState(JSON.stringify({ ...f, ct: flipped.toString('base64') }), seedA, 'preprod', BF), /modified/);
  assert.throws(() => decryptState(JSON.stringify({ ...f, networkId: 'undeployed' }), seedA, 'undeployed', BF), /modified/, 'network ID is authenticated');
  assert.throws(() => decryptState('{"format":"other"}', seedA, 'preprod', BF), /format/);
  assert.throws(() => decryptState(content, seedA, 'preprod', OWN), /synced from indexer .*separate state file/, 'Blockfrost state is not reused against our own indexer');
  assert.throws(() => decryptState(JSON.stringify({ ...f, source: OWN }), seedA, 'preprod', OWN), /modified/, 'indexer is authenticated');
  assert.equal(BF, 'midnight-preprod.blockfrost.io/api/v0', 'no query string (project ID) in the state source');
  assert.ok(!content.includes('secret'));
  assert.throws(() => decryptState('not json', seedA, 'preprod', BF), /not valid JSON/);
});

test('WS-3: the state file is refused inside a git checkout and in a missing directory', () => {
  assert.throws(() => checkStatePath(path.join(ROOT, 'build', 'x.wallet-state')), /inside a git checkout/);
  assert.throws(() => checkStatePath(path.join(tmp(), 'nope', 'x.wallet-state')), /does not exist/);
  assert.equal(defaultStateFile('C:/s/preprod-deploy-wallet.seed'), path.resolve('C:/s/preprod-deploy-wallet.wallet-state'));
});

test('WS-4: writes are atomic and owner-only; a rewrite replaces the file and leaves no temp files', () => {
  const d = tmp();
  const f = path.join(d, 'w.wallet-state');
  writeStateFile(f, encryptState(snap, seedA, 'preprod', BF));
  writeStateFile(f, encryptState({ ...snap, dust: 'E' }, seedA, 'preprod', BF));
  assert.equal(decryptState(fs.readFileSync(f, 'utf8'), seedA, 'preprod', BF).dust, 'E');
  assert.deepEqual(fs.readdirSync(d), ['w.wallet-state']);
  if (process.platform === 'win32') {
    const acl = execFileSync('icacls', [f], { encoding: 'utf8' });
    const grants = acl.split(/\r?\n/).map((l) => l.replace(f, '').trim()).filter((l) => /:\(/.test(l));
    assert.equal(grants.length, 1, `exactly one ACL entry, got:\n${acl}`);
    assert.match(grants[0], new RegExp(`\\\\${process.env.USERNAME}:\\(F\\)$`, 'i'));
    assert.ok(!/\(I\)/.test(acl), 'no inherited entries');
  } else {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  }
});

test('WS-5: the ceremony and wallet-status default to the state file next to the seed file', async () => {
  const { walletStateFile } = await import('../deploy/preprod-ceremony.mjs');
  assert.equal(walletStateFile({ PREPROD_DEPLOY_WALLET_SEED_FILE: 'C:/s/a.seed' }), path.resolve('C:/s/a.wallet-state'));
  assert.equal(walletStateFile({ PREPROD_DEPLOY_WALLET_SEED_FILE: 'C:/s/a.seed', PREPROD_DEPLOY_WALLET_STATE_FILE: 'D:/x.ws' }), path.resolve('D:/x.ws'));
  assert.throws(() => walletStateFile({ PREPROD_DEPLOY_WALLET_SEED: seedA }), /PREPROD_DEPLOY_WALLET_STATE_FILE/);
  const { parseArgs } = await import('../wallet/wallet-status.mjs');
  assert.equal(parseArgs(['--seed-file', 'C:/s/a.seed']).stateFile, path.resolve('C:/s/a.wallet-state'));
  assert.equal(parseArgs(['--seed-file', 'C:/s/a.seed', '--state-file', 'D:/y']).stateFile, path.resolve('D:/y'));
});

test('WS-6 (devnet): a second start resumes from the state file and does not resync from genesis', { skip: process.env.WALLET_STATE_DEVNET !== '1' }, async () => {
  const { loadNetworkConfig } = await import('../midnight-network.mjs');
  const { openPersistentWallet } = await import('../wallet/wallet-state.mjs');
  const { DEV_GENESIS_SEED, assertLocalDevnet } = await import('../devnet/devnet-wallet.mjs');
  const net = loadNetworkConfig();
  assertLocalDevnet(net);
  const indexerHost = new URL(net.indexer).host;
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (/** @type {any} */ i, /** @type {any} */ o) => { if (new URL(String(i?.url ?? i)).host === indexerHost) n++; return orig(i, o); };
  const stateFile = path.join(tmp(), 'genesis.wallet-state');
  const NIGHT = '0'.repeat(64);
  const run = async () => {
    n = 0;
    const t0 = Date.now();
    const ctx = await openPersistentWallet({ seedHex: DEV_GENESIS_SEED, net, stateFile, log: () => {} });
    const s = await ctx.wallet.waitForSyncedState();
    const out = { restored: ctx.restored, requests: n, ms: Date.now() - t0, night: s.unshielded.balances[NIGHT] ?? 0n, dustCoins: s.dust.availableCoins.length };
    await ctx.close();
    return out;
  };
  try {
    const first = await run();
    const second = await run();
    console.log(`[WS-6] first ${JSON.stringify({ ...first, night: String(first.night) })}`);
    console.log(`[WS-6] second ${JSON.stringify({ ...second, night: String(second.night) })}`);
    assert.equal(first.restored, false);
    assert.equal(second.restored, true);
    assert.equal(second.night, first.night, 'same NIGHT balance after resume');
    assert.equal(second.dustCoins, first.dustCoins, 'same DUST coins after resume');
    assert.ok(second.requests * 4 < first.requests, `second start must not resync: ${second.requests} indexer requests vs ${first.requests} on the first`);
  } finally {
    globalThis.fetch = orig;
  }
});
