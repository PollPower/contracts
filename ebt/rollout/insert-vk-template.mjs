// insert-vk-<circuitId>.mjs — post-ceremony rollout: add ONE deferred v8 circuit to
// the ceremony-deployed contract at the address recorded in deployment.json.
//
// USAGE:
//   node rollout/insert-vk-<circuitId>.mjs [--dry-run]
//
// Prerequisites:
//   - ceremony deploy has completed and contractAddress is in deployment.json
//   - build/v8-full has all 18 verifier keys (from the July 29 build)
//   - the maintenance signing key for the ceremony contract is stored in the
//     privateStateProvider (set automatically by deployContract)
//   - node runtime, not tsx (avoids L12 error masking)
//
// Rationale:
//   The v8 monolith exceeds Preview's per-tx block-limit budget on deploy.
//   The ceremony-fenced build has 8 circuits (~15 KB verifier data). The
//   remaining 10 circuits are added post-ceremony via one maintenance tx
//   each, spreading the block weight across days.
//
// Order matters. Rollout schedule from V8-CEREMONY-FENCE.md:
//   Day t+1: mirrorActionLogRoot, mirrorRetireLane, execOwnerOp   (gov surface)
//   Day t+2: claimSplit, execMultisigOp                            (protocol slices + LD binding)
//   Day t+3: redeem, manualReissue, resolveLanesMirror, isLaneActiveMirror,
//            getRegistryActionLogHeadSeq                            (redemption + views)
//
// SMOKE TEST TARGET:
//   getRegistryActionLogHeadSeq  (smallest verifier at 1351 bytes, read-only,
//   no state deps) — validates end-to-end flow before real rollout begins.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================
// CONFIG — customize this per-circuit
// ============================================================================

// The circuit ID matches exactly what compactc emits for `export circuit <name>(`.
// Case-sensitive. When adapting for another circuit, change CIRCUIT_ID and
// the manifest prefix.
const CIRCUIT_ID = process.env.INSERT_CIRCUIT_ID || 'getRegistryActionLogHeadSeq';

// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EBT_ROOT = '/home/pollpower/contracts/ebt';
const REPO_ROOT = path.resolve(EBT_ROOT, '..');
// The FULL v8 build has all 18 verifier keys. We keep the ceremony build
// separate so the ceremony deploy artifact is auditable; but the vk we're
// inserting comes from the full build.
const FULL_BUILD_DIR = path.join(EBT_ROOT, 'build', 'v8');
const DEPLOYMENT_JSON_PATH = path.join(EBT_ROOT, 'deployment.json');
const ARTIFACTS_DIR = path.join(EBT_ROOT, 'deploy-artifacts');

const DRY_RUN = process.argv.includes('--dry-run');

function fatal(msg) {
  console.error(`[insert-vk:${CIRCUIT_ID}] FATAL: ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[insert-vk:${CIRCUIT_ID}] ${msg}`);
}

function makeDeployWitnesses() {
  return {
    signature_valid: (_ps, _pubkey, _messageHash, _signature) => [_ps, false],
    multisig_signature_valid: (_ps, _payload, _authorityHash) => [_ps, false],
  };
}

async function loadCompiledFullContract() {
  // We use the FULL v8 contract module because it defines ALL circuit ids —
  // the SDK's CompiledContract type-narrows the circuitId argument to those
  // known to the ContractExecutable. Loading v8-ceremony would reject
  // 'claimSplit' etc. as unknown circuit ids.
  const jsPath = path.join(FULL_BUILD_DIR, 'contract', 'index.js');
  if (!fs.existsSync(jsPath)) {
    fatal(`missing full v8 build at ${jsPath}`);
  }
  const buildModule = await import(pathToFileURL(jsPath).href);
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const witnesses = makeDeployWitnesses();
  // Name mirrors the ceremony deploy so signing-key retrieval matches.
  return CompiledContract.make('ebt-v8-ceremony', buildModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(FULL_BUILD_DIR),
  );
}

async function loadSettlementDeployUtils() {
  const candidates = [
    process.env.EBT_V8_DEPLOY_UTILS,
    '/opt/pollpower/settlement-api/src/utils-runtime.js',
    path.resolve(REPO_ROOT, '..', 'settlement-api', 'src', 'utils-runtime.js'),
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
  fatal(`unable to locate deploy utils. Last error: ${String(lastErr)}`);
}

async function getLiveProviders() {
  if (!fs.existsSync(DEPLOYMENT_JSON_PATH)) {
    fatal(`missing deployment.json: ${DEPLOYMENT_JSON_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  if (!parsed.seed) fatal(`deployment.json missing "seed"`);
  if (!parsed.contractAddress) fatal(`deployment.json missing "contractAddress" — has the ceremony deploy happened yet?`);
  const deployUtils = await loadSettlementDeployUtils();
  const walletCtx = await deployUtils.createWallet(parsed.seed);
  const providers = await deployUtils.createProviders(walletCtx, path.join(EBT_ROOT, 'build'));
  return {
    providers: deployUtils.withZkConfigDir(providers, FULL_BUILD_DIR),
    walletCtx,
    contractAddress: parsed.contractAddress,
    deploymentRecord: parsed,
  };
}

function loadVerifierKeyBytes() {
  const vkPath = path.join(FULL_BUILD_DIR, 'keys', `${CIRCUIT_ID}.verifier`);
  if (!fs.existsSync(vkPath)) {
    fatal(`missing verifier key: ${vkPath}`);
  }
  const bytes = fs.readFileSync(vkPath);
  log(`loaded ${bytes.length} verifier bytes from ${vkPath}`);
  // Confirm the header magic
  const head = bytes.slice(0, 26).toString('utf8');
  if (!head.startsWith('midnight:verifier-key[v6]:')) {
    log(`WARNING: verifier key does not start with midnight:verifier-key[v6]: header — got '${head}'`);
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
    };
  }

  const { submitInsertVerifierKeyTx } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');

  log('loading providers...');
  const { providers, walletCtx, contractAddress } = await getLiveProviders();

  log(`target contract: ${contractAddress}`);
  log(`target circuit: ${CIRCUIT_ID}`);

  log('confirming circuit is CURRENTLY undefined on chain...');
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) fatal(`no contract state at ${contractAddress}`);
  const currentOp = contractState.operation(CIRCUIT_ID);
  if (currentOp !== undefined) {
    fatal(`circuit ${CIRCUIT_ID} is ALREADY defined on chain — insert will fail. State: ${currentOp}`);
  }
  log(`OK: circuit is not yet defined on chain`);

  log('loading full v8 compiled contract...');
  const compiledContract = await loadCompiledFullContract();

  log('loading verifier key bytes from disk...');
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

    // Confirm the circuit is now on chain
    const postState = await providers.publicDataProvider.queryContractState(contractAddress);
    const postOp = postState?.operation(CIRCUIT_ID);
    log(`post-tx operation for ${CIRCUIT_ID}: ${postOp !== undefined ? 'DEFINED ✅' : 'UNDEFINED ❌ (unexpected)'}`);

    // FinalizedTxData is FLAT: { tx, status, txId, txIds, ... }.
    // (Deploy tx's DeployedContract nests it under .deployTxData.public, but
    // submitInsertVerifierKeyTx returns FinalizedTxData directly.)
    return {
      contractAddress,
      circuitId: CIRCUIT_ID,
      txHash: result?.txId ?? result?.public?.txId ?? 'unknown',
      txStatus: result?.status ?? 'unknown',
      dur: Number(dur),
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

function ensureArtifactsDir() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function persistRolledIn(circuitId) {
  // Append this circuit to deployment.json.circuitsRolledIn (idempotent).
  try {
    const d = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
    const arr = new Set(d.circuitsRolledIn || []);
    arr.add(circuitId);
    d.circuitsRolledIn = [...arr];
    fs.writeFileSync(DEPLOYMENT_JSON_PATH, JSON.stringify(d, null, 2));
    log(`updated deployment.json.circuitsRolledIn (${d.circuitsRolledIn.length} total)`);
  } catch (err) {
    log(`WARN: could not update deployment.json.circuitsRolledIn: ${err?.message}`);
  }
}

function writeManifest(result, wasDryRun) {
  ensureArtifactsDir();
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const artifactPath = path.join(ARTIFACTS_DIR, `vk-insert-${CIRCUIT_ID}-${stamp}.json`);
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        schemaVersion: '1',
        generatedAt: new Date().toISOString(),
        mode: wasDryRun ? 'dry-run' : 'live',
        network: 'preview',
        operation: 'insertVerifierKey',
        contractAddress: result.contractAddress,
        circuitId: result.circuitId,
        txHash: result.txHash,
        txStatus: result.txStatus,
        durSeconds: result.dur,
        entry: `insert-vk-${CIRCUIT_ID}.mjs`,
      },
      null,
      2,
    ),
  );
  log(`wrote manifest: ${artifactPath}`);
}

async function main() {
  log(`start: ${new Date().toISOString()}`);
  log(`mode: ${DRY_RUN ? 'dry-run' : 'live preview'}`);
  log(`full v8 build: ${FULL_BUILD_DIR}`);
  log(`deployment.json: ${DEPLOYMENT_JSON_PATH}`);

  const result = await insertOrDryRun();
  writeManifest(result, DRY_RUN);
  if (!DRY_RUN) persistRolledIn(CIRCUIT_ID);
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
