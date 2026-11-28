// LD relayer HTTP surface: bearer token (stored as SHA-256, constant-time),
// route allowlist, body cap, and caller-vs-relayer error mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRelayerHandler, tokenOk } from '../ld/ld-relayer-server.mjs';

const TOKEN = 'test-token-not-a-secret';
const SHA = crypto.createHash('sha256').update(TOKEN).digest('hex');
const quiet = { error() {}, log() {} };

async function serve(relay) {
  const srv = http.createServer(createRelayerHandler(relay, SHA, quiet));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'POST', body, token = TOKEN } = {}) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    return { status: res.status, json: await res.json() };
  };
  return { call, close: () => new Promise((r) => srv.close(r)) };
}

test('RS-1 (negative): no token, wrong token, malformed stored hash are refused; /health is open', async () => {
  const s = await serve({ memberState: async () => ({}), submit: async () => ({}) });
  try {
    assert.equal((await s.call('/member', { token: null, body: {} })).status, 401);
    assert.equal((await s.call('/member', { token: 'wrong', body: {} })).status, 401);
    assert.equal((await s.call('/health', { method: 'GET', token: null })).status, 200);
    assert.equal(tokenOk(`Bearer ${TOKEN}`, 'not-hex'), false);
  } finally { await s.close(); }
});

test('RS-2: member state and actions are relayed; unknown routes, bad JSON and oversize bodies refused', async () => {
  const seen = [];
  const s = await serve({ memberState: async (id) => ({ memberIdHex: id }), submit: async (b) => { seen.push(b.action); return { txHash: 'tx' }; } });
  try {
    assert.deepEqual((await s.call('/member', { body: { memberIdHex: 'ab' } })).json, { ok: true, data: { memberIdHex: 'ab' } });
    assert.deepEqual((await s.call('/action', { body: { action: 'claim' } })).json, { ok: true, data: { txHash: 'tx' } });
    assert.deepEqual(seen, ['claim']);
    assert.equal((await s.call('/register', { body: {} })).status, 404);
    assert.equal((await s.call('/action', { body: '{oops' })).status, 400);
    assert.equal((await s.call('/action', { body: { pad: 'x'.repeat(20_000) } })).status, 413);
  } finally { await s.close(); }
});

test('RS-3 (negative): pre-check refusals are 400 (caller), chain failures are 502 (relayer)', async () => {
  const s = await serve({ memberState: async () => ({}), submit: async (b) => { throw new Error(b.kind === 'sig' ? 'signature does not verify for this member' : 'proof server unreachable'); } });
  try {
    assert.equal((await s.call('/action', { body: { kind: 'sig' } })).status, 400);
    assert.equal((await s.call('/action', { body: { kind: 'net' } })).status, 502);
  } finally { await s.close(); }
});
