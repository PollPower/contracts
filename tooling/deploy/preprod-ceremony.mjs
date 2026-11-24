// @ts-check
// Preprod deploy ceremony entry (manual; Garrett green-lights every deploy).
// It runs the SAME deploy suite the devnet pass ran (tooling/deploy/deploy-suite.mjs)
// and refuses unless:
//   - the network is Preprod (MIDNIGHT_NETWORK_ID=preprod);
//   - invoked by hand with --i-have-garretts-go-ahead and one --step;
//   - the on-chain builds AND the deploy code hash exactly as recorded in a
//     PASSING, fresh-state, clean-tree devnet pass (docs/devnet-passes/*-pass.json);
//   - no input is a devnet test key (marked council keys; any Jubjub key derived
//     from the devnet's public labels).
// Inputs: a JSON file of PUBLIC keys and parameters (--inputs). The deploy
// wallet seed comes from PREPROD_DEPLOY_WALLET_SEED and is never logged.
// Each step deploys + finalizes (authority locked) one contract; the council
// setup between steps (TR bootstrap, schedule, class) is done with the rings.
//
//   node tooling/deploy/preprod-ceremony.mjs --step council|tariff|ebt|ld \
//        --inputs preprod-inputs.json --i-have-garretts-go-ahead
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { ROOT } from './network.mjs';
import { suiteManifest, manifestDiff } from './deploy-suite.mjs';
import { isDevnetCouncilPoint } from '../council/council-keys-guard.mjs';

const PASSES = path.join(ROOT, 'docs', 'devnet-passes');
export const STEPS = ['council', 'tariff', 'ebt', 'ld'];

/** The newest passing devnet record whose manifest equals the current one, or the reasons none qualifies. */
export function qualifyingPass(/** @type {any} */ current, dir = PASSES) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('-pass.json')).sort().reverse() : [];
  const reasons = [];
  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (rec.result !== 'pass' || !rec.gitClean || rec.network !== 'undeployed') { reasons.push(`${f}: not a clean devnet pass`); continue; }
    const diff = manifestDiff(rec.manifest, current);
    if (diff.length) { reasons.push(`${f}: differs in ${diff.join(', ')}`); continue; }
    return { ok: true, file: f, record: rec };
  }
  return { ok: false, reasons: reasons.length ? reasons : ['no passing devnet record'] };
}

/** Jubjub public keys the devnet derives from public labels (never allowed off-devnet). */
export function devnetJubjubKeys() {
  const labels = ['tariff validator', 'schedule operator', 'ebt owner', 'meter authority', 'escrow attestor', 'ld member'];
  return labels.map((l) => {
    const d = createHash('sha256').update(`pollpower wi16 devnet ${l} (test key, not a secret)`).digest();
    const sk = RT.convertNumericToJubjubScalar(d.reduce((a, x) => (a << 8n) | BigInt(x), 0n));
    return RT.jubjubSchnorrVerifyingKey(sk);
  });
}

const point = (/** @type {any} */ p, /** @type {string} */ name) => {
  if (!p || !/^[0-9]{1,78}$/.test(String(p.x)) || !/^[0-9]{1,78}$/.test(String(p.y))) throw new Error(`${name} must be { x, y } decimal`);
  return { x: BigInt(p.x), y: BigInt(p.y) };
};
const hex32 = (/** @type {any} */ h, /** @type {string} */ name) => {
  if (!/^[0-9a-fA-F]{64}$/.test(String(h))) throw new Error(`${name} must be 32-byte hex`);
  return String(h).toLowerCase();
};

/**
 * Parses and checks the Preprod inputs file (public values only).
 * { council: { points: [{x,y}] (secp256k1, decimal or 0x-hex), threshold },
 *   tariff: { governanceRootHex, refRateFiatPerKwh, validatorPk: {x,y} },
 *   ebt: { ownerPk, meterAuthorityPk, escrowAttestorPk, operationsRecipientHex, daoRecipientHex } }
 */
export function parseInputs(/** @type {any} */ raw) {
  const big = (/** @type {any} */ v, /** @type {string} */ n) => { if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(v))) throw new Error(`${n} must be an integer`); return BigInt(v); };
  const council = {
    points: (raw.council?.points ?? []).map((/** @type {any} */ p, /** @type {number} */ i) => ({ x: big(p.x, `council.points[${i}].x`), y: big(p.y, `council.points[${i}].y`), identity: false })),
    threshold: big(raw.council?.threshold, 'council.threshold'),
  };
  const tariff = {
    governanceRoot: Uint8Array.from(Buffer.from(hex32(raw.tariff?.governanceRootHex, 'tariff.governanceRootHex'), 'hex')),
    refRateFiatPerKwh: big(raw.tariff?.refRateFiatPerKwh, 'tariff.refRateFiatPerKwh'),
    validatorPk: point(raw.tariff?.validatorPk, 'tariff.validatorPk'),
  };
  const ebt = {
    ownerPk: point(raw.ebt?.ownerPk, 'ebt.ownerPk'), meterAuthorityPk: point(raw.ebt?.meterAuthorityPk, 'ebt.meterAuthorityPk'),
    escrowAttestorPk: point(raw.ebt?.escrowAttestorPk, 'ebt.escrowAttestorPk'),
    operationsRecipient: hex32(raw.ebt?.operationsRecipientHex, 'ebt.operationsRecipientHex'), daoRecipient: hex32(raw.ebt?.daoRecipientHex, 'ebt.daoRecipientHex'),
  };
  // Hard blocks: devnet test keys never reach Preprod.
  if (council.points.some(isDevnetCouncilPoint)) throw new Error('council includes a devnet test key (x starts 0xDE7E)');
  const dev = devnetJubjubKeys();
  for (const [name, pk] of [['tariff.validatorPk', tariff.validatorPk], ['ebt.ownerPk', ebt.ownerPk], ['ebt.meterAuthorityPk', ebt.meterAuthorityPk], ['ebt.escrowAttestorPk', ebt.escrowAttestorPk]]) {
    if (dev.some((d) => d.x === /** @type {any} */ (pk).x && d.y === /** @type {any} */ (pk).y)) throw new Error(`${name} is a devnet test key`);
  }
  return { council, tariff, ebt };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (!argv.includes('--i-have-garretts-go-ahead')) throw new Error('refusing: the Preprod deploy is a manual ceremony; pass --i-have-garretts-go-ahead');
  const step = arg('--step');
  if (!step || !STEPS.includes(step)) throw new Error(`--step must be one of ${STEPS.join(', ')}`);
  const { loadNetworkConfig, describeNetwork } = await import('../midnight-network.mjs');
  const net = loadNetworkConfig();
  if (net.networkId !== 'preprod') throw new Error(`refusing: network is ${net.networkId}, not preprod`);
  const q = qualifyingPass(suiteManifest());
  if (!q.ok) throw new Error(`refusing: no passing fresh devnet record matches these builds and this deploy code:\n  ${q.reasons.join('\n  ')}`);
  const inputs = parseInputs(JSON.parse(fs.readFileSync(String(arg('--inputs')), 'utf8')));
  const seed = process.env.PREPROD_DEPLOY_WALLET_SEED;
  if (!seed) throw new Error('PREPROD_DEPLOY_WALLET_SEED is required');
  const { createWallet } = await import('../midnight-providers.mjs');
  const { openNetwork } = await import('./network.mjs');
  const suite = await import('./deploy-suite.mjs');
  console.log(`[preprod] ${describeNetwork(net)}; step ${step}; builds match devnet pass ${q.file}`);
  const recFile = path.join(ROOT, 'build', 'preprod', 'ceremony-record.json');
  const rec = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, 'utf8')) : { devnetPass: q.file };
  const save = () => { fs.mkdirSync(path.dirname(recFile), { recursive: true }); fs.writeFileSync(recFile, JSON.stringify(rec, null, 2)); };
  const dn = await openNetwork({ net, ctx: await createWallet(seed, net), storeName: 'pp-preprod-deploy', password: process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? '' });
  if (rec.council) dn.bind(rec.council, 'multisig-v8');
  if (rec.tr) dn.bind(rec.tr, 'tariff-registry-v1');
  if (rec.ebt) dn.bind(rec.ebt, 'ebt-v8');
  const ctx = { dn, rec, save };
  // Witnesses are never executed by deploy/finalize; the compiled contract only needs their shape.
  const noop = (/** @type {any} */ c) => [c.privateState, undefined];
  if (step === 'council') await suite.deployCouncil(ctx, inputs.council);
  if (step === 'tariff') await suite.deployTariffRegistry(ctx, { ...inputs.tariff, witnesses: { charter_membership_proof: noop, witness_divmod: noop, action_log_path_bits: noop } });
  if (step === 'ebt') await suite.deployEbt(ctx, inputs.ebt);
  if (step === 'ld') await suite.deployLd(ctx, { witnesses: { witness_divmod: noop } });
  console.log(`[preprod] ${step} deployed and finalized; record ${recFile}`);
  process.exit(0);
}

if (process.argv[1]?.endsWith('preprod-ceremony.mjs')) {
  main().catch((e) => { console.error(`[preprod] ${String(e?.message ?? e)}`); process.exit(1); });
}
