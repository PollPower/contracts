// =============================================================================
// deploy-ebt-v7.ts — deploy EBT v7 (unshielded, contract-minted) to Preview.
//
// initialize(meterAuthorityPubkey, opsAddr, divAddr, daoAddr) — recipients are
// UserAddress ({bytes:32}) now (unshielded mint targets), derived from fixed
// pilot seeds so they're real, well-formed addresses.
//
// Run from /opt/pollpower/settlement-api:
//   npx tsx src/deploy-ebt-v7.ts
// =============================================================================

import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'buffer';
import * as Rx from 'rxjs';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import * as ledger from '@midnight-ntwrk/ledger-v8';

// Enable sync ed25519.verify (same as the production v5.x settlement path).
(ed as any).hashes.sha512 = sha512;

// signature_valid witness — real Ed25519 verification (mirrors v5.1/v5.2).
const witnesses = {
  signature_valid(
    context: { privateState: unknown },
    pubkey: Uint8Array,
    messageHash: Uint8Array,
    signature: Uint8Array,
  ): [unknown, boolean] {
    if (pubkey.length !== 32 || messageHash.length !== 32 || signature.length !== 64) {
      return [context.privateState, false];
    }
    let ok = false;
    try { ok = ed.verify(signature, messageHash, pubkey); } catch { ok = false; }
    return [context.privateState, ok];
  },
};
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import {
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import { CONFIG } from './config.js';
import { createWallet, createProviders, logger } from './utils.js';

const V7_BUILD = '/opt/pollpower/settlement-api/contracts/dev/ebt-v7/build';
const NETWORK_ID = 'preview';

// Meter Authority pubkey (live Meter Authority Service on relay).
const METER_AUTHORITY_PUBKEY_HEX =
  'bf043807ba0112048d1ba073a47128bb094b3710036fe3da898fcd957fa6f09a';

// Deterministic pilot recipient seeds (fixed — produce real UserAddresses).
const RECIPIENT_SEEDS = {
  operations: 'a'.repeat(64),
  dividend:   'b'.repeat(64),
  dao:        'c'.repeat(64),
};

function deriveUserAddress(seedHex: string): { keyBytes: Uint8Array; bech32: string } {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('seed bad');
  const account = hd.hdWallet.selectAccount(0);
  let r = account.selectRole(Roles.NightExternal).deriveKeyAt(0);
  let idx = 0;
  while (r.type !== 'keyDerived' && idx < 5) { idx++; r = account.selectRole(Roles.NightExternal).deriveKeyAt(idx); }
  if (r.type !== 'keyDerived') throw new Error('derive failed');
  const unshieldedKey = Buffer.from((r as any).key);
  hd.hdWallet.clear();
  const vk = ledger.signatureVerifyingKey(unshieldedKey.toString('hex'));
  const addrHex = ledger.addressFromKey(vk);
  const keyBytes = new Uint8Array(Buffer.from(addrHex, 'hex'));
  const bech32 = MidnightBech32m.encode(NETWORK_ID, new UnshieldedAddress(Buffer.from(addrHex, 'hex'))).toString();
  return { keyBytes, bech32 };
}

async function main() {
  logger.info('=== EBT v7 deploy (unshielded) — Preview ===');

  const deploymentJsonPath = '/opt/pollpower/settlement-api/deployment.json';
  const ebtDeploy = JSON.parse(readFileSync(deploymentJsonPath, 'utf-8'));
  const walletCtx = await createWallet(ebtDeploy.seed);

  logger.info('Syncing deployer wallet…');
  const state = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.throttleTime(5000), Rx.filter((s: any) => s.isSynced)),
  );
  logger.info(`Deployer: ${walletCtx.unshieldedKeystore.getBech32Address()}`);
  logger.info(`DUST: ${state.dust.balance(new Date())}`);

  // Recipients.
  const ops = deriveUserAddress(RECIPIENT_SEEDS.operations);
  const div = deriveUserAddress(RECIPIENT_SEEDS.dividend);
  const dao = deriveUserAddress(RECIPIENT_SEEDS.dao);
  logger.info(`ops recipient: ${ops.bech32}`);
  logger.info(`div recipient: ${div.bech32}`);
  logger.info(`dao recipient: ${dao.bech32}`);

  // Load compiled v7.
  const v7mod = await import(pathToFileURL(path.join(V7_BUILD, 'contract', 'index.js')).href);
  const compiledV7 = (CompiledContract.make as any)('ebt-v7', v7mod.Contract).pipe(
    (CompiledContract.withWitnesses as any)(witnesses),
    (CompiledContract.withCompiledFileAssets as any)(V7_BUILD),
  );

  const providers = await createProviders(walletCtx, V7_BUILD);

  // ─── Deploy ──────────────────────────────────────────────────────────
  logger.info('Deploying EBT v7 (settle.prover ~19.5MB — may be slow / size-bound)…');
  const deployed: any = await deployContract(providers, {
    compiledContract: compiledV7,
    privateStateId: 'ebt-v7-state',
    initialPrivateState: {},
  } as any);
  const contractAddress: string = deployed.deployTxData.public.contractAddress;
  logger.info(`✅ EBT v7 deployed: ${contractAddress}`);

  // ─── initialize() ──────────────────────────────────────────────────────
  logger.info('Calling initialize()…');
  const authBytes = new Uint8Array(Buffer.from(METER_AUTHORITY_PUBKEY_HEX, 'hex'));
  await deployed.callTx.initialize(
    authBytes,
    { bytes: ops.keyBytes },
    { bytes: div.keyBytes },
    { bytes: dao.keyBytes },
  );
  logger.info('✅ Initialized');

  // ─── Verify reads ──────────────────────────────────────────────────────
  const fmt = (x: any) => (x?.value !== undefined ? x.value : x);
  const authority = await deployed.callTx.getMeterAuthority();
  const supply = await deployed.callTx.totalSupply();
  logger.info(`  getMeterAuthority → ${Buffer.from(fmt(authority.private?.result ?? authority)).toString('hex').slice(0,16)}…`);
  logger.info(`  totalSupply → ${JSON.stringify(supply.private?.result ?? supply)}`);

  // ─── Save ────────────────────────────────────────────────────────────
  const out = {
    contractName: 'ebt-v7',
    contractAddress,
    network: 'preview',
    deployedAt: new Date().toISOString(),
    initialized: true,
    deployer: walletCtx.unshieldedKeystore.getBech32Address(),
    meterAuthorityPubkey: METER_AUTHORITY_PUBKEY_HEX,
    tokenColorDomainSep: 'pollpower:ebt:v7:epoch1',
    recipients: {
      operations: ops.bech32,
      dividend: div.bech32,
      dao: dao.bech32,
    },
    recipientNote:
      'UserAddresses derived from fixed pilot seeds (a/b/c x64). Unshielded mint targets.',
  };
  writeFileSync('/opt/pollpower/settlement-api/ebt-v7-deployment.public.json', JSON.stringify(out, null, 2));
  logger.info('');
  logger.info(`✅ Saved ebt-v7-deployment.public.json`);
  logger.info(`CONTRACT_ADDRESS=${contractAddress}`);
  process.exit(0);
}

main().catch((e) => { logger.error(e); process.exit(1); });
