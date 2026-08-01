// insert-vk-<CIRCUIT_ID>.mjs — post-ceremony rollout for tariff-registry monolith.
// Inserts the verifier key for ONE deferred circuit into the ceremony-deployed
// monolith at the contractAddress recorded in deployment.json.
//
// Pattern mirrors ebt/rollout/insert-vk-*.mjs. Full v8 monolith build lives at
// tariff-registry/build/; ceremony deploy loaded from build-ceremony/.
// vk bytes come from the FULL build (has all 18 verifier keys).
//
// USAGE:  node rollout/insert-vk-<CIRCUIT_ID>.mjs [--dry-run]
//   or:   INSERT_CIRCUIT_ID=<name> node rollout/insert-vk-tariff-template.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CIRCUIT_ID = process.env.INSERT_CIRCUIT_ID || 'resolveLanes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARIFF_ROOT = '/home/pollpower/contracts/tariff-registry';
const FULL_BUILD_DIR = path.join(TARIFF_ROOT, 'build');           // all 18 circuits
const CEREMONY_BUILD_DIR = path.join(TARIFF_ROOT, 'build-ceremony'); // 7 KEEP
const DEPLOYMENT_JSON_PATH = path.join(TARIFF_ROOT, 'deployment.json');
const ARTIFACTS_DIR = path.join(TARIFF_ROOT, 'deploy', 'artifacts');
const DEPLOY_UTILS = path.join(TARIFF_ROOT, 'deploy', 'deploy-utils.mjs');

const DRY_RUN = process.argv.includes('--dry-run');

function fatal(msg) { console.error(`[insert-vk:${CIRCUIT_ID}] FATAL: ${msg}`); process.exit(1); }
function log(msg)   { console.log(`[insert-vk:${CIRCUIT_ID}] ${msg}`); }

function makeDeployWitnesses() {
  return {
    signature_valid: (ctx, _pk, _msg, _sig) => [ctx.privateState, false],
    multisig_signature_valid: (ctx, _payload, _auth) => [ctx.privateState, false],
    charter_membership_proof: (ctx, _nodeId) => [ctx.privateState, {
      siblings: Array.from({ length: 12 }, () => new Uint8Array(32)),
      indices:  Array.from({ length: 12 }, () => false),
    }],
    witness_divmod: (ctx, num, div) => {
      if (div === 0n) return [ctx.privateState, { quotient: 0n, remainder: 0n }];
      return [ctx.privateState, { quotient: num / div, remainder: num % div }];
    },
    action_log_path_bits: (ctx, _seq) => [ctx.privateState, Array.from({ length: 24 }, () => false)],
  };
}

async function loadCompiledFullContract() {
  // Load the FULL build so all 18 circuit ids are known to the compiled
  // contract (SDK narrows circuitId to those known to ContractExecutable).
  const jsPath = path.join(FULL_BUILD_DIR, 'contract', 'index.js');
  if (!fs.existsSync(jsPath)) fatal(`missing full build at ${jsPath}`);
  const buildModule = await import(pathToFileURL(jsPath).href);
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  // Name mirrors the ceremony deploy so the signing key retrieval matches.
  return CompiledContract.make('tariff-registry-monolith-ceremony', buildModule.Contract).pipe(
    CompiledContract.withWitnesses(makeDeployWitnesses()),
    CompiledContract.withCompiledFileAssets(FULL_BUILD_DIR),
  );
}

async function getLiveProviders() {
  if (!fs.existsSync(DEPLOYMENT_JSON_PATH)) fatal(`missing ${DEPLOYMENT_JSON_PATH}`);
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  if (!parsed.seed) fatal('deployment.json missing "seed"');
  if (!parsed.contractAddress) fatal('deployment.json missing "contractAddress" — has ceremony deploy run?');
  if (parsed.contractAddressKind !== 'monolith-ceremony') {
    fatal(`deployment.json.contractAddressKind is "${parsed.contractAddressKind}", expected "monolith-ceremony"`);
  }

  const deployUtils = await import(pathToFileURL(DEPLOY_UTILS).href);
  const walletCtx = await deployUtils.createWallet(parsed.seed);
  // Providers rooted at CEREMONY build for privateStateProvider key discovery,
  // then swap zk config dir to FULL build so the verifier key file exists.
  const providers = await deployUtils.createProviders(walletCtx, CEREMONY_BUILD_DIR);
  return {
    providers: deployUtils.withZkConfigDir(providers, FULL_BUILD_DIR),
    walletCtx,
    contractAddress: parsed.contractAddress,
    deploymentRecord: parsed,
  };
}

function loadVerifierKeyBytes() {
  const vkPath = path.join(FULL_BUILD_DIR, 'keys', `${CIRCUIT_ID}.verifier`);
  if (!fs.existsSync(vkPath)) fatal(`missing verifier key: ${vkPath}`);
  const bytes = fs.readFileSync(vkPath);
  log(`loaded ${bytes.length} verifier bytes from ${vkPath}`);
  const head = bytes.slice(0, 26).toString('utf8');
  if (!head.startsWith('midnight:verifier-key[v6]:')) {
    log(`WARNING: verifier key header unexpected: '${head}'`);
  }
  return bytes;
}

async function insertOrDryRun() {
  if (DRY_RUN) {
    return {
      contractAddress: 'DRY-RUN-NO-DEPLOY',
      circuitId: CIRCUIT_ID,
      txHash: '0x' + Buffer.alloc(32).fill(0xde).toString('hex'),
      dur: 0,
      status: 'dry-run',
    };
  }

  const { submitInsertVerifierKeyTx } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');

  log('loading providers...');
  const { providers, walletCtx, contractAddress } = await getLiveProviders();

  log(`target contract: ${contractAddress}`);
  log(`target circuit:  ${CIRCUIT_ID}`);

  log('confirming circuit is CURRENTLY undefined on chain...');
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) fatal(`no contract state at ${contractAddress}`);
  const currentOp = contractState.operation(CIRCUIT_ID);
  if (currentOp !== undefined) {
    fatal(`circuit ${CIRCUIT_ID} is ALREADY defined — insert will fail.`);
  }
  log(`OK: circuit is not yet defined on chain`);

  log('loading full compiled contract...');
  const compiledContract = await loadCompiledFullContract();

  log('loading verifier key bytes...');
  const vkBytes = loadVerifierKeyBytes();

  log('submitting InsertVerifierKey maintenance tx...');
  const t0 = Date.now();
  try {
    const result = await submitInsertVerifierKeyTx(
      providers,
      compiledContract,
      contractAddress,
      CIRCUIT_ID,
      vkBytes,
    );
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    log(`InsertVerifierKey tx succeeded in ${dur}s`);

    // Confirm on-chain
    const postState = await providers.publicDataProvider.queryContractState(contractAddress);
    const postOp = postState?.operation(CIRCUIT_ID);
    const status = postOp !== undefined ? 'DEFINED' : 'UNDEFINED';
    log(`post-tx operation for ${CIRCUIT_ID}: ${status} ${postOp !== undefined ? '✅' : '❌'}`);

    // Result shape varies: SDK's FinalizedTxData may be flat or public-nested.
    // Try multiple paths.
    const txHash = result?.txId
      ?? result?.txHash
      ?? result?.public?.txId
      ?? result?.public?.txHash
      ?? 'unknown';
    const txStatus = result?.status ?? result?.public?.status ?? 'unknown';

    return {
      contractAddress,
      circuitId: CIRCUIT_ID,
      txHash,
      txStatus,
      dur: Number(dur),
      onChainStatus: status,
      walletCtx,
    };
  } catch (err) {
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[insert-vk:${CIRCUIT_ID}] FAILED after ${dur}s`);
    console.error(`  message: ${err?.message}`);
    console.error(`  cause:   ${err?.cause?.message}`);
    console.error(`  stack:   ${err?.stack?.split('\n').slice(0, 12).join('\n')}`);
    throw err;
  }
}

function ensureArtifactsDir() { fs.mkdirSync(ARTIFACTS_DIR, { recursive: true }); }

function writeManifest(result, wasDryRun) {
  ensureArtifactsDir();
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const artifactPath = path.join(ARTIFACTS_DIR, `vk-insert-monolith-${CIRCUIT_ID}-${stamp}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify({
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    mode: wasDryRun ? 'dry-run' : 'live',
    network: 'preview',
    operation: 'insertVerifierKey',
    contractAddress: result.contractAddress,
    circuitId: result.circuitId,
    txHash: result.txHash,
    txStatus: result.txStatus,
    onChainStatus: result.onChainStatus,
    durSeconds: result.dur,
    entry: `insert-vk-${CIRCUIT_ID}.mjs`,
  }, null, 2));
  log(`wrote manifest: ${artifactPath}`);
}

async function main() {
  log(`start: ${new Date().toISOString()}`);
  log(`mode: ${DRY_RUN ? 'dry-run' : 'live preview'}`);
  log(`circuit: ${CIRCUIT_ID}`);

  const result = await insertOrDryRun();
  writeManifest(result, DRY_RUN);
  log('DONE');

  if (result.walletCtx?.wallet?.close) {
    log('closing wallet...');
    await result.walletCtx.wallet.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[insert-vk:${CIRCUIT_ID}] MAIN failed:`, err?.message || err);
  process.exit(1);
});
