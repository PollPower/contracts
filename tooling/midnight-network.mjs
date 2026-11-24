// @ts-check
// Network endpoints for every PollPower tooling script, from environment
// variables only. No endpoint is hardcoded: kenya's self-hosted Preprod stack
// (Tailscale) is the target, and its addresses come from docs/infra-status.md.
//
// Required:
//   MIDNIGHT_NETWORK_ID         preprod | preview | mainnet | undeployed
//   MIDNIGHT_INDEXER_URL        indexer GraphQL over HTTP(S), e.g. http://<kenya>:8088/api/v4/graphql
//   MIDNIGHT_NODE_URL           node RPC over HTTP(S),       e.g. http://<kenya>:9944
// Optional:
//   MIDNIGHT_INDEXER_WS_URL     default: MIDNIGHT_INDEXER_URL with http->ws and a /ws suffix
//   MIDNIGHT_NODE_WS_URL        default: MIDNIGHT_NODE_URL with http->ws
//   MIDNIGHT_PROOF_SERVER_URL   default: http://127.0.0.1:6300 (proof server 9.0.2)
//   MIDNIGHT_TX_TTL_SECONDS     default: 3600
//
// This module has no dependencies so any script (plain node, tsx, tests) can use it.

/** @typedef {{
 *   networkId: string,
 *   indexer: string,
 *   indexerWS: string,
 *   node: string,
 *   nodeWS: string,
 *   proofServer: string,
 *   ttlSeconds: number,
 * }} MidnightNetwork */

const NETWORK_IDS = ['preprod', 'preview', 'mainnet', 'undeployed'];

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
export function loadNetworkConfig(env = process.env) {
  /** @param {string} k */
  const get = (k) => { const v = env[k]?.trim(); return v ? v : undefined; };
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
  return `${n.networkId}: indexer ${strip(n.indexer)}, node ${strip(n.node)}, proof server ${strip(n.proofServer)}`;
}
