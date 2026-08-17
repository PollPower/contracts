/**
 * ## PORT NOTES
 * - Poll vs WS: this port intentionally uses a poll loop over `queryContractState`; Preview WS subscription shape was not needed for correctness and poll is simpler/robust.
 * - SDK plumbing: `CompiledContract.make(...).pipe(withWitnesses(makeLdWitnesses()), withCompiledFileAssets(...))` + `createWallet/createProviders/withZkConfigDir` + `findDeployedContract(...)`, matching `deploy-ld-v2.2.1.mjs` and `ld-register-members.mjs`.
 * - `_dividendMintedLog` decode: uses EBT v8 build `ledger(state.data)` from `EBT_V8_BUILD_DIR/contract/index.js`, then drains typed map entries in ascending seq.
 * - Witness time gate: keeper updates runtime block time before each `bumpOnMint` and passes `currentTime = blockTime - 120` so `witness_blockTimeGte(currentTime)` holds.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readState, writeState } from './state-store';
import { logger } from './logger';
import { makeLdWitnesses, type LdPrivateState } from './witnesses';
import {
  type LivingDividendContract,
  hasProcessedSaltIfAvailable,
  getTxHashFromSubmission,
} from './contracts/LivingDividend';

interface KeeperConfig {
  ebtV8ContractAddress: string;
  ldContractAddress: string;
  ldPrivateStateId: string;
  ldBuildDir: string;
  ebtV8BuildDir: string;
  cursorFile: string;
  pollIntervalMs: number;
  ownerSeedHex: string;
}

interface KeeperCursor {
  lastProcessedSeq: bigint;
  lastActivityIso: string;
  processedRecords: number;
}

interface DividendMintedRecord {
  seq: bigint;
  sourceTxSalt: Uint8Array;
  amount: bigint;
  recipientHex: string;
}

type QueryContractState = (address: string) => Promise<any>;
type LDDeployedContract = LivingDividendContract & {
  query?: Record<string, (...args: any[]) => Promise<any>>;
};

export async function runKeeper(config: KeeperConfig): Promise<never> {
  logger.info('[ld-keeper] starting', {
    ebtV8: config.ebtV8ContractAddress,
    ld: config.ldContractAddress,
    pollIntervalMs: config.pollIntervalMs,
  });

  const runtime = await loadRuntimeDependencies(config);
  const cursor = await readState<KeeperCursor>(config.cursorFile, {
    lastProcessedSeq: -1n,
    lastActivityIso: new Date(0).toISOString(),
    processedRecords: 0,
  });
  logger.info('[ld-keeper] cursor loaded', {
    lastProcessedSeq: cursor.lastProcessedSeq.toString(),
    processedRecords: cursor.processedRecords,
  });

  while (true) {
    try {
      await pollOnce(runtime.queryContractState, runtime.decodeEbtLedger, runtime.ldContract, config, cursor, runtime.ldWitnessState);
    } catch (err) {
      logger.error('[ld-keeper] poll iteration failed', { err: errorMessage(err) });
    }
    await sleep(config.pollIntervalMs);
  }
}

async function pollOnce(
  queryContractState: QueryContractState,
  decodeEbtLedger: (data: unknown) => any,
  ldContract: LDDeployedContract,
  config: KeeperConfig,
  cursor: KeeperCursor,
  ldWitnessState: LdPrivateState,
): Promise<void> {
  const state = await queryContractState(config.ebtV8ContractAddress);
  if (!state?.data) {
    logger.warn('[ld-keeper] missing EBT state payload');
    return;
  }

  const ledger = decodeEbtLedger(state.data);
  const records = collectNewRecords(ledger, cursor.lastProcessedSeq);
  if (records.length === 0) {
    return;
  }

  const ldHex = normalizeHex(config.ldContractAddress);
  const blockTimeSec = extractChainTimeSec(state);
  for (const rec of records) {
    if (rec.seq <= cursor.lastProcessedSeq) {
      continue;
    }

    if (rec.recipientHex !== ldHex) {
      cursor.lastProcessedSeq = rec.seq;
      continue;
    }

    const alreadyProcessed = await hasProcessedSaltIfAvailable(ldContract, rec.sourceTxSalt);
    if (alreadyProcessed) {
      cursor.lastProcessedSeq = rec.seq;
      continue;
    }

    ldWitnessState.blockTime = blockTimeSec;
    const currentTime = blockTimeSec > 120n ? blockTimeSec - 120n : 0n;

    try {
      const tx = await ldContract.callTx.bumpOnMint(rec.sourceTxSalt, rec.amount, currentTime);
      cursor.lastProcessedSeq = rec.seq;
      cursor.lastActivityIso = new Date().toISOString();
      cursor.processedRecords += 1;
      logger.info('[ld-keeper] bump submitted', {
        seq: rec.seq.toString(),
        amount: rec.amount.toString(),
        txHash: getTxHashFromSubmission(tx),
      });
    } catch (err) {
      if (isAlreadyProcessedError(err)) {
        cursor.lastProcessedSeq = rec.seq;
        logger.info('[ld-keeper] salt already processed; advancing cursor', { seq: rec.seq.toString() });
        continue;
      }
      if (isTransientError(err)) {
        logger.warn('[ld-keeper] transient error; retrying next poll', {
          seq: rec.seq.toString(),
          err: errorMessage(err),
        });
        break;
      }
      logger.error('[ld-keeper] hard failure; stopping drain for this poll', {
        seq: rec.seq.toString(),
        err: errorMessage(err),
      });
      break;
    }
  }

  await writeState(config.cursorFile, cursor);
}

function collectNewRecords(ledger: any, afterSeq: bigint): DividendMintedRecord[] {
  const rawLog = ledger?._dividendMintedLog;
  if (!rawLog || typeof rawLog[Symbol.iterator] !== 'function') {
    return [];
  }

  const out: DividendMintedRecord[] = [];
  for (const [rawSeq, rawEntry] of rawLog as Iterable<[unknown, any]>) {
    const seq = toBigInt(rawSeq);
    if (seq <= afterSeq) {
      continue;
    }

    const sourceTxSalt = toBytes32(rawEntry?.sourceTxSalt);
    const amount = toBigInt(rawEntry?.amount);
    const recipientHex = normalizeHex(toHexString(rawEntry?.recipient));

    out.push({ seq, sourceTxSalt, amount, recipientHex });
  }
  out.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  return out;
}

async function loadRuntimeDependencies(config: KeeperConfig): Promise<{
  queryContractState: QueryContractState;
  decodeEbtLedger: (data: unknown) => any;
  ldContract: LDDeployedContract;
  ldWitnessState: LdPrivateState;
}> {
  const network = await import('@midnight-ntwrk/midnight-js-network-id');
  network.setNetworkId('preview');

  const compact = await import('@midnight-ntwrk/compact-js');
  const contracts = await import('@midnight-ntwrk/midnight-js-contracts');
  const utilsRuntime = await import(pathToFileURL(path.join(__dirname, '_refs', 'utils-runtime.js')).href);
  const refsConfig = await import(pathToFileURL(path.join(__dirname, '_refs', 'config.js')).href);

  const ldBuild = await import(pathToFileURL(path.join(config.ldBuildDir, 'contract', 'index.js')).href);
  const ebtBuild = await import(pathToFileURL(path.join(config.ebtV8BuildDir, 'contract', 'index.js')).href);

  if (typeof ebtBuild.ledger !== 'function') {
    throw new Error(`EBT build does not export ledger(): ${config.ebtV8BuildDir}`);
  }

  const ldWitnessState: LdPrivateState = {};
  const baseWitnesses = makeLdWitnesses<LdPrivateState>();
  const wrappedWitnesses = {
    ...baseWitnesses,
    witness_blockTimeGte: (ctx: any, t: bigint) => {
      const merged = { ...(ctx?.privateState ?? {}), ...ldWitnessState };
      return baseWitnesses.witness_blockTimeGte({ ...ctx, privateState: merged }, t);
    },
  };

  const compiledContract = compact.CompiledContract.make('ld-v2.2.1', ldBuild.Contract).pipe(
    // SDK generic collapses to `never` when Contract is `any`; cast the witness
    // map to `never` (runtime shape is the real makeLdWitnesses map + blockTime wrapper).
    compact.CompiledContract.withWitnesses(wrappedWitnesses as never),
    compact.CompiledContract.withCompiledFileAssets(config.ldBuildDir),
  );

  const walletCtx = await utilsRuntime.createWallet(config.ownerSeedHex);
  let providers = await utilsRuntime.createProviders(walletCtx, path.join(__dirname, 'build'));
  providers = utilsRuntime.withZkConfigDir(providers, config.ldBuildDir);

  const publicDataProvider = providers.publicDataProvider;
  if (!publicDataProvider?.queryContractState) {
    throw new Error('publicDataProvider.queryContractState not available');
  }

  // Ensure provider URLs match Preview refs if caller did not override helpers.
  const expectedIndexer = refsConfig?.CONFIG?.indexer;
  if (expectedIndexer) {
    logger.info('[ld-keeper] runtime endpoints', {
      indexer: refsConfig.CONFIG.indexer,
      indexerWs: refsConfig.CONFIG.indexerWS,
      node: refsConfig.CONFIG.node,
      proof: refsConfig.CONFIG.proofServer,
    });
  }

  const ldContract = (await contracts.findDeployedContract(providers, {
    contractAddress: config.ldContractAddress,
    compiledContract: compiledContract as any,
    privateStateId: config.ldPrivateStateId,
    initialPrivateState: {},
  })) as unknown as LDDeployedContract;

  return {
    queryContractState: (address) => publicDataProvider.queryContractState(address),
    decodeEbtLedger: (data) => ebtBuild.ledger(data),
    ldContract,
    ldWitnessState,
  };
}

function loadConfigFromEnv(): KeeperConfig {
  const deploymentSeed = readSeedFromDeploymentJson(
    process.env.DEPLOYMENT_JSON_PATH ?? '/home/pollpower/contracts/ebt/deployment.json',
  );
  const ownerSeedHex = process.env.OWNER_SEED ?? deploymentSeed;
  if (!ownerSeedHex) {
    throw new Error('OWNER_SEED is required (or provide DEPLOYMENT_JSON_PATH with a seed field)');
  }

  return {
    ebtV8ContractAddress:
      process.env.EBT_V8_CONTRACT_ADDR ??
      'c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3',
    ldContractAddress:
      process.env.LD_CONTRACT_ADDR ??
      'efccdb2348f98c496f8fd5925a6961c3d81966eab562b928ab9765264dc7fd30',
    ldPrivateStateId: process.env.LD_PRIVATE_STATE_ID ?? 'ld-v2.2.1-state',
    ldBuildDir: process.env.LD_BUILD_DIR ?? '/home/pollpower/contracts/living-dividend/build/v2.2.1',
    ebtV8BuildDir: process.env.EBT_V8_BUILD_DIR ?? '/home/pollpower/contracts/ebt/build/v8',
    cursorFile: process.env.CURSOR_FILE ?? path.join(__dirname, 'data', 'ld-keeper.cursor.json'),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10),
    ownerSeedHex,
  };
}

function readSeedFromDeploymentJson(filePath: string): string | undefined {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text) as { seed?: string };
    return parsed.seed;
  } catch {
    return undefined;
  }
}

function extractChainTimeSec(state: any): bigint {
  const candidates: unknown[] = [
    state?.block?.timestamp,
    state?.block?.time,
    state?.timestamp,
    state?.blockTimestamp,
    state?.slotTime,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) {
      continue;
    }
    const v = toBigInt(c);
    if (v > 1000000000000n) {
      return v / 1000n;
    }
    if (v > 0n) {
      return v;
    }
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot convert non-finite number to bigint: ${value}`);
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    return BigInt(value);
  }
  if (value && typeof value === 'object') {
    const maybe = value as { value?: unknown; toString?: () => string };
    if (maybe.value !== undefined) {
      return toBigInt(maybe.value);
    }
    if (typeof maybe.toString === 'function') {
      return BigInt(maybe.toString());
    }
  }
  throw new Error(`cannot convert value to bigint: ${String(value)}`);
}

function toBytes32(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'string') {
    return hexToBytes(value);
  }
  if (value && typeof value === 'object') {
    const maybe = value as { bytes?: unknown };
    if (maybe.bytes !== undefined) {
      return toBytes32(maybe.bytes);
    }
  }
  throw new Error(`cannot convert to bytes: ${String(value)}`);
}

function toHexString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (value && typeof value === 'object') {
    const maybe = value as { bytes?: unknown; toString?: () => string };
    if (maybe.bytes !== undefined) {
      return toHexString(maybe.bytes);
    }
    if (typeof maybe.toString === 'function') {
      return maybe.toString();
    }
  }
  throw new Error(`cannot convert value to hex string: ${String(value)}`);
}

function normalizeHex(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}

function hexToBytes(hex: string): Uint8Array {
  const clean = normalizeHex(hex);
  if (clean.length % 2 !== 0) {
    throw new Error(`hex string must have even length: ${clean}`);
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

function isAlreadyProcessedError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('already processed') || msg.includes('salt already');
}

function isTransientError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('network') ||
    msg.includes('proof server') ||
    msg.includes('temporarily unavailable')
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

if (require.main === module) {
  runKeeper(loadConfigFromEnv()).catch((err) => {
    logger.error('[ld-keeper] fatal', { err: errorMessage(err) });
    process.exit(1);
  });
}
