// Deploy the ceremony-fenced tariff-registry monolith to Preview.
//
// - 7 KEEP circuits DEFINED at deploy: bootstrapActionLog, advanceEpoch,
//   registerSchedule, registerLane, isChartered, getActionEntry,
//   getActionPayloadHash.
// - 11 DEFER circuits UNDEFINED at deploy — will be vk-inserted post-deploy:
//   retireSchedule, setNationalContext, setFederationAuthority, retireLane,
//   retuneClass, resolvePath, resolveCurrent, isScheduleActive, resolveLane,
//   resolveLanes, isLaneActive.
// - After deploy, calls bootstrapActionLog(8n), (16n), (24n) in three
//   separate txs to complete the WI-13.3 sharded action-log initialization.
//
// Pure ESM (.mjs) run via plain `node` per L12.
//
// Reads: build-ceremony/contract/index.js + build-ceremony/keys/*
// Writes: deploy/artifacts/monolith-preview-<stamp>.json
//         updates deployment.json to add contractAddress
// Args to constructor:
//   federationAuthority = f41fdb102441fda7eddd2d96e6920e6a9cd033ff110fc98c6594043c68391ba1
//   governanceRoot      = 4cb81c2f523a8c81cdddfc9a5a3bce6085bdd89b6822ca3b70ef7c315a37b40e
//   refRateFiatPerKwh   = 28n

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'buffer';
import * as Rx from 'rxjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARIFF_ROOT = '/home/pollpower/contracts/tariff-registry';
const BUILD_DIR = path.join(TARIFF_ROOT, 'build-ceremony');
const CONTRACT_INDEX = path.join(BUILD_DIR, 'contract', 'index.js');
const DEPLOYMENT_JSON = path.join(TARIFF_ROOT, 'deployment.json');
const ARTIFACTS_DIR = path.join(TARIFF_ROOT, 'deploy', 'artifacts');
const DEPLOY_UTILS = path.join(TARIFF_ROOT, 'deploy', 'deploy-utils.mjs');

const FEDERATION_AUTHORITY_HEX = 'f41fdb102441fda7eddd2d96e6920e6a9cd033ff110fc98c6594043c68391ba1';
const GOVERNANCE_ROOT_HEX      = '4cb81c2f523a8c81cdddfc9a5a3bce6085bdd89b6822ca3b70ef7c315a37b40e';
const REF_RATE_FIAT_PER_KWH    = 28n;
const CHARTER_NODE_ID_HEX      = '96a0e3b3020797f3e5ffd0687834564427b88f084c5b3e424526b492a66a0d0c';

const KEEP_CIRCUITS = [
  'bootstrapActionLog',
  'advanceEpoch',
  'registerSchedule',
  'registerLane',
  'isChartered',
  'getActionEntry',
  'getActionPayloadHash',
];

const DEFER_CIRCUITS = [
  'retireSchedule',
  'setNationalContext',
  'setFederationAuthority',
  'retireLane',
  'retuneClass',
  'resolvePath',
  'resolveCurrent',
  'isScheduleActive',
  'resolveLane',
  'resolveLanes',
  'isLaneActive',
];

function log(...args) { console.log('[deploy-monolith-ceremony]', ...args); }
function fatal(msg) { console.error('[deploy-monolith-ceremony] FATAL:', msg); process.exit(1); }

function hexToBytes(hex) {
  if (typeof hex !== 'string') throw new Error('hexToBytes: not string');
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0) throw new Error('hexToBytes: odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  log('start:', new Date().toISOString());
  log('build dir:', BUILD_DIR);

  if (!fs.existsSync(CONTRACT_INDEX)) fatal(`missing ${CONTRACT_INDEX}`);
  if (!fs.existsSync(DEPLOYMENT_JSON)) fatal(`missing ${DEPLOYMENT_JSON}`);
  if (!fs.existsSync(DEPLOY_UTILS)) fatal(`missing ${DEPLOY_UTILS} — run esbuild first`);

  const deploymentJson = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON, 'utf8'));
  if (!deploymentJson.seed) fatal('deployment.json missing "seed"');

  // Idempotence guard: if a monolith-ceremony contractAddress already exists,
  // refuse to redeploy — a fresh redeploy needs an explicit deployment.json edit.
  if (deploymentJson.contractAddress && deploymentJson.contractAddressKind === 'monolith-ceremony') {
    log(`idempotent exit: existing monolith-ceremony contractAddress=${deploymentJson.contractAddress}`);
    return;
  }

  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');

  const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const deployUtils = await import(pathToFileURL(DEPLOY_UTILS).href);

  log('loading contract build:', CONTRACT_INDEX);
  const buildModule = await import(pathToFileURL(CONTRACT_INDEX).href);

  // Minimal witnesses — the ceremony deploy path only calls the constructor +
  // bootstrapActionLog. Neither uses signature_valid / multisig_signature_valid /
  // charter_membership_proof / action_log_path_bits. Provide dummies that return
  // false / empty so the compiled contract still resolves witness references.
  const witnesses = {
    signature_valid(ctx, _pubkey, _msg, _sig) { return [ctx.privateState, false]; },
    multisig_signature_valid(ctx, _payload, _auth) { return [ctx.privateState, false]; },
    charter_membership_proof(ctx, _nodeId) {
      return [ctx.privateState, {
        siblings: Array.from({ length: 12 }, () => new Uint8Array(32)),
        indices: Array.from({ length: 12 }, () => false),
      }];
    },
    witness_divmod(ctx, num, div) {
      if (div === 0n) return [ctx.privateState, { quotient: 0n, remainder: 0n }];
      return [ctx.privateState, { quotient: num / div, remainder: num % div }];
    },
    action_log_path_bits(ctx, _seq) {
      // 24 zero bits — sufficient for bootstrap which doesn't read the returned bits meaningfully
      return [ctx.privateState, Array.from({ length: 24 }, () => false)];
    },
  };

  const compiled = CompiledContract.make('tariff-registry-monolith-ceremony', buildModule.Contract)
    .pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(BUILD_DIR),
    );

  log('creating wallet...');
  const walletCtx = await deployUtils.createWallet(deploymentJson.seed);
  log('waiting for wallet sync...');
  const walletState = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.throttleTime(5000), Rx.filter((s) => s.isSynced)),
  );
  const deployerBech32 = walletCtx.unshieldedKeystore.getBech32Address();
  log('wallet synced. deployer bech32:', deployerBech32);
  // Best-effort balance sniff (structure of state.unshielded varies; keep noisy but safe)
  try {
    const ub = walletState?.unshielded?.balances ?? walletState?.balances ?? '(state schema unknown)';
    log('balance snapshot:', JSON.stringify(ub, (_k, v) => typeof v === 'bigint' ? String(v) : v).slice(0, 500));
  } catch (_) { /* nonfatal */ }

  const providers = await deployUtils.createProviders(walletCtx, BUILD_DIR);

  const federationAuthority = hexToBytes(FEDERATION_AUTHORITY_HEX);
  const governanceRoot = hexToBytes(GOVERNANCE_ROOT_HEX);
  if (federationAuthority.length !== 32) fatal('federationAuthority not 32 bytes');
  if (governanceRoot.length !== 32) fatal('governanceRoot not 32 bytes');

  log('deploying contract...');
  const deployT0 = Date.now();
  const deployed = await deployContract(providers, {
    compiledContract: compiled,
    args: [federationAuthority, governanceRoot, REF_RATE_FIAT_PER_KWH],
    privateStateId: 'tariff-registry-monolith-ceremony-preview-state',
    initialPrivateState: {},
  });
  const deployElapsed = Date.now() - deployT0;
  const contractAddress = deployed.deployTxData?.public?.contractAddress ?? deployed.deployTxData?.contractAddress;
  const deployTxHash = deployed.deployTxData?.public?.txId
    ?? deployed.deployTxData?.public?.txHash
    ?? deployed.deployTxData?.txId
    ?? deployed.deployTxData?.txHash
    ?? 'unknown';
  if (!contractAddress) {
    fatal('deployContract returned no contractAddress');
  }
  log(`deployed at ${contractAddress} in ${deployElapsed}ms (txHash=${deployTxHash})`);

  // WI-13.3 sharded bootstrap: three separate txs, cursor 0 → 8 → 16 → 24.
  log('bootstrap shard 1/3: bootstrapActionLog(8n)');
  const b1 = Date.now();
  const bootstrap1 = await deployed.callTx.bootstrapActionLog(8n);
  log(`  shard 1 done in ${Date.now() - b1}ms`);

  log('bootstrap shard 2/3: bootstrapActionLog(16n)');
  const b2 = Date.now();
  const bootstrap2 = await deployed.callTx.bootstrapActionLog(16n);
  log(`  shard 2 done in ${Date.now() - b2}ms`);

  log('bootstrap shard 3/3 (terminal): bootstrapActionLog(24n)');
  const b3 = Date.now();
  const bootstrap3 = await deployed.callTx.bootstrapActionLog(24n);
  log(`  shard 3 done in ${Date.now() - b3}ms`);

  // Assemble manifest
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const manifestPath = path.join(ARTIFACTS_DIR, `monolith-preview-${stamp}.json`);

  const auditWriterPemPath = path.join(ARTIFACTS_DIR, 'audit-writer-2026-07-31T03-55-44-865Z.pem');
  const auditWriterPubkey = '3e64530c332524b85a8d4c53e2699392da6dc31a4080c5a2f1655261179ca6af';

  const manifest = {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    network: 'preview',
    contractKind: 'monolith-ceremony',
    contractAddress,
    deployTxHash,
    deployElapsedMs: deployElapsed,
    bootstrapActionLog: {
      shard1TxIds: bootstrap1?.public?.txIds ?? [],
      shard2TxIds: bootstrap2?.public?.txIds ?? [],
      shard3TxIds: bootstrap3?.public?.txIds ?? [],
    },
    constructorArgs: {
      federationAuthorityHex: FEDERATION_AUTHORITY_HEX,
      governanceRootHex: GOVERNANCE_ROOT_HEX,
      refRateFiatPerKwh: String(REF_RATE_FIAT_PER_KWH),
    },
    governanceInit: {
      governanceRootHex: GOVERNANCE_ROOT_HEX,
      charterNodeIdHex: CHARTER_NODE_ID_HEX,
      federationAuthorityHex: FEDERATION_AUTHORITY_HEX,
    },
    circuits: {
      total: KEEP_CIRCUITS.length + DEFER_CIRCUITS.length,
      keep: KEEP_CIRCUITS,
      defer: DEFER_CIRCUITS,
    },
    auditWriter: {
      publicKeyHex: auditWriterPubkey,
      privateKeyPath: auditWriterPemPath,
    },
    deployWallet: {
      deployerBech32,
    },
    totalElapsedMs: Date.now() - t0,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log('wrote manifest:', manifestPath);

  // Update deployment.json to record the current live address
  const newDeployment = {
    ...deploymentJson,
    contractAddress,
    contractAddressKind: 'monolith-ceremony',
    contractAddressSetAt: manifest.generatedAt,
  };
  // backup then write
  fs.writeFileSync(DEPLOYMENT_JSON + '.pre-monolith-ceremony-backup', JSON.stringify(deploymentJson, null, 2));
  fs.writeFileSync(DEPLOYMENT_JSON, JSON.stringify(newDeployment, null, 2));
  log('updated deployment.json (backup at .pre-monolith-ceremony-backup)');

  log(`✅ DONE in ${Date.now() - t0}ms — address ${contractAddress}`);
}

main().catch((err) => {
  console.error('[deploy-monolith-ceremony] FAILED');
  console.error('  message:', err?.message);
  console.error('  cause:  ', err?.cause?.message);
  console.error('  stack:  ', err?.stack?.split('\n').slice(0, 15).join('\n'));
  process.exit(1);
});
