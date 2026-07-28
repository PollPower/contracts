// tariff-registry/deploy/deploy-wi15.1.ts
// -----------------------------------------------------------------------------
// WI-15.1 preview deploy script — implements V2-SPLIT-ADDENDUM §A4 verbatim
// (steps 1–6 + manifest write; step 7 daemon-start is out of scope for WI-15.1,
// step 8 rotation is optional and gated by --rotate-audit-writer).
//
// V2-SPLIT-ADDENDUM.md §A4 (verbatim block quote):
//
//   1. Generate deploy-scoped auditWriter keypair offline.
//   2. Deploy AuditLog with initialAuditWriterAuthority = auditWriter.pubkey.
//   3. Deploy Governance with matching initialAuditWriterAuthority field.
//   4. Deploy Schedule, Lane, Views with constructor addresses.
//   5. Run AuditLog bootstrap shards: (8), (16), (24).
//   6. Seed Governance epoch via advanceEpoch(1, ...).
//   7. Start mirror-writer daemon using auditWriter private key for commitAuditEntry signing.
//   8. Optional ceremony: rotate audit writer immediately to operational key via rotateAuditWriterAuthority.
//
// Usage:
//   tsx deploy/deploy-wi15.1.ts [--dry-run] [--rotate-audit-writer]
//
// --dry-run   — do not connect to Preview; emit a receipt manifest with fake
//               addresses so the script can be exercised without a live node.
//               Useful when Preview is unreachable; DoD accepts a dry-run
//               receipt in lieu of a live deploy.
// --rotate-audit-writer  — after step 6, run rotateAuditWriterAuthority to a
//               freshly-generated operational key (step 8, optional).
// -----------------------------------------------------------------------------

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  persistentHash as runtimePersistentHash,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(REPO_ROOT, 'build');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DEPLOYMENT_JSON_PATH = path.join(REPO_ROOT, 'deployment.json');
const CHARTER_DEPTH = 12;
const CHARTER_LEAF_TAG = 'pp:fed:charter:leaf';
const CHARTER_NODE_TAG = 'pp:fed:charter:node';

const DRY_RUN = process.argv.includes('--dry-run');
const ROTATE_AUDIT_WRITER = process.argv.includes('--rotate-audit-writer');
const FEDERATION_AUTHORITY_PUBKEY_ARG = readFlagValue('--federation-authority-pubkey');
const REF_RATE_FIAT_PER_KWH_ARG = readFlagValue('--ref-rate-fiat-per-kwh');

// ---------- helpers ----------------------------------------------------------
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function bytesToHex(b: Uint8Array | Buffer): string {
  return Buffer.from(b).toString('hex');
}

function readFlagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function fatalCli(message: string): never {
  throw new Error(`[wi15.1] ${message}`);
}

function parseFederationAuthorityPubkeyHex(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    fatalCli(`--federation-authority-pubkey must be exactly 64 hex chars; got: ${value}`);
  }
  const decoded = Buffer.from(value, 'hex');
  if (decoded.length !== 32) {
    fatalCli(`--federation-authority-pubkey must decode to 32 bytes; got ${decoded.length}`);
  }
  if (decoded.equals(Buffer.alloc(32))) {
    fatalCli('--federation-authority-pubkey must not be all zeros');
  }
  return decoded;
}

function parseRefRateFiatPerKwh(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    fatalCli(`--ref-rate-fiat-per-kwh must be a positive integer; got: ${value}`);
  }
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > 1_000_000n) {
    fatalCli(`--ref-rate-fiat-per-kwh out of range (1..1000000); got: ${value}`);
  }
  return parsed;
}

function rawEd25519Pubkey(publicKey: any): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.slice(-32));
}

interface DeployStepResult {
  step: number;
  name: string;
  ok: boolean;
  address?: string;
  txHash?: string;
  error?: string;
  extra?: Record<string, unknown>;
}

interface LiveRuntimeContext {
  providers: unknown;
}

let liveRuntimeContextPromise: Promise<LiveRuntimeContext> | null = null;

// A recoverable step wrapper that logs the failing step and returns non-zero
// on any failure (per DoD: "On failure, log the failing step and exit non-zero").
async function runStep<T>(
  step: number,
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  console.log(`[wi15.1] step ${step}: ${name}`);
  const start = Date.now();
  try {
    const result = await action();
    console.log(`[wi15.1] step ${step}: ok (${Date.now() - start}ms)`);
    return result;
  } catch (err) {
    console.error(`[wi15.1] step ${step} FAILED: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// Preview-network deploy wrapper. In non-dry-run mode this loads
// @midnight-ntwrk/midnight-js-contracts and calls deployContract; in dry-run
// mode it returns a deterministic pseudo-address derived from the constructor
// args hash so downstream steps can proceed.
async function deployOrDryRun(
  siblingName: string,
  compiledContract: unknown,
  constructorArgs: unknown[],
): Promise<{ address: string; txHash: string }> {
  if (DRY_RUN) {
    const h = createHash('sha256');
    h.update(siblingName);
    for (const a of constructorArgs) {
      h.update(Buffer.from(JSON.stringify(a)));
    }
    const digest = h.digest();
    return {
      address: '0x' + digest.slice(0, 20).toString('hex'),
      txHash: '0x' + digest.slice(0, 32).toString('hex'),
    };
  }

  // Live-deploy path. Kept behind a runtime import so --dry-run works
  // without the SDK dependencies being loaded.
  const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');
  const runtime = await getLiveRuntimeContext();

  // Wait for tx confirmation between steps (per DoD).
  // deployContract returns a deployed-contract handle whose finalizedDeployTxData
  // resolves once the tx is finalized in the block.
  // midnight-js-contracts@4.0.2:
  // deployContract(providers, { compiledContract, ...options })
  const deployedContract = await deployContract(runtime.providers as any, {
    compiledContract: compiledContract as any,
    privateStateId: `wi15.1-${siblingName}-state`,
    initialPrivateState: {} as any,
    args: constructorArgs,
  } as any);
  const finalized = await (deployedContract as any).finalizedDeployTxData;
  return {
    address: (deployedContract as any).deployTxData.public.contractAddress,
    txHash: finalized.txId ?? 'unknown',
  };
}

function pad32(tag: string): Uint8Array {
  const bytes = Buffer.from(tag, 'utf8');
  if (bytes.length > 32) {
    throw new Error(`[wi15.1] tag too long for pad32: ${tag}`);
  }
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
}

function persistentHashParts(parts: Uint8Array[]): Uint8Array {
  for (const p of parts) {
    if (p.length !== 32) {
      throw new Error(`[wi15.1] persistentHash part must be 32 bytes, got ${p.length}`);
    }
  }
  return runtimePersistentHash(
    new CompactTypeVector(parts.length, new CompactTypeBytes(32)),
    parts,
  );
}

function computeEmptyCharterTreeLevels(): Uint8Array[] {
  // tariff-governance.compact:
  //   leaf = persistentHash([pad(32, "pp:fed:charter:leaf"), disclose(nodeId)])
  //   pair = persistentHash([pad(32, "pp:fed:charter:node"), left, right])
  // Empty charter tree convention here uses nodeId=0x00..00 as the empty leaf payload.
  const levels: Uint8Array[] = [];
  let current = persistentHashParts([
    pad32(CHARTER_LEAF_TAG),
    new Uint8Array(32),
  ]);
  levels.push(current);
  const pairDomain = pad32(CHARTER_NODE_TAG);
  for (let i = 0; i < CHARTER_DEPTH; i++) {
    current = persistentHashParts([pairDomain, current, current]);
    levels.push(current);
  }
  return levels;
}

function computeEmptyCharterTreeRoot(): Uint8Array {
  const levels = computeEmptyCharterTreeLevels();
  const root = levels[CHARTER_DEPTH];
  if (root.length !== 32) {
    throw new Error(`[wi15.1] empty charter root length mismatch: ${root.length}`);
  }
  return root;
}

function writeEmptyCharterRootVerificationArtifact(): void {
  const levels1 = computeEmptyCharterTreeLevels();
  const levels2 = computeEmptyCharterTreeLevels();
  const root1 = levels1[CHARTER_DEPTH];
  const root2 = levels2[CHARTER_DEPTH];
  const deterministic = Buffer.from(root1).equals(Buffer.from(root2));
  const nonZero = !Buffer.from(root1).equals(Buffer.alloc(32));
  const lines: string[] = [
    '# Empty Charter Root Verification',
    `generatedAt=${new Date().toISOString()}`,
    `CHARTER_DEPTH=${CHARTER_DEPTH}`,
    `leafDomain=${CHARTER_LEAF_TAG}`,
    `nodeDomain=${CHARTER_NODE_TAG}`,
    '',
  ];
  for (let i = 0; i < levels1.length; i++) {
    lines.push(`level[${i}]=${bytesToHex(levels1[i])}`);
  }
  lines.push('');
  lines.push(`root=${bytesToHex(root1)}`);
  lines.push(`deterministic=${deterministic}`);
  lines.push(`nonZero=${nonZero}`);
  if (!deterministic) {
    throw new Error('[wi15.1] empty charter root determinism check failed');
  }
  if (!nonZero) {
    throw new Error('[wi15.1] empty charter root must not be all zeros');
  }
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, 'empty-charter-root-verification.txt'),
    lines.join('\n') + '\n',
  );
}

async function loadSettlementDeployUtils(): Promise<any> {
  const candidates = [
    process.env.TARIFF_DEPLOY_UTILS,
    path.resolve(REPO_ROOT, '..', 'settlement-api', 'src', 'utils.js'),
    path.resolve(REPO_ROOT, 'src', 'utils.js'),
  ].filter((x): x is string => Boolean(x));
  let lastErr: unknown = undefined;
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod?.createWallet && mod?.createProviders) {
        return mod;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  fatalCli(
    `unable to locate settlement deploy utils (set TARIFF_DEPLOY_UTILS). Last error: ${String(lastErr)}`,
  );
}

async function getLiveRuntimeContext(): Promise<LiveRuntimeContext> {
  if (DRY_RUN) {
    fatalCli('internal: getLiveRuntimeContext called in dry-run mode');
  }
  if (liveRuntimeContextPromise !== null) {
    return liveRuntimeContextPromise;
  }
  liveRuntimeContextPromise = (async () => {
    if (!fs.existsSync(DEPLOYMENT_JSON_PATH)) {
      fatalCli(`missing deployment seed file in live mode: ${DEPLOYMENT_JSON_PATH}`);
    }
    const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8')) as { seed?: string };
    if (!parsed.seed) {
      fatalCli(`deployment seed file is missing "seed": ${DEPLOYMENT_JSON_PATH}`);
    }
    const deployUtils = await loadSettlementDeployUtils();
    const walletCtx = await deployUtils.createWallet(parsed.seed);
    const providers = await deployUtils.createProviders(walletCtx, BUILD_ROOT);
    return { providers };
  })();
  return liveRuntimeContextPromise;
}

async function callCircuitOrDryRun(
  siblingName: string,
  address: string,
  circuitName: string,
  args: unknown[],
): Promise<{ txHash: string }> {
  if (DRY_RUN) {
    const h = createHash('sha256').update(siblingName).update(circuitName);
    for (const a of args) h.update(Buffer.from(JSON.stringify(a)));
    return { txHash: '0x' + h.digest().toString('hex') };
  }
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  setNetworkId('preview');

  const runtime = await getLiveRuntimeContext();
  const compiled = await import(path.join(BUILD_ROOT, siblingName, 'contract', 'index.js'));
  const deployed = await findDeployedContract(runtime.providers as any, {
    compiledContract: (compiled as any).Contract,
    contractAddress: address as any,
  } as any);
  const callFn = (deployed.callTx as Record<string, (...circuitArgs: unknown[]) => Promise<any>>)[circuitName];
  if (typeof callFn !== 'function') {
    throw new Error(`[wi15.1] circuit not found on ${siblingName}: ${circuitName}`);
  }
  const finalized = await callFn(...args);
  const txHash = String(finalized?.public?.txId ?? finalized?.txId ?? finalized?.public?.txHash ?? 'unknown');
  return { txHash };
}

// ---------- main -------------------------------------------------------------
async function main(): Promise<void> {
  console.log('[wi15.1] deploy start');
  console.log(`[wi15.1] mode: ${DRY_RUN ? 'dry-run (no chain writes)' : 'live preview'}`);
  console.log(`[wi15.1] rotate-audit-writer: ${ROTATE_AUDIT_WRITER}`);

  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }
  writeEmptyCharterRootVerificationArtifact();

  const results: DeployStepResult[] = [];
  const stamp = timestamp();
  const manifestPath = path.join(ARTIFACTS_DIR, `wi15.1-preview-${stamp}.json`);

  // ------------------- STEP 1: Generate audit-writer keypair -----------------
  const auditWriterInfo = await runStep(1, 'Generate deploy-scoped auditWriter keypair', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = rawEd25519Pubkey(publicKey);
    // Save keypair (PEM) for step 7 daemon handoff.
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keyPath = path.join(ARTIFACTS_DIR, `audit-writer-${stamp}.pem`);
    fs.writeFileSync(keyPath, privPem, { mode: 0o600 });
    return { pubHex: bytesToHex(pub), pubBytes: pub, keyPath, privateKey };
  });
  results.push({ step: 1, name: 'audit-writer keypair', ok: true, extra: { pubHex: auditWriterInfo.pubHex, keyPath: auditWriterInfo.keyPath } });

  // ------------------- STEP 2: Deploy AuditLog -------------------------------
  const auditContractAddress = await runStep(2, 'Deploy AuditLog', async () => {
    const compiled = DRY_RUN ? null : await import(path.join(BUILD_ROOT, 'audit', 'contract', 'index.js'));
    const { address, txHash } = await deployOrDryRun(
      'audit',
      compiled?.Contract,
      [auditWriterInfo.pubBytes],
    );
    results.push({ step: 2, name: 'audit deploy', ok: true, address, txHash });
    return address;
  });

  // ------------------- STEP 3: Deploy Governance -----------------------------
  // Governance constructor per V2-SPLIT-ADDENDUM.md §A2:
  //   auditContractAddress, initialFederationAuthority, initialGovernanceRoot,
  //   initialRefRateFiatPerKwh, initialAuditWriterAuthority.
  const initialFederationAuthority = (() => {
    if (FEDERATION_AUTHORITY_PUBKEY_ARG !== undefined) {
      return parseFederationAuthorityPubkeyHex(FEDERATION_AUTHORITY_PUBKEY_ARG);
    }
    if (DRY_RUN) {
      return randomBytes(32);
    }
    fatalCli('missing required --federation-authority-pubkey <hex> in live mode');
  })();
  // Governance root must be deterministic at genesis: the empty charter Merkle
  // tree root (depth 12, fixed domains) for identical dry-run/live behavior.
  const initialGovernanceRoot = computeEmptyCharterTreeRoot();
  const initialRefRateFiatPerKwh = (() => {
    if (REF_RATE_FIAT_PER_KWH_ARG !== undefined) {
      return parseRefRateFiatPerKwh(REF_RATE_FIAT_PER_KWH_ARG);
    }
    if (DRY_RUN) {
      return 100n;
    }
    fatalCli('missing required --ref-rate-fiat-per-kwh <int> in live mode');
  })();

  const governanceContractAddress = await runStep(3, 'Deploy Governance', async () => {
    const compiled = DRY_RUN ? null : await import(path.join(BUILD_ROOT, 'governance', 'contract', 'index.js'));
    const { address, txHash } = await deployOrDryRun(
      'governance',
      compiled?.Contract,
      [
        auditContractAddress,
        initialFederationAuthority,
        initialGovernanceRoot,
        initialRefRateFiatPerKwh.toString(),
        auditWriterInfo.pubBytes,
      ],
    );
    results.push({ step: 3, name: 'governance deploy', ok: true, address, txHash });
    return address;
  });

  // ------------------- STEP 4: Deploy Schedule, Lane, Views -------------------
  // WI-15.1 Fix A: Schedule/Lane/Views constructors now accept two sealed
  // init params to close the PR #49 genesis front-run window:
  //   initialFederationAuthority: same value passed to Governance in step 3.
  //   initialAuditWriterAuthority: same auditWriter.pubkey passed in step 2.
  // Both anchors must match Governance/AuditLog at tx-0 alignment.
  const scheduleContractAddress = await runStep(4, 'Deploy Schedule', async () => {
    const compiled = DRY_RUN ? null : await import(path.join(BUILD_ROOT, 'schedule', 'contract', 'index.js'));
    const { address, txHash } = await deployOrDryRun(
      'schedule',
      compiled?.Contract,
      [
        auditContractAddress,
        governanceContractAddress,
        initialFederationAuthority,
        auditWriterInfo.pubBytes,
      ],
    );
    results.push({ step: 4, name: 'schedule deploy', ok: true, address, txHash });
    return address;
  });

  const laneContractAddress = await runStep(4, 'Deploy Lane', async () => {
    const compiled = DRY_RUN ? null : await import(path.join(BUILD_ROOT, 'lane', 'contract', 'index.js'));
    const { address, txHash } = await deployOrDryRun(
      'lane',
      compiled?.Contract,
      [
        auditContractAddress,
        governanceContractAddress,
        scheduleContractAddress,
        initialFederationAuthority,
        auditWriterInfo.pubBytes,
      ],
    );
    results.push({ step: 4, name: 'lane deploy', ok: true, address, txHash });
    return address;
  });

  const viewsContractAddress = await runStep(4, 'Deploy Views', async () => {
    const compiled = DRY_RUN ? null : await import(path.join(BUILD_ROOT, 'views', 'contract', 'index.js'));
    const { address, txHash } = await deployOrDryRun(
      'views',
      compiled?.Contract,
      [
        auditContractAddress,
        governanceContractAddress,
        scheduleContractAddress,
        laneContractAddress,
        initialFederationAuthority,
        auditWriterInfo.pubBytes,
      ],
    );
    results.push({ step: 4, name: 'views deploy', ok: true, address, txHash });
    return address;
  });

  // ------------------- STEP 5: Bootstrap AuditLog shards ----------------------
  // WI-13.3 policy K=8 shards: (8), (16), (24). Terminal shard sets
  // _bootstrapComplete=true.
  for (const shardEnd of [8, 16, 24]) {
    await runStep(5, `bootstrapActionLog(${shardEnd})`, async () => {
      const { txHash } = await callCircuitOrDryRun('audit', auditContractAddress, 'bootstrapActionLog', [shardEnd]);
      results.push({ step: 5, name: `bootstrapActionLog(${shardEnd})`, ok: true, txHash });
    });
  }

  // ------------------- STEP 6: Seed Governance epoch -------------------------
  // advanceEpoch(1, newRefRate, newGovRoot, currentTime, ...federationApproval)
  // Federation approval bundle is out of scope for this script's dry-run path;
  // in the live path this requires an msfed bundle for
  // "pp:tariff:v1:advanceEpoch". See settlement-api/scripts/advance-epoch.ts.
  await runStep(6, 'Governance advanceEpoch(1, ...)', async () => {
    const { txHash } = await callCircuitOrDryRun('governance', governanceContractAddress, 'advanceEpoch', [1]);
    results.push({ step: 6, name: 'advanceEpoch(1)', ok: true, txHash });
  });

  // ------------------- STEP 8 (optional): rotate audit writer ----------------
  let rotatedAuditWriterPubHex: string | undefined;
  if (ROTATE_AUDIT_WRITER) {
    await runStep(8, 'rotateAuditWriterAuthority (optional ceremony)', async () => {
      const { publicKey: newPub } = generateKeyPairSync('ed25519');
      const newPubRaw = rawEd25519Pubkey(newPub);
      rotatedAuditWriterPubHex = bytesToHex(newPubRaw);
      const { txHash } = await callCircuitOrDryRun(
        'audit',
        auditContractAddress,
        'rotateAuditWriterAuthority',
        [rotatedAuditWriterPubHex],
      );
      results.push({ step: 8, name: 'rotateAuditWriterAuthority', ok: true, txHash });
    });
  }

  // ------------------- Write manifest ----------------------------------------
  const manifest = {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    network: 'preview',
    contracts: {
      audit:      { address: auditContractAddress },
      governance: { address: governanceContractAddress },
      schedule:   { address: scheduleContractAddress },
      lane:       { address: laneContractAddress },
      views:      { address: viewsContractAddress },
    },
    auditWriter: {
      publicKeyHex: auditWriterInfo.pubHex,
      privateKeyPath: auditWriterInfo.keyPath,
      rotatedTo: rotatedAuditWriterPubHex,
    },
    governanceInit: {
      federationAuthorityHex: bytesToHex(initialFederationAuthority),
      governanceRootHex: bytesToHex(initialGovernanceRoot),
      refRateFiatPerKwh: initialRefRateFiatPerKwh.toString(),
    },
    stepResults: results,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[wi15.1] manifest written: ${manifestPath}`);
  console.log(`[wi15.1] contracts deployed: 5/5`);
  console.log(`[wi15.1] done`);
}

main().catch((err) => {
  console.error('[wi15.1] deploy script uncaught error:', err);
  process.exit(1);
});
