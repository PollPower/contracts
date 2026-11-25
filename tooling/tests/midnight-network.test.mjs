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
