// deploy-ebt-v8-ceremony.mjs — deploy the 8-circuit ceremony-fenced EBT v8 to Preview.
//
// Fork of deploy-ebt-v8.mjs (2026-07-29 evening). Differences:
//   1. BUILD_DIR points at build/v8-ceremony (8 circuits: initialize,
//      attestProducerOwnership, revokeProducerOwnership, mirrorActionLogHead,
//      mirrorScheduleLifecycle, mirrorClassStatutoryTotal, mirrorRegisterLane,
//      settle).
//   2. contract-name string is 'ebt-v8-ceremony' (kept distinct so the
//      privateStateId doesn't collide with any earlier v8 attempt).
//   3. privateStateId is 'ebt-v8-ceremony-state'.
//   4. artifact manifest filename prefix is 'ebt-v8-ceremony'.
//   5. no other behavioural changes.
//
// Post-ceremony vNext: run rollout/insert-vk-<circuitId>.mjs one per circuit
// to add the deferred 10 (see V8-CEREMONY-FENCE.md).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EBT_ROOT = '/home/pollpower/contracts/ebt';
const REPO_ROOT = path.resolve(EBT_ROOT, '..');
const BUILD_DIR = path.join(EBT_ROOT, 'build', 'v8-ceremony');
const DEPLOYMENT_JSON_PATH = path.join(EBT_ROOT, 'deployment.json');
const ARTIFACTS_DIR = path.join(EBT_ROOT, 'deploy-artifacts');

const DRY_RUN = process.argv.includes('--dry-run');

function fatal(msg) {
  console.error(`[deploy-ebt-v8-ceremony] FATAL: ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[deploy-ebt-v8-ceremony] ${msg}`);
}

function makeDeployWitnesses() {
  return {
    signature_valid: (_ps, _pubkey, _messageHash, _signature) => [_ps, false],
    multisig_signature_valid: (_ps, _payload, _authorityHash) => [_ps, false],
  };
}

async function loadCompiledCeremonyContract() {
  const jsPath = path.join(BUILD_DIR, 'contract', 'index.js');
  if (!fs.existsSync(jsPath)) {
    fatal(`missing ceremony build at ${jsPath}`);
  }
  const buildModule = await import(pathToFileURL(jsPath).href);
  if (typeof buildModule.Contract !== 'function' && typeof buildModule.Contract !== 'object') {
    fatal(`ceremony build ${jsPath} does not export Contract`);
  }
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const witnesses = makeDeployWitnesses();
  return CompiledContract.make('ebt-v8-ceremony', buildModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(BUILD_DIR),
  );
}

async function loadSettlementDeployUtils() {
  const candidates = [
    process.env.EBT_V8_DEPLOY_UTILS,
    process.env.TARIFF_DEPLOY_UTILS,
    '/opt/pollpower/settlement-api/src/utils-runtime.js',
    path.resolve(REPO_ROOT, '..', 'settlement-api', 'src', 'utils-runtime.js'),
    path.resolve(REPO_ROOT, 'src', 'utils.js'),
  ].filter(Boolean);
  let lastErr;
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod?.createWallet && mod?.createProviders) {
        log(`using deploy utils: ${candidate}`);
        return mod;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  fatal(`unable to locate settlement deploy utils. Last error: ${String(lastErr)}`);
}

async function getLiveProviders() {
  if (!fs.existsSync(DEPLOYMENT_JSON_PATH)) {
    fatal(`missing deployment seed file: ${DEPLOYMENT_JSON_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  if (!parsed.seed) fatal(`deployment.json missing "seed"`);
  const deployUtils = await loadSettlementDeployUtils();
  const walletCtx = await deployUtils.createWallet(parsed.seed);
  const providers = await deployUtils.createProviders(walletCtx, path.join(EBT_ROOT, 'build'));
  if (typeof deployUtils.withZkConfigDir !== 'function') {
    fatal(`deploy utils missing withZkConfigDir(providers, dir)`);
  }
  return { providers: deployUtils.withZkConfigDir(providers, BUILD_DIR), walletCtx };
}

async function deployOrDryRun() {
  if (DRY_RUN) {
    const h = createHash('sha256').update('ebt-v8-ceremony-dryrun');
    const digest = h.digest();
    return {
      address: '0x' + digest.slice(0, 20).toString('hex'),
      txHash: '0x' + digest.slice(0, 32).toString('hex'),
    };
  }

  const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');

  log('loading providers (wallet + indexer + proof-server)...');
  const { providers, walletCtx } = await getLiveProviders();

  log('loading compiled ceremony contract with witness bindings...');
  const compiledContract = await loadCompiledCeremonyContract();

  log('submitting deployContract to Preview...');
  const t0 = Date.now();
  try {
    const deployedContract = await deployContract(providers, {
      compiledContract: compiledContract,
      privateStateId: 'ebt-v8-ceremony-state',
      initialPrivateState: {},
      args: [],
    });
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const deployTxData = deployedContract.deployTxData;
    const address = deployTxData.public.contractAddress;
    const txHash = deployTxData?.public?.txId ?? deployTxData?.public?.txHash ?? 'unknown';
    log(`deploy ok in ${dur}s`);
    return { address, txHash, walletCtx };
  } catch (err) {
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[deploy-ebt-v8-ceremony] deployContract failed after ${dur}s`);
    console.error('[deploy-ebt-v8-ceremony] err.message:', err?.message);
    console.error('[deploy-ebt-v8-ceremony] err.cause?.message:', err?.cause?.message);
    console.error('[deploy-ebt-v8-ceremony] err.stack (first 15 lines):', err?.stack?.split('\n').slice(0, 15).join('\n'));
    throw err;
  }
}

function ensureArtifactsDir() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function persistDeployment(record) {
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  const updated = {
    ...parsed,
    contractAddress: record.address,
    txHash: record.txHash,
    deployedAt: new Date().toISOString(),
    contractVariant: 'ebt-v8-ceremony',
    circuitsInDeploy: [
      'initialize',
      'attestProducerOwnership',
      'revokeProducerOwnership',
      'mirrorActionLogHead',
      'mirrorScheduleLifecycle',
      'mirrorClassStatutoryTotal',
      'mirrorRegisterLane',
      'settle',
    ],
    circuitsDeferredForVkInsert: [
      'claimSplit',
      'manualReissue',
      'execMultisigOp',
      'execOwnerOp',
      'redeem',
      'mirrorActionLogRoot',
      'mirrorRetireLane',
      'resolveLanesMirror',
      'isLaneActiveMirror',
      'getRegistryActionLogHeadSeq',
    ],
  };
  fs.writeFileSync(DEPLOYMENT_JSON_PATH, JSON.stringify(updated, null, 2));
}

function writeArtifactManifest(record, wasDryRun) {
  ensureArtifactsDir();
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const artifactPath = path.join(ARTIFACTS_DIR, `ebt-v8-ceremony-preview-${stamp}.json`);
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        schemaVersion: '1',
        generatedAt: new Date().toISOString(),
        mode: wasDryRun ? 'dry-run' : 'live',
        network: 'preview',
        variant: 'ebt-v8-ceremony',
        address: record.address,
        txHash: record.txHash,
        entry: 'deploy-ebt-v8-ceremony.mjs',
      },
      null,
      2,
    ),
  );
  log(`wrote artifact manifest: ${artifactPath}`);
}

async function main() {
  log(`start: ${new Date().toISOString()}`);
  log(`mode: ${DRY_RUN ? 'dry-run' : 'live preview'}`);
  log(`build dir: ${BUILD_DIR}`);
  log(`deployment.json: ${DEPLOYMENT_JSON_PATH}`);

  const result = await deployOrDryRun();
  log(`contractAddress: ${result.address}`);
  log(`txHash: ${result.txHash}`);

  persistDeployment(result);
  writeArtifactManifest(result, DRY_RUN);
  log('DONE');

  // Wallet cleanup
  if (result.walletCtx?.wallet?.close) {
    log('closing wallet...');
    await result.walletCtx.wallet.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[deploy-ebt-v8-ceremony] MAIN failed:', err?.message || err);
  process.exit(1);
});
