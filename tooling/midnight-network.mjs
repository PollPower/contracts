// @ts-check
// Network endpoints for every PollPower tooling script, from environment
// variables only. No endpoint is hardcoded: the node host's self-hosted Preprod stack
// (private network) is the target, and its addresses come from docs/infra-status.md.
//
// Required:
//   MIDNIGHT_NETWORK_ID         preprod | preview | mainnet | undeployed
//   MIDNIGHT_INDEXER_URL        indexer GraphQL over HTTP(S), e.g. http://<node-host>:8088/api/v4/graphql
//   MIDNIGHT_NODE_URL           node RPC over HTTP(S),       e.g. http://<node-host>:9944
// Optional:
//   MIDNIGHT_INDEXER_WS_URL     default: MIDNIGHT_INDEXER_URL with http->ws and a /ws suffix
//   MIDNIGHT_NODE_WS_URL        default: MIDNIGHT_NODE_URL with http->ws
//   MIDNIGHT_PROOF_SERVER_URL   default: http://127.0.0.1:6300 (proof server 9.0.2)
//   MIDNIGHT_TX_TTL_SECONDS     default: 3600
//
// Preprod profiles (MIDNIGHT_PROFILE; switching between them is that one
// variable, no code change):
//   preprod-blockfrost  Blockfrost's Midnight Preprod indexer (HTTP + WS) and
//                       node RPC: a TEMPORARY bridge until our own node is at
//                       tip. The project ID is read at run time from
//                       BLOCKFROST_ENV_FILE (one `BLOCKFROST_PROJECT_ID=` line;
//                       an owner-only file outside every repo) and is redacted
//                       from every log line and error (installRedaction).
//                       MIDNIGHT_NODE_URL / MIDNIGHT_INDEXER_URL are ignored.
//   preprod-own         our own node and indexer: MIDNIGHT_NODE_URL /
//                       MIDNIGHT_INDEXER_URL (as without a profile), network
//                       forced to preprod.
// Both profiles require MIDNIGHT_PROOF_SERVER_URL on loopback (our proof
// server, through a tunnel): proofs and private inputs never go to a third
// party. MIDNIGHT_NETWORK_ID may be omitted (it must be preprod if set).
//
// This module only uses node builtins, so any script (plain node, tsx, tests) can use it.
import fs from 'node:fs';
import { installRateLimit, rateFromEnv } from './network/rate-limit.mjs';

/** @typedef {{
 *   networkId: string,
 *   indexer: string,
 *   indexerWS: string,
 *   node: string,
 *   nodeWS: string,
 *   proofServer: string,
 *   ttlSeconds: number,
 *   profile?: string,
 * }} MidnightNetwork */

const NETWORK_IDS = ['preprod', 'preview', 'mainnet', 'undeployed'];
export const PROFILES = ['preprod-blockfrost', 'preprod-own'];
const BLOCKFROST_PREPROD = {
  indexer: 'https://midnight-preprod.blockfrost.io/api/v0',
  indexerWS: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
  node: 'https://rpc.midnight-preprod.blockfrost.io',
  nodeWS: 'wss://rpc.midnight-preprod.blockfrost.io',
};
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Removes secrets from text: each given value (raw and URL-encoded) and any
 * `project_id=` query value.
 * @param {unknown} text @param {string[]} secrets
 */
export function redactSecrets(text, secrets) {
  let s = String(text);
  for (const v of secrets) {
    if (!v) continue;
    s = s.split(v).join('<redacted>').split(encodeURIComponent(v)).join('<redacted>');
  }
  return s.replace(/([?&]project_id=)(?!<redacted>)[^&\s"'<>]*/g, '$1<redacted>');
}

const installed = new Set();
/**
 * Redacts `secrets` from everything written to the console and to
 * stdout/stderr from now on (SDK and Polkadot.js log full URLs).
 * @param {string[]} secrets
 * @param {{ console?: any, streams?: any[] }} [targets]
 */
export function installRedaction(secrets, targets = { console, streams: [process.stdout, process.stderr] }) {
  const c = targets.console ?? console;
  const streams = targets.streams ?? [process.stdout, process.stderr];
  const fix = (/** @type {any} */ a) => (a instanceof Error
    ? Object.assign(new Error(redactSecrets(a.message, secrets)), { stack: redactSecrets(a.stack ?? '', secrets) })
    : typeof a === 'string' ? redactSecrets(a, secrets) : a);
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    if (typeof c[m] !== 'function' || installed.has(c[m])) continue;
    const orig = c[m].bind(c);
    c[m] = (/** @type {any[]} */ ...args) => orig(...args.map(fix));
    installed.add(c[m]);
  }
  for (const st of streams) {
    if (!st || installed.has(st.write)) continue;
    const orig = st.write.bind(st);
    st.write = (/** @type {any} */ chunk, /** @type {any[]} */ ...rest) => orig(typeof chunk === 'string' ? redactSecrets(chunk, secrets) : Buffer.isBuffer(chunk) ? redactSecrets(chunk.toString('utf8'), secrets) : chunk, ...rest);
    installed.add(st.write);
  }
}

/** The Blockfrost project ID from BLOCKFROST_ENV_FILE. Errors never contain the value. */
function blockfrostProjectId(/** @type {string | undefined} */ file) {
  if (!file) throw new Error('MIDNIGHT_PROFILE=preprod-blockfrost needs BLOCKFROST_ENV_FILE (the owner-only file holding BLOCKFROST_PROJECT_ID=)');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`BLOCKFROST_ENV_FILE: cannot read ${file}`); }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = lines.length === 1 ? /^BLOCKFROST_PROJECT_ID=(\S+)$/.exec(lines[0]) : null;
  if (!m) throw new Error(`BLOCKFROST_ENV_FILE ${file} must hold exactly one BLOCKFROST_PROJECT_ID= line with a value`);
  if (!m[1].startsWith('nightpreprod')) throw new Error(`BLOCKFROST_ENV_FILE ${file}: not a Midnight Preprod project ID (those start with "nightpreprod")`);
  return m[1];
}

/** Proof server for a Preprod profile: ours, on loopback (tunnel). */
function ownProofServer(/** @type {string | undefined} */ url) {
  if (!url) throw new Error('MIDNIGHT_PROOF_SERVER_URL is required with a Preprod profile (our own proof server, through a tunnel)');
  const u = new URL(checkUrl('MIDNIGHT_PROOF_SERVER_URL', url, ['http:', 'https:']));
  if (!LOOPBACK.has(u.hostname) && !LOOPBACK.has(`[${u.hostname}]`)) {
    throw new Error(`MIDNIGHT_PROOF_SERVER_URL must be our own proof server on loopback (a tunnel), not ${u.host}: proofs never go to a third party`);
  }
  return url;
}

/** @param {string} name @param {string} url @param {string[]} schemes */
function checkUrl(name, url, schemes) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${name} is not a valid URL: ${JSON.stringify(url)}`); }
  if (!schemes.includes(u.protocol)) {
    throw new Error(`${name} must use ${schemes.join(' or ')}, got ${u.protocol} in ${JSON.stringify(url)}`);
  }
  return url;
}

/** @param {string} httpUrl */
const toWs = (httpUrl) => httpUrl.replace(/^http/, 'ws');

/**
 * Reads the network configuration from `env` (default `process.env`).
 * Throws one error listing every missing or malformed variable.
 * @param {Record<string, string | undefined>} [env]
 * @returns {MidnightNetwork}
 */
export function loadNetworkConfig(env = process.env, { installRedaction: redact = true, rateLimit = true } = {}) {
  /** @param {string} k */
  const get = (k) => { const v = env[k]?.trim(); return v ? v : undefined; };
  const profile = get('MIDNIGHT_PROFILE');
  if (profile) {
    if (!PROFILES.includes(profile)) throw new Error(`MIDNIGHT_PROFILE must be one of ${PROFILES.join(', ')}, got ${JSON.stringify(profile)}`);
    const id = get('MIDNIGHT_NETWORK_ID');
    if (id && id !== 'preprod') throw new Error(`MIDNIGHT_PROFILE=${profile} is Preprod; MIDNIGHT_NETWORK_ID must be preprod or unset, got ${JSON.stringify(id)}`);
    const proofServer = ownProofServer(get('MIDNIGHT_PROOF_SERVER_URL'));
    if (profile === 'preprod-own') {
      return { ...loadNetworkConfig({ ...env, MIDNIGHT_PROFILE: undefined, MIDNIGHT_NETWORK_ID: 'preprod', MIDNIGHT_PROOF_SERVER_URL: proofServer }), profile };
    }
    const projectId = blockfrostProjectId(get('BLOCKFROST_ENV_FILE'));
    if (redact) installRedaction([projectId]);
    // G2c: pay-as-you-go plan; the client stays at about 8 requests/s (MIDNIGHT_RATE_LIMIT_RPS).
    if (rateLimit) installRateLimit({ hosts: [new URL(BLOCKFROST_PREPROD.indexer).hostname], rate: rateFromEnv(env) });
    const key = (/** @type {string} */ u) => `${u}?project_id=${encodeURIComponent(projectId)}`;
    const ttlSeconds = loadNetworkConfig({ MIDNIGHT_NETWORK_ID: 'preprod', MIDNIGHT_INDEXER_URL: 'http://x', MIDNIGHT_NODE_URL: 'http://x', MIDNIGHT_TX_TTL_SECONDS: get('MIDNIGHT_TX_TTL_SECONDS') }).ttlSeconds;
    return {
      networkId: 'preprod', profile, proofServer, ttlSeconds,
      indexer: key(BLOCKFROST_PREPROD.indexer), indexerWS: key(BLOCKFROST_PREPROD.indexerWS),
      node: key(BLOCKFROST_PREPROD.node), nodeWS: key(BLOCKFROST_PREPROD.nodeWS),
    };
  }
  const missing = ['MIDNIGHT_NETWORK_ID', 'MIDNIGHT_INDEXER_URL', 'MIDNIGHT_NODE_URL'].filter((k) => !get(k));
  if (missing.length) {
    throw new Error(
      `Missing network configuration: ${missing.join(', ')}. ` +
      'Set them in the environment (see .env.example). No endpoints are hardcoded.',
    );
  }
  const networkId = /** @type {string} */ (get('MIDNIGHT_NETWORK_ID'));
  if (!NETWORK_IDS.includes(networkId)) {
    throw new Error(`MIDNIGHT_NETWORK_ID must be one of ${NETWORK_IDS.join(', ')}, got ${JSON.stringify(networkId)}`);
  }
  const indexer = checkUrl('MIDNIGHT_INDEXER_URL', /** @type {string} */ (get('MIDNIGHT_INDEXER_URL')), ['http:', 'https:']);
  const node = checkUrl('MIDNIGHT_NODE_URL', /** @type {string} */ (get('MIDNIGHT_NODE_URL')), ['http:', 'https:']);
  const indexerWS = checkUrl('MIDNIGHT_INDEXER_WS_URL', get('MIDNIGHT_INDEXER_WS_URL') ?? `${toWs(indexer).replace(/\/+$/, '')}/ws`, ['ws:', 'wss:']);
  const nodeWS = checkUrl('MIDNIGHT_NODE_WS_URL', get('MIDNIGHT_NODE_WS_URL') ?? toWs(node), ['ws:', 'wss:']);
  const proofServer = checkUrl('MIDNIGHT_PROOF_SERVER_URL', get('MIDNIGHT_PROOF_SERVER_URL') ?? 'http://127.0.0.1:6300', ['http:', 'https:']);
  const ttlRaw = get('MIDNIGHT_TX_TTL_SECONDS') ?? '3600';
  const ttlSeconds = Number(ttlRaw);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`MIDNIGHT_TX_TTL_SECONDS must be a positive whole number, got ${JSON.stringify(ttlRaw)}`);
  }
  return { networkId, indexer, indexerWS, node, nodeWS, proofServer, ttlSeconds };
}

/**
 * One-line description for logs. Never includes query strings, which can
 * carry API tokens.
 * @param {MidnightNetwork} n
 */
export function describeNetwork(n) {
  /** @param {string} u */
  const strip = (u) => { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}`; };
  return `${n.networkId}${n.profile ? ` (${n.profile})` : ''}: indexer ${strip(n.indexer)}, node ${strip(n.node)}, proof server ${strip(n.proofServer)}`;
}
