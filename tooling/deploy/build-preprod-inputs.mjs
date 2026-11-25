// @ts-check
// Builds the Preprod ceremony inputs file (G6) from the off-chain
// council-keys file and a file of the other public constructor parameters.
//
//   node tooling/deploy/build-preprod-inputs.mjs --council-keys <council-keys.json> \
//        --params <preprod-params.json> --out <preprod-inputs.json> \
//        [--denylist <file of compressed keys never to use>] [--check-repo <dir> ...]
//
// Council: slots 0..n-1 in slot order, each a compressed secp256k1 key
// (33 bytes hex, as the ring test reports it), expanded to the Multisig v8
// point. Every council key must be a valid point, not a devnet test key (the
// council-keys-guard marker), not on the denylist, distinct, and NEVER
// PUBLISHED: absent from the history of this repository and of every
// --check-repo (compressed hex, x as hex and as decimal). The threshold comes
// from the council-keys file; council-keys-guard checks the bounds.
//
// Output: the inputs file the ceremony's parseInputs reads (it re-checks the
// shape and refuses devnet keys). Written outside every git checkout, never
// over an existing file. Nothing printed contains a key.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { isDevnetCouncilPoint, buildCouncilConstructorArgs } from '../council/council-keys-guard.mjs';
import { parseInputs } from './preprod-ceremony.mjs';
import { ROOT as ROOT_DIR } from './network.mjs';
import { gitWorkTreeOf } from '../wallet/wallet-lib.mjs';

const big = (/** @type {Uint8Array} */ b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);

/** Compressed secp256k1 key (hex) -> { x, y } (bigint); throws on anything else. */
export function expandCompressed(/** @type {string} */ hex, /** @type {string} */ name) {
  if (!/^0[23][0-9a-fA-F]{64}$/.test(String(hex))) throw new Error(`${name}: not a compressed secp256k1 key (33 bytes hex)`);
  let P;
  try { P = secp256k1.Point.fromHex(String(hex).toLowerCase()); P.assertValidity(); } catch { throw new Error(`${name}: not a point on secp256k1`); }
  const raw = P.toBytes(false);
  return { x: big(raw.slice(1, 33)), y: big(raw.slice(33, 65)) };
}

/** The strings a published key could appear as. */
export const keyNeedles = (/** @type {string} */ compressed, /** @type {{ x: bigint }} */ p) =>
  [String(compressed).toLowerCase(), p.x.toString(16).padStart(64, '0'), p.x.toString()];

/** Repos (by dir) whose history or working tree contains any needle. */
export function publishedIn(/** @type {string[]} */ needles, /** @type {string[]} */ repos) {
  const hits = [];
  for (const repo of repos) {
    for (const n of needles) {
      const log = execFileSync('git', ['log', '--all', '--oneline', '-i', `-S${n}`], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
      let tree = '';
      try { tree = execFileSync('git', ['grep', '-I', '-i', '-l', n], { cwd: repo, encoding: 'utf8' }).trim(); } catch { /* exit 1 = no match */ }
      if (log || tree) { hits.push(path.basename(repo)); break; }
    }
  }
  return hits;
}

/**
 * @param {{ councilKeys: any, params: any, denylist?: string[], repos: string[] }} o
 * @returns {{ inputs: any, report: string[] }}
 */
export function buildInputs({ councilKeys, params, denylist = [], repos }) {
  const slots = [...(councilKeys.council ?? [])].sort((a, b) => a.slot - b.slot);
  if (!slots.length) throw new Error('council-keys: no council slots');
  slots.forEach((s, i) => { if (s.slot !== i) throw new Error(`council-keys: slots must be 0..n-1 without gaps (found slot ${s.slot} at position ${i})`); });
  const deny = new Set(denylist.map((k) => String(k).trim().toLowerCase()).filter(Boolean));
  const report = [];
  const points = slots.map((s) => {
    const name = `council slot ${s.slot}`;
    if (!s.publicKey) throw new Error(`${name}: no public key yet`);
    const p = expandCompressed(s.publicKey, name);
    if (isDevnetCouncilPoint(p)) throw new Error(`${name}: a devnet test key (marker 0xDE7E)`);
    if (deny.has(String(s.publicKey).toLowerCase())) throw new Error(`${name}: on the denylist (retired or published key)`);
    const hits = publishedIn(keyNeedles(s.publicKey, p), repos);
    if (hits.length) throw new Error(`${name}: PUBLISHED before (found in ${hits.join(', ')}); the ceremony rule needs a never-published key`);
    report.push(`${name}: valid point, not a devnet key, not denylisted, not found in ${repos.length} repo histories`);
    return { ...p, identity: false };
  });
  const xs = points.map((p) => p.x.toString());
  if (new Set(xs).size !== xs.length) throw new Error('council: duplicate keys');
  const threshold = BigInt(councilKeys.threshold ?? 0);
  buildCouncilConstructorArgs(points, threshold, 'preprod');   // H-3 bounds, majority, no devnet keys
  const inputs = {
    council: { points: points.map((p) => ({ x: p.x.toString(), y: p.y.toString() })), threshold: threshold.toString() },
    tariff: params.tariff,
    ebt: params.ebt,
  };
  parseInputs(inputs);   // the ceremony's own checks (shape, devnet Jubjub keys)
  report.push(`council: ${points.length} slots, threshold ${threshold}; tariff and ebt parameters parse`);
  return { inputs, report };
}

async function main(/** @type {string[]} */ argv) {
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const all = (/** @type {string} */ k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const [ck, pf, out] = [arg('--council-keys'), arg('--params'), arg('--out')];
  if (!ck || !pf || !out) throw new Error('usage: build-preprod-inputs.mjs --council-keys <file> --params <file> --out <file> [--denylist <file>] [--check-repo <dir> ...]');
  const outAbs = path.resolve(out);
  if (gitWorkTreeOf(path.dirname(outAbs))) throw new Error(`REFUSING: ${outAbs} is inside a git checkout; council keys are never committed`);
  if (fs.existsSync(outAbs)) throw new Error(`REFUSING: ${outAbs} exists`);
  const denylist = arg('--denylist') ? fs.readFileSync(String(arg('--denylist')), 'utf8').split(/\r?\n/) : [];
  const repos = [ROOT_DIR, ...all('--check-repo').map((d) => path.resolve(d))];
  const { inputs, report } = buildInputs({
    councilKeys: JSON.parse(fs.readFileSync(ck, 'utf8')), params: JSON.parse(fs.readFileSync(pf, 'utf8')), denylist, repos,
  });
  fs.writeFileSync(outAbs, JSON.stringify(inputs, null, 2), { flag: 'wx', mode: 0o600 });
  for (const l of report) console.log(`[inputs] ${l}`);
  console.log(`[inputs] written: ${outAbs}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`[inputs] ${String(e?.message ?? e)}`); process.exit(1); });
}
