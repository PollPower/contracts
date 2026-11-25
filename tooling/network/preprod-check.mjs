// @ts-check
// Read-only Preprod endpoint check (no wallet, no transaction, no proof).
//
//   MIDNIGHT_PROFILE=preprod-blockfrost BLOCKFROST_ENV_FILE=<file> MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:<tunnel> \
//     node tooling/network/preprod-check.mjs
//
// Checks: the node says it is Midnight Preprod (system_chain), its tip and
// health; the indexer answers and its latest block is close to the node tip;
// prints any rate-limit / quota headers the endpoints send. Five requests in
// total. The Blockfrost project ID is redacted from all output.
import { pathToFileURL } from 'node:url';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';

export const MAX_INDEXER_LAG_BLOCKS = 10;
const LIMIT_HEADER = /rate|limit|quota|remaining|retry|reset|usage|plan/i;

/** Rate-limit / quota headers from a fetch Response (names and values; none are secret). */
export function limitHeaders(/** @type {Headers} */ h) {
  /** @type {Record<string, string>} */
  const out = {};
  h.forEach((v, k) => { if (LIMIT_HEADER.test(k)) out[k] = v; });
  return out;
}

/** The checks' verdicts from the raw answers (pure, tested). */
export function verdicts(/** @type {{ chain: string, nodeTip: number, indexerHeight: number }} */ r) {
  const lag = r.nodeTip - r.indexerHeight;
  return {
    chainIsPreprod: r.chain === 'Midnight Preprod',
    indexerLag: lag,
    indexerCloseToTip: lag >= -2 && lag <= MAX_INDEXER_LAG_BLOCKS,
  };
}

async function rpc(/** @type {string} */ url, /** @type {string} */ method, /** @type {any[]} */ params = []) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000),
  });
  const body = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok || body.error) throw new Error(`node ${method}: HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return { result: body.result, headers: limitHeaders(res.headers), status: res.status };
}

async function gql(/** @type {string} */ url, /** @type {string} */ query) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000),
  });
  const body = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok || body.errors) throw new Error(`indexer: HTTP ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
  return { data: body.data, headers: limitHeaders(res.headers), status: res.status };
}

export async function check(net = loadNetworkConfig()) {
  if (net.networkId !== 'preprod') throw new Error(`refusing: network ${net.networkId}, this check is for Preprod`);
  console.log(`[check] ${describeNetwork(net)}`);
  const chain = await rpc(net.node, 'system_chain');
  const header = await rpc(net.node, 'chain_getHeader');
  const health = await rpc(net.node, 'system_health');
  const version = await rpc(net.node, 'system_version');
  const block = await gql(net.indexer, '{ block { height hash timestamp } }');
  const nodeTip = Number.parseInt(String(header.result.number), 16);
  const indexerHeight = Number(block.data.block.height);
  const v = verdicts({ chain: chain.result, nodeTip, indexerHeight });
  console.log(`[check] node: system_chain "${chain.result}" (${v.chainIsPreprod ? 'OK' : 'NOT PREPROD'}), version ${version.result}, tip #${nodeTip}, health ${JSON.stringify(health.result)}`);
  console.log(`[check] indexer: latest block #${indexerHeight} (${new Date(Number(block.data.block.timestamp)).toISOString()}), lag ${v.indexerLag} block(s): ${v.indexerCloseToTip ? 'OK' : 'BEHIND'}`);
  const hdrs = { node: { ...chain.headers, ...header.headers, ...health.headers, ...version.headers }, indexer: block.headers };
  console.log(`[check] rate-limit / quota headers: node ${JSON.stringify(hdrs.node)}, indexer ${JSON.stringify(hdrs.indexer)}`);
  return { ...v, chain: chain.result, nodeTip, indexerHeight, health: health.result, version: version.result, headers: hdrs };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  check().then((r) => process.exit(r.chainIsPreprod && r.indexerCloseToTip ? 0 : 2), (e) => {
    console.error(`[check] ${String(/** @type {any} */ (e)?.message ?? e)}`);
    process.exit(1);
  });
}
