// ld-keeper.ts
// PollPower Living Dividend keeper service
//
// WebSocket-subscribed keeper. Uses the Midnight indexer's
// `subscribeToContractActionEvents` GraphQL-over-WebSocket subscription (per
// midnight-indexer 2.0.0+) to receive a push stream of contract actions on
// EBT v7.1. For each ContractCall that touches `_dividendMintedLog`, the
// keeper reads the new entries from contract state and submits idempotent
// `bumpOnMint` transactions to the LD contract.
//
// Design (2026-07-01 iteration):
//
//   Path A (this file): keep v7.1's ledger-log design, upgrade keeper from
//   poll to WebSocket subscribe. Latency drops from ~5s (poll interval) to
//   sub-second (indexer push). No dependency on the buggy user-declared
//   event emit path in compactc 0.31.0.
//
//   When compactc exposes user-declared MIP-0002 event types (Path C, "future
//   polish"), swap `subscribeToContractActionEvents` for
//   `queryContractEvents({ eventType: 'DividendMinted' })`. Small change on
//   both sides; contract log map goes away.
//
// Failure semantics:
//   - Keeper dies: dividends stop accruing but no funds lost. On restart,
//     cursor picks up from `lastProcessedSeq + 1`; missed entries replay
//     in order.
//   - Two keepers running: LD's `_processedSalts` Set makes both idempotent.
//     Safe to run redundant keepers.
//   - Indexer unreachable: WebSocket auto-reconnects with exponential backoff.
//     Cursor unchanged until connection restored.
//   - v7.1 emits without LD-side effect (LD pointer unset): keeper filters
//     entries by `recipient == ldContractAddress`; foreign entries advance
//     the cursor but do nothing.
//
// STATUS: reference implementation. Wire against the operator's own
// infra modules (`./state-store`, `./contracts/LivingDividend`, `./logger`).

import { setTimeout as sleep } from 'node:timers/promises';
import {
  findDeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { IndexerWsClient } from '@midnight-ntwrk/midnight-indexer-ws-client';
import { getPublicDataProvider } from '@midnight-ntwrk/midnight-js-http-client';
import { readState, writeState } from './state-store';
import { LivingDividendContract } from './contracts/LivingDividend';
import { witnesses as ldWitnesses } from './witnesses';
import { logger } from './logger';

// ─── config ─────────────────────────────────────

interface KeeperConfig {
  v7ContractAddress: string;         // EBT v7.1 address
  ldContractAddress: string;         // Living Dividend address
  indexerHttpUrl:    string;         // e.g. https://indexer.testnet-02.midnight.network
  indexerWsUrl:      string;         // e.g. wss://indexer.testnet-02.midnight.network
  proofServerUrl:    string;         // e.g. http://localhost:6300
  keeperPrivateKey:  Uint8Array;
  cursorFile:        string;         // persistent last-processed sequence
  reconnectBaseMs:   number;         // WebSocket reconnect base delay
  reconnectMaxMs:    number;         // WebSocket reconnect max delay
}

// ─── event shape (from _dividendMintedLog) ─────

interface DividendMintedRecord {
  sourceTxSalt: Uint8Array;
  amount:       bigint;
  recipient:    string;    // hex-encoded ContractAddress
  blockTime:    bigint;
  epochColor:   Uint8Array;
  seq:          bigint;    // log map key, monotone
}

// ─── keeper state ───────────────────────────────

interface KeeperCursor {
  lastProcessedSeq:  bigint;    // highest _dividendMintedLog key processed
  lastActivityIso:   string;    // last successful subscription event
  processedRecords:  number;    // total bumps applied since start
}

// ─── main ────────────────────────────────────────

export async function runKeeper(config: KeeperConfig): Promise<never> {
  logger.info('[ld-keeper] starting', {
    v7: config.v7ContractAddress,
    ld: config.ldContractAddress,
    indexerWs: config.indexerWsUrl,
  });

  const cursor: KeeperCursor = await readState(config.cursorFile, {
    lastProcessedSeq: -1n,           // -1 so first entry at seq 0 is processed
    lastActivityIso: new Date(0).toISOString(),
    processedRecords: 0,
  });
  logger.info('[ld-keeper] cursor loaded', { lastProcessedSeq: cursor.lastProcessedSeq.toString() });

  const publicDataProvider = getPublicDataProvider(config.indexerHttpUrl);
  const ldContract = await findDeployedContract<LivingDividendContract>({
    contractAddress: config.ldContractAddress,
    witnesses: ldWitnesses,
  });

  // Reconnect loop: WebSocket connections drop; we resubscribe with the
  // current cursor so we never miss an entry.
  let reconnectDelay = config.reconnectBaseMs;
  while (true) {
    try {
      logger.info('[ld-keeper] connecting to indexer WS', { url: config.indexerWsUrl });
      const ws = new IndexerWsClient();
      await ws.connectionInit(config.indexerWsUrl);
      reconnectDelay = config.reconnectBaseMs;  // reset on successful connect

      // Subscribe from cursor+1. `blockOffset` semantics per indexer 2.0.0:
      // we set it to the last block we processed so the subscription replays
      // from just after.
      await runSubscription(ws, config, cursor, ldContract, publicDataProvider);

      // If runSubscription returns, the socket was closed cleanly.
      logger.info('[ld-keeper] subscription ended cleanly; reconnecting');
    } catch (err) {
      logger.error('[ld-keeper] subscription error; will reconnect', { err: String(err) });
      // Exponential backoff, capped
      await sleep(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, config.reconnectMaxMs);
    }
  }
}

// ─── subscription loop ──────────────────────────

async function runSubscription(
  ws: IndexerWsClient,
  config: KeeperConfig,
  cursor: KeeperCursor,
  ldContract: Awaited<ReturnType<typeof findDeployedContract>>,
  publicDataProvider: ReturnType<typeof getPublicDataProvider>,
): Promise<void> {
  let closeResolve: () => void;
  const closePromise = new Promise<void>((r) => { closeResolve = r; });

  const unsubscribe = ws.subscribeToContractActionEvents(
    {
      next: async (payload) => {
        try {
          // Every contract action on v7.1 is delivered here. We only care
          // about ContractCalls to claimSplit (kind=1 dividend branch).
          // Rather than parse call arguments off the wire, we take the
          // authoritative path: read the CURRENT `_dividendMintedLog` state
          // and drain entries newer than our cursor.
          await drainNewLogEntries(
            config,
            cursor,
            ldContract,
            publicDataProvider,
          );
        } catch (err) {
          logger.error('[ld-keeper] handler error', { err: String(err) });
        }
      },
      error: (err) => {
        logger.error('[ld-keeper] subscription onError', { err: String(err) });
        closeResolve();
      },
      complete: () => {
        logger.info('[ld-keeper] subscription complete frame');
        closeResolve();
      },
    },
    config.v7ContractAddress,
    // Start from block offset 0 on cold start; the entry-level cursor
    // (cursor.lastProcessedSeq) is the real dedup. Passing a fresh 0 means
    // subscription state replays every action; we filter by seq.
    { hash: undefined, height: 0 },
  );

  try {
    await closePromise;
  } finally {
    unsubscribe();
  }
}

// ─── drain new _dividendMintedLog entries into LD ─

async function drainNewLogEntries(
  config: KeeperConfig,
  cursor: KeeperCursor,
  ldContract: Awaited<ReturnType<typeof findDeployedContract>>,
  publicDataProvider: ReturnType<typeof getPublicDataProvider>,
): Promise<void> {
  const state = await publicDataProvider.queryContractState(config.v7ContractAddress);
  if (!state) return;
  const log = state.data.get('_dividendMintedLog');
  if (!log) return;

  // Collect new records in seq order.
  const newRecords: DividendMintedRecord[] = [];
  for (const [seqRaw, entryRaw] of log) {
    const seq = BigInt(seqRaw);
    if (seq <= cursor.lastProcessedSeq) continue;
    if (entryRaw.recipient !== config.ldContractAddress) {
      // Foreign target (LD address changed since this entry was written,
      // or v7.1 pointed at a different LD contract). Advance cursor safely.
      cursor.lastProcessedSeq = seq;
      continue;
    }
    newRecords.push({
      sourceTxSalt: entryRaw.sourceTxSalt,
      amount:       BigInt(entryRaw.amount),
      recipient:    entryRaw.recipient,
      blockTime:    BigInt(entryRaw.blockTime),
      epochColor:   entryRaw.epochColor,
      seq,
    });
  }
  newRecords.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  for (const rec of newRecords) {
    // Belt-and-suspenders idempotency: check LD state before spending DUST.
    const already = await ldContract.query.hasProcessedSalt(rec.sourceTxSalt);
    if (already) {
      cursor.lastProcessedSeq = rec.seq;
      continue;
    }

    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const tx = await ldContract.callTx.bumpOnMint(rec.sourceTxSalt, rec.amount, now);
      logger.info('[ld-keeper] bumped', {
        seq: rec.seq.toString(),
        amount: rec.amount.toString(),
        txHash: tx.public.txHash,
      });
      cursor.lastProcessedSeq = rec.seq;
      cursor.processedRecords += 1;
      cursor.lastActivityIso = new Date().toISOString();
    } catch (err) {
      if (isAlreadyProcessedError(err)) {
        // Race with another keeper; safe to advance.
        logger.info('[ld-keeper] concurrent bump won; advancing cursor', { seq: rec.seq.toString() });
        cursor.lastProcessedSeq = rec.seq;
      } else if (isTransientError(err)) {
        // Do NOT advance cursor; next subscription frame will retry.
        logger.warn('[ld-keeper] transient error; will retry on next frame', { err: String(err) });
        break;
      } else {
        // Unknown error. Log loudly. Don't advance. Human intervention.
        logger.error('[ld-keeper] hard failure; halting drain', { err: String(err), seq: rec.seq.toString() });
        break;
      }
    }
  }

  await writeState(config.cursorFile, cursor);
}

// ─── helpers ────────────────────────────────────

function isAlreadyProcessedError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? '');
  return msg.includes('salt already processed');
}

function isTransientError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? '');
  return (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('proof server') ||
    msg.includes('indexer temporarily unavailable')
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

// ─── entrypoint ─────────────────────────────────

if (require.main === module) {
  const config: KeeperConfig = {
    v7ContractAddress: process.env.V7_CONTRACT_ADDR!,
    ldContractAddress: process.env.LD_CONTRACT_ADDR!,
    indexerHttpUrl:    process.env.INDEXER_HTTP_URL ?? 'https://indexer.testnet-02.midnight.network',
    indexerWsUrl:      process.env.INDEXER_WS_URL   ?? 'wss://indexer.testnet-02.midnight.network',
    proofServerUrl:    process.env.PROOF_SERVER_URL ?? 'http://localhost:6300',
    keeperPrivateKey:  hexToBytes(process.env.KEEPER_SK!),
    cursorFile:        process.env.CURSOR_FILE ?? './data/ld-keeper.cursor.json',
    reconnectBaseMs:   parseInt(process.env.WS_RECONNECT_BASE_MS ?? '1000', 10),
    reconnectMaxMs:    parseInt(process.env.WS_RECONNECT_MAX_MS  ?? '60000', 10),
  };

  runKeeper(config).catch((err) => {
    logger.error('[ld-keeper] fatal', { err: String(err) });
    process.exit(1);
  });
}
