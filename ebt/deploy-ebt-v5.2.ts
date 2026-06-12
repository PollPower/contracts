// =============================================================================
// EBT v5.2 — DEPLOY to Midnight Preview
// =============================================================================
//
// Deploys the audit-hardened EBT v5.2 contract. Initialized with:
//   - _meterAuthorityPubkey: bf043807ba0112048d1ba073a47128bb094b3710036fe3da898fcd957fa6f09a
//     (the production Meter Authority Service running on relay)
//   - operationsRecipient / dividendRecipient / daoRecipient:
//     same deterministic placeholders as v5.1; rotate via owner action.
//
// PREREQUISITES:
//   1. Compile v5.2 with FULL ZK:
//      compactc.bin /path/to/ebt-v5.2.compact /path/to/build
//      (NOT --skip-zk — full compile required for deployment)
//   2. Copy build/ directory to settlement-api:
//      scp -r build/ pollpower@kenya:/opt/pollpower/settlement-api/contracts/dev/ebt-v5.2/build/
//
// Usage:
//   cd /opt/pollpower/settlement-api
//   SKIP_CONFIRM=1 npx tsx contracts/dev/ebt-v5.2/deploy-ebt-v5.2.ts
//
// AUDIT TRAIL:
//   This deployer references the 2026-06-10 Fable 5 audit findings:
//   C-1, M-1, L-1, L-3, I-1, M-4
//   Spec: memory/ebt-v5.2-proposed-adjustments.md
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { createWallet, createProviders, logger } from '../../../src/utils.js';

// =============================================================================
// Configuration
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildPath = path.resolve(__dirname, 'build');
const contractPath = path.join(buildPath, 'contract', 'index.js');

// Meter Authority pubkey — same as v5.1. Generated 2026-05-09.
const METER_AUTHORITY_PUBKEY_HEX =
  'bf043807ba0112048d1ba073a47128bb094b3710036fe3da898fcd957fa6f09a';

// Recipient placeholders — same as v5.1 for continuity.
const OPS_RECIPIENT_HEX = createHash('sha256')
  .update('pollpower-ops-recipient-placeholder-2026')
  .digest('hex');
const DIV_RECIPIENT_HEX = createHash('sha256')
  .update('pollpower-dividend-recipient-placeholder-2026')
  .digest('hex');
const DAO_RECIPIENT_HEX = createHash('sha256')
  .update('pollpower-dao-recipient-placeholder-2026')
  .digest('hex');

// =============================================================================
// Contract + Witnesses
// =============================================================================

const Contract = await import(pathToFileURL(contractPath).href);

const witnesses = {
  signature_valid(
    context: { privateState: unknown },
    pubkey: Uint8Array,
    messageHash: Uint8Array,
    signature: Uint8Array,
  ): [unknown, boolean] {
    if (pubkey.length !== 32) return [context.privateState, false];
    if (messageHash.length !== 32) return [context.privateState, false];
    if (signature.length !== 64) return [context.privateState, false];
    let ok = false;
    try {
      ok = ed.verify(signature, messageHash, pubkey);
    } catch { ok = false; }
    return [context.privateState, ok];
  },
};

const compiled = (CompiledContract.make as any)(
  'pollpower-ebt-v5.2',
  Contract.Contract,
).pipe(
  (CompiledContract.withWitnesses as any)(witnesses),
  (CompiledContract.withCompiledFileAssets as any)(buildPath),
);

async function main() {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════════╗');
  logger.info('║  EBT v5.2 — audit-hardened deploy                       ║');
  logger.info('║  Fixes: C-1, M-1, L-1, L-3, I-1, M-4                   ║');
  logger.info('╚══════════════════════════════════════════════════════════╝');
  logger.info('');

  // ─── Step 1: Load deployer wallet ──────────────────────────────────
  logger.info('─── Step 1: Loading deployer wallet ──────────────────');
  const deploymentJsonPath = path.resolve(__dirname, '..', '..', '..', 'deployment.json');
  const ebtDeploy = JSON.parse(fs.readFileSync(deploymentJsonPath, 'utf-8'));
  const walletCtx = await createWallet(ebtDeploy.seed);

  logger.info('[deployer] syncing…');
  await Rx.firstValueFrom(walletCtx.wallet.state().pipe(
    Rx.filter((s: any) => s.isSynced),
    Rx.timeout(900_000),
  ));
  logger.info('[deployer] synced');

  // ─── Step 2: Deploy ────────────────────────────────────────────────
  logger.info('');
  logger.info('─── Step 2: Deploying EBT v5.2 ───────────────────────');
  logger.info(`  authority pubkey:  ${METER_AUTHORITY_PUBKEY_HEX.slice(0, 16)}…`);
  logger.info(`  ops recipient:     ${OPS_RECIPIENT_HEX.slice(0, 16)}…`);
  logger.info(`  dividend recipient:${DIV_RECIPIENT_HEX.slice(0, 16)}…`);
  logger.info(`  dao recipient:     ${DAO_RECIPIENT_HEX.slice(0, 16)}…`);

  const providers = await createProviders(
    walletCtx,
    buildPath,
    'pollpower-ebt-v5.2-state',
  );

  const deployStart = Date.now();
  const deployed: any = await deployContract(providers, {
    compiledContract: compiled as any,
    privateStateId: 'pollpower-ebt-v5.2-state',
    initialPrivateState: {},
  } as any);
  const elapsed = ((Date.now() - deployStart) / 1000).toFixed(1);
  const contractAddress = deployed.deployTxData.public.contractAddress;
  logger.info(`✅ Deployed in ${elapsed}s: ${contractAddress}`);

  // ─── Step 3: initialize() ──────────────────────────────────────────
  logger.info('');
  logger.info('─── Step 3: Calling initialize() ─────────────────────');
  const authorityPubkeyBytes = new Uint8Array(Buffer.from(METER_AUTHORITY_PUBKEY_HEX, 'hex'));
  const opsRecipientBytes = new Uint8Array(Buffer.from(OPS_RECIPIENT_HEX, 'hex'));
  const divRecipientBytes = new Uint8Array(Buffer.from(DIV_RECIPIENT_HEX, 'hex'));
  const daoRecipientBytes = new Uint8Array(Buffer.from(DAO_RECIPIENT_HEX, 'hex'));

  await deployed.callTx.initialize(
    authorityPubkeyBytes,
    opsRecipientBytes,
    divRecipientBytes,
    daoRecipientBytes,
  );
  logger.info('✅ Initialized');

  // ─── Step 4: Verify ────────────────────────────────────────────────
  logger.info('');
  logger.info('─── Step 4: Verify on-chain state ────────────────────');

  const fmt = (v: any) => v?.private?.result !== undefined ? v.private.result : v;
  const authority = fmt(await deployed.callTx.getMeterAuthority());
  const supply = fmt(await deployed.callTx.totalSupply());
  const settleCount = fmt(await deployed.callTx.getSettlementCount());
  const margin = fmt(await deployed.callTx.getMarginPolicy());

  logger.info(`  getMeterAuthority → ${typeof authority === 'object' ? Buffer.from(authority).toString('hex') : authority}`);
  logger.info(`  totalSupply → ${supply}`);
  logger.info(`  settlementCount → ${settleCount}`);
  logger.info(`  marginPolicy → ${JSON.stringify(margin?.map?.((b: bigint) => b.toString()) ?? margin)}`);

  // ─── Persist ──────────────────────────────────────────────────────
  const record = {
    contractAddress,
    contractName: 'pollpower-ebt-v5.2',
    contractVersion: 'v5.2-audit-hardened',
    network: 'preview',
    deployedAt: new Date().toISOString(),
    auditRef: '2026-06-10 Fable 5 review, commit c06191e, tag v10.0',
    auditFindings: 'C-1, M-1, L-1, L-3, I-1, M-4',
    meterAuthorityPubkey: METER_AUTHORITY_PUBKEY_HEX,
    meterAuthorityNote:
      'Generated 2026-05-09 via meter-authority-service keygen on relay. ' +
      'Encrypted sk at /home/pollpower/meter-authority-service/data/authority-key.enc.',
    recipients: {
      operations: OPS_RECIPIENT_HEX,
      dividend: DIV_RECIPIENT_HEX,
      dao: DAO_RECIPIENT_HEX,
    },
    recipientNote:
      'Deterministic placeholders. Rotate to real wallets via transferOwnership ' +
      'then a future setRecipient circuit (not yet in v5.2).',
    bpsPolicy: { producer: 8696, operations: 870, dividend: 186, dao: 248 },
    breakingChanges: [
      'HAT signed payload now 4-field (includes producer) — C-1 fix',
      'settle() requires attestationKey + meterKeyHash — M-1 fix',
      'manualReissue requires cap (1M), cooldown (1hr), authority co-sig — M-4 fix',
    ],
    note:
      'v5.2 supersedes v5.1 (dead-letter). Permissionless settle with producer ' +
      'bound into HAT signature. Settlement-api must update payload construction.',
  };

  const outPath = path.resolve(__dirname, '..', '..', '..', 'ebt-v5.2-deployment.public.json');
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  logger.info('');
  logger.info(`Saved to ${outPath}`);

  await walletCtx.wallet.stop();

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info('  EBT v5.2 DEPLOYED');
  logger.info(`  Address: ${contractAddress}`);
  logger.info('  Next steps:');
  logger.info('    1. Update settlement-api to 4-field HAT payload');
  logger.info('    2. attestProducerOwnership for test producer');
  logger.info('    3. settle() end-to-end smoke test');
  logger.info('    4. Cut over settlement-api to v5.2');
  logger.info('═══════════════════════════════════════════════════════════');
}

main().catch(err => { logger.error(err); process.exit(1); });
