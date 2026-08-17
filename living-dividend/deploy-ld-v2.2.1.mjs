// deploy-ld-v2.2.1.mjs — deploy the Living Dividend v2.2.1 contract to Preview.
//
// Modeled EXACTLY on ~/contracts/ebt/deploy-ebt-v8-ceremony.mjs. Differences:
//   1. BUILD_DIR -> living-dividend/build/v2.2.1 (9 circuits: register,
//      unregister, setMultisigAuthority, bumpOnMint, claim, executePayout,
//      touchLiveness, proposePrune, executePrune).
//   2. contract name          -> 'ld-v2.2.1'.
//   3. privateStateId         -> 'ld-v2.2.1-state'.
//   4. Constructor takes TWO Bytes<32> args (EBT deploy passed args:[]):
//        args: [ebtColor, multisigAuthority]
//      Both are raw 32-byte Uint8Arrays (same Bytes<32> encoding
//      initialize-ebt-v8.mjs uses for its byte args — hexToBytes -> Uint8Array).
//   5. Witness map: the compiled LD contract REQUIRES 4 function-valued
//      witness fields (witness_divmod, witness_multisigSignatureValid,
//      witness_memberSignatureValid, witness_blockTimeGte). deployContract
//      only needs those names present (it runs the constructor, which does
//      NOT invoke any of them — it just stores the two Bytes<32> args). So we
//      bind a minimal stub with all 4 names, mirroring the EBT deploy's
//      2-name stub. A keeper doing real mutating calls must instead bind the
//      real prover-side impls from witnesses.ts (makeLdWitnesses()).
//
// Values (from sibling prep scripts — see report):
//   ebtColor          = persistentCommit([pad32("pollpower:ebt:v8:epoch1"),
//                       ebtV8AddrBytes], pad32("midnight:derive_token"))
//   multisigAuthority = SHA-256(concat(sorted MOCK ring pubkeys))  [TEST-ONLY]
//
// Supports --dry-run (short-circuits BEFORE deployContract, like the EBT script).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LD_ROOT = '/home/pollpower/contracts/living-dividend';
const EBT_ROOT = '/home/pollpower/contracts/ebt';
const REPO_ROOT = path.resolve(LD_ROOT, '..');
const BUILD_DIR = path.join(LD_ROOT, 'build', 'v2.2.1');
// Deploy wallet seed lives in the EBT deployment.json (parent supplies it).
const DEPLOYMENT_JSON_PATH = path.join(EBT_ROOT, 'deployment.json');
const LD_DEPLOYMENT_JSON_PATH = path.join(LD_ROOT, 'ld-deployment.json');
const MOCK_KEYS_PATH = path.join(LD_ROOT, 'mock-multisig-keys.json');
const ARTIFACTS_DIR = path.join(LD_ROOT, 'deploy-artifacts');

const DRY_RUN = process.argv.includes('--dry-run');

// ---- Constructor arg values -------------------------------------------------
// ebtColor: MUST equal EBT v8's internal unshielded token color. Precomputed by
// compute-ebt-color.mjs; verified byte-faithful to the compiled EBT v8 contract.
const EBT_COLOR_HEX =
  '3862ec542440e4d3c591fa0c72c46cab0402b6f15114be6b0a51d1d341e6795c';
// multisigAuthority: MOCK/TEST-ONLY. Read from mock-multisig-keys.json if present
// (so regenerating the ring updates the deploy automatically); else use this
// pinned fallback (matches the ring generated 2026-08-17).
const MULTISIG_AUTHORITY_HEX_FALLBACK =
  'cb564026d1028c0c7cd3c22512f0e302df28fd05ba8939bf230010546c479cb4';

function fatal(msg) {
  console.error(`[deploy-ld-v2.2.1] FATAL: ${msg}`);
  process.exit(1);
}
function log(msg) {
  console.log(`[deploy-ld-v2.2.1] ${msg}`);
}

function hexToBytes32(hex) {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length !== 64) fatal(`hex expected 64 chars (32 bytes), got ${hex.length}: ${hex.slice(0, 12)}...`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

// Minimal deploy-time witness stub: all 4 names the compiled contract requires,
// as no-op functions. deployContract's constructor path never calls them.
function makeDeployWitnesses() {
  return {
    witness_divmod: (ctx, _num, _div) => [ctx.privateState, { quotient: 0n, remainder: 0n }],
    witness_multisigSignatureValid: (ctx, _payload, _auth) => [ctx.privateState, false],
    witness_memberSignatureValid: (ctx, _member, _payload) => [ctx.privateState, false],
    witness_blockTimeGte: (ctx, _t) => [ctx.privateState, false],
  };
}

function resolveConstructorArgs() {
  const ebtColor = hexToBytes32(EBT_COLOR_HEX);
  let multisigHex = MULTISIG_AUTHORITY_HEX_FALLBACK;
  if (fs.existsSync(MOCK_KEYS_PATH)) {
    try {
      const mk = JSON.parse(fs.readFileSync(MOCK_KEYS_PATH, 'utf8'));
      if (mk?.multisigAuthorityHex) multisigHex = mk.multisigAuthorityHex;
    } catch (e) {
      log(`WARN: could not parse ${MOCK_KEYS_PATH}: ${e.message}; using fallback authority`);
    }
  }
  const multisigAuthority = hexToBytes32(multisigHex);
  return { ebtColor, multisigAuthority, ebtColorHex: EBT_COLOR_HEX, multisigHex };
}

async function loadCompiledLdContract() {
  const jsPath = path.join(BUILD_DIR, 'contract', 'index.js');
  if (!fs.existsSync(jsPath)) fatal(`missing LD build at ${jsPath}`);
  const buildModule = await import(pathToFileURL(jsPath).href);
  if (typeof buildModule.Contract !== 'function' && typeof buildModule.Contract !== 'object') {
    fatal(`LD build ${jsPath} does not export Contract`);
  }
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const witnesses = makeDeployWitnesses();
  return CompiledContract.make('ld-v2.2.1', buildModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(BUILD_DIR),
  );
}

async function loadSettlementDeployUtils() {
  const candidates = [
    process.env.LD_DEPLOY_UTILS,
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
  fatal(`unable to locate settlement deploy utils. Last error: ${String(lastErr)}`);
}

async function getLiveProviders() {
  if (!fs.existsSync(DEPLOYMENT_JSON_PATH)) fatal(`missing deploy seed file: ${DEPLOYMENT_JSON_PATH}`);
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  if (!parsed.seed) fatal(`deployment.json missing "seed"`);
  const deployUtils = await loadSettlementDeployUtils();
  const walletCtx = await deployUtils.createWallet(parsed.seed);
  const providers = await deployUtils.createProviders(walletCtx, path.join(LD_ROOT, 'build'));
  if (typeof deployUtils.withZkConfigDir !== 'function') fatal(`deploy utils missing withZkConfigDir`);
  return { providers: deployUtils.withZkConfigDir(providers, BUILD_DIR), walletCtx };
}

async function deployOrDryRun() {
  const args = resolveConstructorArgs();
  log(`ebtColor          : ${args.ebtColorHex}`);
  log(`multisigAuthority : ${args.multisigHex}  (MOCK/TEST-ONLY)`);

  if (DRY_RUN) {
    // Exercise everything EXCEPT the on-chain submission:
    //  - load + validate the compiled contract (Contract export, witness bind,
    //    file assets), and
    //  - resolve the deploy-utils path (providers factory presence),
    // then short-circuit before deployContract (identical stance to the EBT script).
    log('DRY-RUN: loading compiled contract + binding witnesses...');
    const compiledContract = await loadCompiledLdContract();
    log(`DRY-RUN: compiled contract loaded, name='ld-v2.2.1', assets='${BUILD_DIR}'`);

    log('DRY-RUN: resolving deploy utils (providers factory) WITHOUT creating a wallet...');
    const deployUtils = await loadSettlementDeployUtils();
    const haveFactories = !!(deployUtils.createWallet && deployUtils.createProviders && deployUtils.withZkConfigDir);
    log(`DRY-RUN: deploy utils present: createWallet/createProviders/withZkConfigDir = ${haveFactories}`);

    log('DRY-RUN: constructor args encoded as Bytes<32> Uint8Array x2:');
    log(`DRY-RUN:   args[0] ebtColor          len=${args.ebtColor.length}`);
    log(`DRY-RUN:   args[1] multisigAuthority  len=${args.multisigAuthority.length}`);

    const h = createHash('sha256').update('ld-v2.2.1-dryrun').digest();
    return {
      address: '0x' + h.slice(0, 20).toString('hex'),
      txHash: '0x' + h.slice(0, 32).toString('hex'),
      dryRun: true,
      args,
    };
  }

  const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');

  log('loading providers (wallet + indexer + proof-server)...');
  const { providers, walletCtx } = await getLiveProviders();

  log('loading compiled LD contract with witness bindings...');
  const compiledContract = await loadCompiledLdContract();

  log('submitting deployContract to Preview...');
  const t0 = Date.now();
  try {
    const deployedContract = await deployContract(providers, {
      compiledContract,
      privateStateId: 'ld-v2.2.1-state',
      initialPrivateState: {},
      args: [args.ebtColor, args.multisigAuthority],
    });
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const deployTxData = deployedContract.deployTxData;
    const address = deployTxData.public.contractAddress;
    const txHash = deployTxData?.public?.txId ?? deployTxData?.public?.txHash ?? 'unknown';
    log(`deploy ok in ${dur}s`);
    return { address, txHash, walletCtx, args };
  } catch (err) {
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[deploy-ld-v2.2.1] deployContract failed after ${dur}s`);
    console.error('[deploy-ld-v2.2.1] err.message:', err?.message);
    console.error('[deploy-ld-v2.2.1] err.cause?.message:', err?.cause?.message);
    console.error('[deploy-ld-v2.2.1] err.stack (first 15 lines):', err?.stack?.split('\n').slice(0, 15).join('\n'));
    throw err;
  }
}

function ensureArtifactsDir() { fs.mkdirSync(ARTIFACTS_DIR, { recursive: true }); }

function persistDeployment(record) {
  const out = {
    contractVariant: 'ld-v2.2.1',
    network: 'preview',
    contractAddress: record.address,
    txHash: record.txHash,
    deployedAt: new Date().toISOString(),
    privateStateId: 'ld-v2.2.1-state',
    circuits: [
      'register', 'unregister', 'setMultisigAuthority', 'bumpOnMint', 'claim',
      'executePayout', 'touchLiveness', 'proposePrune', 'executePrune',
    ],
    constructorArgs: {
      ebtColorHex: record.args.ebtColorHex,
      multisigAuthorityHex: record.args.multisigHex,
      multisigAuthorityNote: 'MOCK/TEST-ONLY ring authority (mock-multisig-keys.json)',
    },
  };
  fs.writeFileSync(LD_DEPLOYMENT_JSON_PATH, JSON.stringify(out, null, 2));
  log(`wrote ${LD_DEPLOYMENT_JSON_PATH}`);
}

function writeArtifactManifest(record, wasDryRun) {
  ensureArtifactsDir();
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const artifactPath = path.join(ARTIFACTS_DIR, `ld-v2.2.1-preview-${stamp}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify({
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    mode: wasDryRun ? 'dry-run' : 'live',
    network: 'preview',
    variant: 'ld-v2.2.1',
    address: record.address,
    txHash: record.txHash,
    constructorArgs: {
      ebtColorHex: record.args.ebtColorHex,
      multisigAuthorityHex: record.args.multisigHex,
    },
    entry: 'deploy-ld-v2.2.1.mjs',
  }, null, 2));
  log(`wrote artifact manifest: ${artifactPath}`);
}

async function main() {
  log(`start: ${new Date().toISOString()}`);
  log(`mode: ${DRY_RUN ? 'dry-run' : 'live preview'}`);
  log(`build dir: ${BUILD_DIR}`);
  log(`deploy seed source: ${DEPLOYMENT_JSON_PATH}`);

  const result = await deployOrDryRun();
  log(`contractAddress: ${result.address}${result.dryRun ? ' (dry-run placeholder)' : ''}`);
  log(`txHash: ${result.txHash}${result.dryRun ? ' (dry-run placeholder)' : ''}`);

  if (!DRY_RUN) persistDeployment(result);
  writeArtifactManifest(result, DRY_RUN);
  log('DONE');

  if (result.walletCtx?.wallet?.close) {
    log('closing wallet...');
    await result.walletCtx.wallet.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[deploy-ld-v2.2.1] MAIN failed:', err?.message || err);
  process.exit(1);
});
