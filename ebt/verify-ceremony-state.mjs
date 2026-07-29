// verify-ceremony-state.mjs — generic on-chain state verifier for the
// ceremony contract. Reads the "rolled out so far" list from deployment.json
// (field: circuitsRolledIn, array of circuit ids that have been vk-inserted
// since the initial 8-circuit ceremony deploy).
//
// Baseline: 8 KEEP circuits from deploy + any circuit id in circuitsRolledIn
// MUST be DEFINED; everything else in circuitsDeferredForVkInsert MUST be
// UNDEFINED.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EBT_ROOT = '/home/pollpower/contracts/ebt';
const DEPLOYMENT_JSON_PATH = path.join(EBT_ROOT, 'deployment.json');

const CEREMONY_KEEP = [
  'initialize','attestProducerOwnership','revokeProducerOwnership',
  'mirrorActionLogHead','mirrorScheduleLifecycle','mirrorClassStatutoryTotal',
  'mirrorRegisterLane','settle',
];
const ALL_DEFER = [
  'claimSplit','manualReissue','execMultisigOp','execOwnerOp','redeem',
  'mirrorActionLogRoot','mirrorRetireLane','resolveLanesMirror',
  'isLaneActiveMirror','getRegistryActionLogHeadSeq',
];

function fatal(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }
function log(msg) { console.log(`[verify] ${msg}`); }

async function main() {
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  const contractAddress = parsed.contractAddress;
  if (!contractAddress) fatal('no contractAddress in deployment.json');

  const rolledIn = new Set(parsed.circuitsRolledIn || []);
  const stillDeferred = ALL_DEFER.filter(c => !rolledIn.has(c));

  log(`contract:      ${contractAddress}`);
  log(`variant:       ${parsed.contractVariant}`);
  log(`deployedAt:    ${parsed.deployedAt}`);
  log(`rolled in:     ${[...rolledIn].join(', ') || '(none yet)'}`);
  log(`still deferred: ${stillDeferred.join(', ') || '(none — all 18 present)'}`);
  log('');

  const deployUtilsPath = '/opt/pollpower/settlement-api/src/utils-runtime.js';
  const deployUtils = await import(pathToFileURL(deployUtilsPath).href);
  const walletCtx = await deployUtils.createWallet(parsed.seed);
  const providers = await deployUtils.createProviders(walletCtx, path.join(EBT_ROOT, 'build'));

  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');

  log('querying contract state...');
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) fatal('no state at address');

  let ok = true;
  const expectDefined = [...CEREMONY_KEEP, ...rolledIn];
  const expectUndefined = stillDeferred;

  log('');
  log(`expected DEFINED (${expectDefined.length}):`);
  for (const c of expectDefined) {
    const op = state.operation(c);
    const mark = op !== undefined ? '✅' : '❌';
    log(`  ${mark} ${c}`);
    if (op === undefined) ok = false;
  }
  log('');
  log(`expected UNDEFINED (${expectUndefined.length}):`);
  for (const c of expectUndefined) {
    const op = state.operation(c);
    const mark = op === undefined ? '✅' : '❌';
    log(`  ${mark} ${c}${op !== undefined ? ' — DEFINED (unexpected!)' : ''}`);
    if (op !== undefined) ok = false;
  }
  log('');
  if (ok) {
    log(`✅ ALL CHECKS PASSED — on-chain state matches deployment.json`);
  } else {
    log(`❌ MISMATCH — on-chain state does NOT match deployment.json`);
    log(`   (did a vk-insert land without updating circuitsRolledIn?)`);
    process.exit(2);
  }

  if (walletCtx?.wallet?.close) {
    log('closing wallet...');
    await walletCtx.wallet.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] ERR:', err?.message || err);
  process.exit(1);
});
