// @ts-check
// LD v3 relayer service (WI-16 step 4). pollpower-v2-api maps the logged-in
// user to their LD member id and proxies here; this process holds the
// fee-paying wallet and proves the member-signed actions.
//
//   POST /member { memberIdHex }  -> LdMemberState
//   POST /member-id { pk }        -> { memberIdHex }   (enrolment)
//   POST /action LdActionSubmit   -> { txHash }
//   GET  /health                  -> { ok }
// Every route but /health needs `Authorization: Bearer <token>`; the service
// stores only its SHA-256 (LD_RELAYER_TOKEN_SHA256) and compares in constant
// time. Bind is 127.0.0.1 unless LD_RELAYER_BIND says otherwise.
//
// Env: MIDNIGHT_* (network), LD_RELAYER_WALLET_SEED (fee wallet; never logged),
// LD_ADDRESS, EBT_ADDRESS, LD_BUILD_DIR, EBT_BUILD_DIR, LD_RELAYER_PORT,
// MIDNIGHT_PRIVATE_STATE_PASSWORD.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createWallet, createProviders } from '../midnight-providers.mjs';
import { withCrossContract } from '../xc-providers.mjs';
import { createLdRelay } from './ld-relay.mjs';

/** @type {any} */ (globalThis).WebSocket ??= WebSocket;

/** Constant-time bearer check against a stored SHA-256 (hex). */
export function tokenOk(/** @type {string | undefined} */ header, /** @type {string} */ sha256Hex) {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) return false;
  const m = /^Bearer (.+)$/.exec(String(header ?? ''));
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1]).digest();
  return crypto.timingSafeEqual(got, Buffer.from(sha256Hex, 'hex'));
}

/** HTTP handler over a relay (createLdRelay or a test double). */
export function createRelayerHandler(/** @type {any} */ relay, /** @type {string} */ tokenSha256, log = console) {
  const json = (/** @type {any} */ res, /** @type {number} */ code, /** @type {any} */ body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (!tokenOk(req.headers.authorization, tokenSha256)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST' || !['/member', '/member-id', '/action'].includes(req.url)) return json(res, 404, { ok: false, error: 'not found' });
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 16_384) return json(res, 413, { ok: false, error: 'body too large' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
    try {
      if (req.url === '/member') return json(res, 200, { ok: true, data: await relay.memberState(body.memberIdHex) });
      if (req.url === '/member-id') return json(res, 200, { ok: true, data: await relay.memberIdOf(body.pk) });
      return json(res, 200, { ok: true, data: await relay.submit(body) });
    } catch (e) {
      const msg = String(/** @type {any} */ (e)?.message ?? e).slice(0, 300);
      log.error(`[ld-relay] ${req.url} refused: ${msg}`);
      // Pre-check refusals are the caller's; anything else is ours.
      const client = /must be|does not|not a member|not live|ahead of block time|unsupported action|no pending|already the payout|only for/.test(msg);
      return json(res, client ? 400 : 502, { ok: false, error: msg });
    }
  };
}

async function main() {
  const env = process.env;
  const need = (/** @type {string} */ k) => { const v = env[k]; if (!v) throw new Error(`${k} is required`); return v; };
  const net = loadNetworkConfig(env);
  const ctx = await createWallet(need('LD_RELAYER_WALLET_SEED'), net);
  const base = await createProviders(ctx, net, {
    zkConfigDir: need('LD_BUILD_DIR'), privateStateStoreName: env.LD_RELAYER_PRIVATE_STATE_STORE ?? 'pp-ld-relayer',
    privateStatePassword: env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? '',
  });
  const providers = withCrossContract(base, net, { ownBuildDir: need('LD_BUILD_DIR'), callees: [{ address: need('EBT_ADDRESS'), buildDir: need('EBT_BUILD_DIR') }] });
  const relay = await createLdRelay({ providers, ldBuildDir: need('LD_BUILD_DIR'), ldAddress: need('LD_ADDRESS'), indexerUrl: net.indexer });
  const port = Number(env.LD_RELAYER_PORT ?? 7260);
  const bind = env.LD_RELAYER_BIND ?? '127.0.0.1';
  http.createServer(createRelayerHandler(relay, need('LD_RELAYER_TOKEN_SHA256'))).listen(port, bind, () =>
    console.log(`[ld-relay] listening on ${bind}:${port}; ${describeNetwork(net)}; LD ${env.LD_ADDRESS}`));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('ld-relayer-server.mjs')) {
  main().catch((e) => { console.error(`[ld-relay] fatal: ${String(e?.message ?? e)}`); process.exit(1); });
}
