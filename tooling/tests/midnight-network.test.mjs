import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';

const base = {
  MIDNIGHT_NETWORK_ID: 'preprod',
  MIDNIGHT_INDEXER_URL: 'http://192.0.2.10:8088/api/v4/graphql',
  MIDNIGHT_NODE_URL: 'http://192.0.2.10:9944',
};

test('requires the three core variables and names every missing one', () => {
  assert.throws(() => loadNetworkConfig({}), /MIDNIGHT_NETWORK_ID, MIDNIGHT_INDEXER_URL, MIDNIGHT_NODE_URL/);
  assert.throws(() => loadNetworkConfig({ ...base, MIDNIGHT_NODE_URL: '  ' }), /Missing network configuration: MIDNIGHT_NODE_URL/);
});

test('derives websocket URLs and defaults proof server and TTL', () => {
  const n = loadNetworkConfig(base);
  assert.equal(n.indexerWS, 'ws://192.0.2.10:8088/api/v4/graphql/ws');
  assert.equal(n.nodeWS, 'ws://192.0.2.10:9944');
  assert.equal(n.proofServer, 'http://127.0.0.1:6300');
  assert.equal(n.ttlSeconds, 3600);
});

test('explicit websocket and proof server URLs win; https becomes wss', () => {
  const n = loadNetworkConfig({
    ...base,
    MIDNIGHT_INDEXER_URL: 'https://idx.example/api/v4/graphql/',
    MIDNIGHT_NODE_WS_URL: 'wss://rpc.example',
    MIDNIGHT_PROOF_SERVER_URL: 'http://proof.example:6300',
  });
  assert.equal(n.indexerWS, 'wss://idx.example/api/v4/graphql/ws');
  assert.equal(n.nodeWS, 'wss://rpc.example');
  assert.equal(n.proofServer, 'http://proof.example:6300');
});

test('rejects unknown network ids, bad schemes and bad TTLs', () => {
  assert.throws(() => loadNetworkConfig({ ...base, MIDNIGHT_NETWORK_ID: 'testnet-02' }), /must be one of/);
  assert.throws(() => loadNetworkConfig({ ...base, MIDNIGHT_NODE_URL: 'ws://x:9944' }), /must use http: or https:/);
  assert.throws(() => loadNetworkConfig({ ...base, MIDNIGHT_INDEXER_WS_URL: 'http://x/ws' }), /must use ws: or wss:/);
  assert.throws(() => loadNetworkConfig({ ...base, MIDNIGHT_TX_TTL_SECONDS: '1.5' }), /positive whole number/);
});

test('describeNetwork drops query strings (they can hold tokens)', () => {
  const n = loadNetworkConfig({ ...base, MIDNIGHT_INDEXER_URL: 'https://idx.example/api/v4/graphql?project_id=secret' });
  assert.doesNotMatch(describeNetwork(n), /secret/);
});

// ---------------------------------------------------------------- profiles
// MIDNIGHT_PROFILE=preprod-blockfrost: Blockfrost's Midnight Preprod indexer
// and RPC (temporary bridge), project ID read at run time from
// BLOCKFROST_ENV_FILE, never shown; our own proof server only.
// MIDNIGHT_PROFILE=preprod-own: our node and indexer (MIDNIGHT_NODE_URL /
// MIDNIGHT_INDEXER_URL). Switching is one environment variable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets, installRedaction } from '../midnight-network.mjs';

const FAKE_ID = 'nightpreprodTESTabcdefghijklmnopqrstuvwxyz';
const envFile = (content) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-')); const f = path.join(d, 'bf.env'); fs.writeFileSync(f, content); return f; };
const bf = (o = {}) => ({ MIDNIGHT_PROFILE: 'preprod-blockfrost', BLOCKFROST_ENV_FILE: envFile(`BLOCKFROST_PROJECT_ID=${FAKE_ID}\n`), MIDNIGHT_PROOF_SERVER_URL: 'http://127.0.0.1:16301', ...o });
const noRedact = { installRedaction: false };

test('BF-1: preprod-blockfrost builds the Blockfrost Preprod endpoints with the project ID; own proof server', () => {
  const n = loadNetworkConfig(bf(), noRedact);
  assert.equal(n.networkId, 'preprod');
  assert.equal(n.profile, 'preprod-blockfrost');
  assert.equal(n.indexer, `https://midnight-preprod.blockfrost.io/api/v0?project_id=${FAKE_ID}`);
  assert.equal(n.indexerWS, `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${FAKE_ID}`);
  assert.equal(n.node, `https://rpc.midnight-preprod.blockfrost.io?project_id=${FAKE_ID}`);
  assert.equal(n.nodeWS, `wss://rpc.midnight-preprod.blockfrost.io?project_id=${FAKE_ID}`);
  assert.equal(n.proofServer, 'http://127.0.0.1:16301');
  assert.ok(!describeNetwork(n).includes(FAKE_ID), 'describeNetwork never shows the ID');
  // the own-node variables are ignored by this profile (so both can be set at once)
  assert.equal(loadNetworkConfig({ ...bf(), MIDNIGHT_NODE_URL: 'http://10.0.0.1:9944', MIDNIGHT_INDEXER_URL: 'http://10.0.0.1:8088/api/v4/graphql' }, noRedact).node.startsWith('https://rpc.midnight-preprod.blockfrost.io'), true);
});

test('BF-2 (negative): proofs never go to a third party: the proof server must be ours on loopback (a tunnel)', () => {
  assert.throws(() => loadNetworkConfig(bf({ MIDNIGHT_PROOF_SERVER_URL: 'https://proof.blockfrost.io' }), noRedact), /own proof server/);
  assert.throws(() => loadNetworkConfig(bf({ MIDNIGHT_PROOF_SERVER_URL: 'http://203.0.113.5:6300' }), noRedact), /own proof server/);
  assert.throws(() => loadNetworkConfig(bf({ MIDNIGHT_PROOF_SERVER_URL: undefined }), noRedact), /MIDNIGHT_PROOF_SERVER_URL/);
  assert.equal(loadNetworkConfig(bf({ MIDNIGHT_PROOF_SERVER_URL: 'http://localhost:6300' }), noRedact).proofServer, 'http://localhost:6300');
});

test('BF-3 (negative): bad or missing project ID files fail without showing the value', () => {
  const shows = (fn) => { try { fn(); return 'no error'; } catch (e) { return e.message; } };
  for (const [env, re] of [
    [bf({ BLOCKFROST_ENV_FILE: undefined }), /BLOCKFROST_ENV_FILE/],
    [bf({ BLOCKFROST_ENV_FILE: path.join(os.tmpdir(), 'no-such-bf.env') }), /cannot read/],
    [bf({ BLOCKFROST_ENV_FILE: envFile('') }), /one BLOCKFROST_PROJECT_ID= line/],
    [bf({ BLOCKFROST_ENV_FILE: envFile(`BLOCKFROST_PROJECT_ID=${FAKE_ID}\nBLOCKFROST_PROJECT_ID=${FAKE_ID}\n`) }), /one BLOCKFROST_PROJECT_ID= line/],
    [bf({ BLOCKFROST_ENV_FILE: envFile('BLOCKFROST_PROJECT_ID=nightmainnetSECRETVALUE123\n') }), /not a Midnight Preprod project ID/],
    [bf({ MIDNIGHT_NETWORK_ID: 'mainnet' }), /MIDNIGHT_NETWORK_ID/],
  ]) {
    const m = shows(() => loadNetworkConfig(env, noRedact));
    assert.match(m, re);
    assert.ok(!m.includes(FAKE_ID) && !m.includes('SECRETVALUE'), `error shows the ID: ${m}`);
  }
  assert.throws(() => loadNetworkConfig({ MIDNIGHT_PROFILE: 'preprod-somewhere' }), /MIDNIGHT_PROFILE/);
});

test('BF-4: redaction removes the ID (raw, URL-encoded, any project_id= value) from text and from installed outputs', () => {
  assert.equal(redactSecrets(`request to https://x.io/api?project_id=${FAKE_ID} failed`, [FAKE_ID]), 'request to https://x.io/api?project_id=<redacted> failed');
  assert.equal(redactSecrets(`id ${FAKE_ID} and ${encodeURIComponent(FAKE_ID)}`, [FAKE_ID]), 'id <redacted> and <redacted>');
  assert.equal(redactSecrets('wss://h?a=1&project_id=zzz&b=2', []), 'wss://h?a=1&project_id=<redacted>&b=2');
  const out = [];
  const sink = { log: (...a) => out.push(a.join(' ')), warn: (...a) => out.push(a.join(' ')), error: (...a) => out.push(a.join(' ')), info: (...a) => out.push(a.join(' ')), debug: (...a) => out.push(a.join(' ')) };
  const stream = { write: (c) => { out.push(String(c)); return true; } };
  installRedaction([FAKE_ID], { console: sink, streams: [stream] });
  sink.log('node', `wss://rpc?project_id=${FAKE_ID}`);
  sink.error(new Error(`boom ${FAKE_ID}`));
  stream.write(`RPC-CORE: disconnected from wss://rpc?project_id=${FAKE_ID}\n`);
  assert.ok(out.length === 3 && out.every((l) => !l.includes(FAKE_ID)), out.join(' | '));
});

test('BF-5: preprod-own uses our node and indexer; switching back is MIDNIGHT_PROFILE alone', () => {
  const own = { MIDNIGHT_NODE_URL: 'http://127.0.0.1:19945', MIDNIGHT_INDEXER_URL: 'http://127.0.0.1:18089/api/v4/graphql', MIDNIGHT_PROOF_SERVER_URL: 'http://127.0.0.1:16301' };
  const both = { ...bf(), ...own };
  const viaBf = loadNetworkConfig(both, noRedact);
  const viaOwn = loadNetworkConfig({ ...both, MIDNIGHT_PROFILE: 'preprod-own' }, noRedact);
  assert.equal(viaOwn.networkId, 'preprod');
  assert.equal(viaOwn.profile, 'preprod-own');
  assert.equal(viaOwn.node, own.MIDNIGHT_NODE_URL);
  assert.equal(viaOwn.indexer, own.MIDNIGHT_INDEXER_URL);
  assert.notEqual(viaBf.node, viaOwn.node);
  assert.equal(viaBf.proofServer, viaOwn.proofServer);
  assert.throws(() => loadNetworkConfig({ ...own, MIDNIGHT_PROFILE: 'preprod-own', MIDNIGHT_NETWORK_ID: 'undeployed' }), /MIDNIGHT_NETWORK_ID/);
});

test('BF-6: the read-only Preprod check judges chain name and indexer lag; keeps only limit headers', async () => {
  const { verdicts, limitHeaders, MAX_INDEXER_LAG_BLOCKS } = await import('../network/preprod-check.mjs');
  assert.deepEqual(verdicts({ chain: 'Midnight Preprod', nodeTip: 100, indexerHeight: 98 }), { chainIsPreprod: true, indexerLag: 2, indexerCloseToTip: true });
  assert.equal(verdicts({ chain: 'Midnight Mainnet', nodeTip: 100, indexerHeight: 100 }).chainIsPreprod, false);
  assert.equal(verdicts({ chain: 'Midnight Preprod', nodeTip: 100, indexerHeight: 100 - MAX_INDEXER_LAG_BLOCKS - 1 }).indexerCloseToTip, false);
  const h = new Headers({ 'x-ratelimit-remaining': '9', 'content-type': 'application/json', 'retry-after': '1' });
  assert.deepEqual(limitHeaders(h), { 'retry-after': '1', 'x-ratelimit-remaining': '9' });
});
