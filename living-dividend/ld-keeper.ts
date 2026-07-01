// ld-keeper.ts
// PollPower Living Dividend keeper service
//
// Subscribes to v7.1's public `_dividendMintedLog` ledger map on the Midnight
// indexer, filters entries for records targeting the LD contract address,
// and submits idempotent `bumpOnMint` transactions to the LD contract.
//
// The v7.1 log-map pattern is functionally equivalent to a MIP-0002 emit +
// event subscription, implemented as ledger state because user-declared event
// types aren't yet exposed by compactc 0.31.0. When compactc catches up to
// MIP-0002 for user-declared events, this keeper will switch from ledger
// polling to event subscription in a small drop-in change.
//
// Runs on any long-lived process host (systemd, pm2, Docker) with
// network access to a Midnight indexer + proof server.
//
// STATUS: reference implementation alongside living-dividend-v1.compact and
//         ebt-v7.1.compact.
//         Depends on midnight-js contracts SDK (target 5.0.0-alpha or later).
//         Placeholders (`./state-store`, `./contracts/LivingDividend`,
//         `./logger`) are wired against the deploying operator's own
//         infra module names.

import { setTimeout as sleep } from 'node:timers/promises';
import type { UserAddress, ContractAddress } from '@midnight-ntwrk/compact-runtime';
import {
  findDeployedContract,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { getIndexerClient } from '@midnight-ntwrk/midnight-js-network-id';
import { readState, writeState } from './state-store';   // persistent cursor
import { LivingDividendContract } from './contracts/LivingDividend';
import { witnesses as ldWitnesses } from './LivingDividend.witnesses';
import { logger } from './logger';

// ─── config ─────────────────────────────────────

interface KeeperConfig {
  v7ContractAddress: string;
  ldContractAddress: string;
  indexerUrl:        string;
  proofServerUrl:    string;
  pollIntervalMs:    number;    // fallback if subscription drops
  keeperPrivateKey:  Uint8Array;
  cursorFile:        string;    // persistent last-processed-block
}

// ─── event schema (mirrors v7.1 DividendMinted struct) ─

interface DividendMintedEvent {
  sourceTxSalt: string;         // hex Bytes<32>
  amount:       bigint;         // Uint<128>
  recipient:    string;         // hex ContractAddress
  blockTime:    bigint;         // Uint<64>
  epochColor:   string;         // hex Bytes<32>
  block:        bigint;         // block height where event was emitted
  txHash:       string;         // parent tx hash for traceability
}

// ─── keeper state ───────────────────────────────

interface KeeperCursor {
  lastProcessedBlock: bigint;
  lastProcessedAt:    number;   // unix ms
  processedSaltCount: number;
}

// ─── main loop ──────────────────────────────────

export async function runKeeper(config: KeeperConfig): Promise<never> {
  logger.info('[ld-keeper] starting', {
    v7: config.v7ContractAddress,
    ld: config.ldContractAddress,
  });

  const cursor: KeeperCursor = await readState(config.cursorFile, {
    lastProcessedBlock: 0n,
    lastProcessedAt: 0,
    processedSaltCount: 0,
  });

  const indexer = getIndexerClient(config.indexerUrl);
  const ldContract = await findDeployedContract<LivingDividendContract>({
    contractAddress: config.ldContractAddress,
    witnesses: ldWitnesses,
  });

  while (true) {
    try {
      // NOTE: with the v7.1 ledger-log pattern, cursor.lastProcessedBlock is
      // repurposed as "last processed log sequence" (Uint<64> monotone from
      // v7.1's _dividendEventSeq counter). Kept the field name unchanged for
      // migration simplicity; drop-in swap when MIP-0002 events land in compactc.
      const events = await fetchNewEvents(
        indexer,
        config.v7ContractAddress,
        cursor.lastProcessedBlock,
      );

      for (const event of events) {
        // Only care about events targeting our LD address
        if (event.recipient !== config.ldContractAddress) {
          cursor.lastProcessedBlock = event.block;
          continue;
        }

        // Idempotency check (belt and suspenders; contract also enforces).
        // Avoids sending a doomed tx and paying DUST for it.
        const alreadyProcessed = await ldContract.query.hasProcessedSalt(
          hexToBytes(event.sourceTxSalt),
        );
        if (alreadyProcessed) {
          logger.info('[ld-keeper] salt already processed; skipping', {
            salt: event.sourceTxSalt,
            block: event.block.toString(),
          });
          cursor.lastProcessedBlock = event.block;
          continue;
        }

        try {
          const now = BigInt(Math.floor(Date.now() / 1000));
          const tx = await ldContract.callTx.bumpOnMint(
            hexToBytes(event.sourceTxSalt),
            event.amount,
            now,
          );
          logger.info('[ld-keeper] bumped', {
            txHash: tx.public.txHash,
            amount: event.amount.toString(),
            block: event.block.toString(),
          });
          cursor.lastProcessedBlock = event.block;
          cursor.processedSaltCount += 1;
        } catch (err) {
          if (isAlreadyProcessedError(err)) {
            // Race condition — another keeper (or a retry) already bumped
            logger.info('[ld-keeper] concurrent bump won; advancing');
            cursor.lastProcessedBlock = event.block;
          } else if (isTransientError(err)) {
            // Do NOT advance cursor; retry on next loop
            logger.warn('[ld-keeper] transient error; retrying', { err });
            break;   // exit for-loop, sleep, retry
          } else {
            // Unknown error. Log loudly. Don't advance. Human intervention.
            logger.error('[ld-keeper] hard failure', { err, event });
            break;
          }
        }
      }

      cursor.lastProcessedAt = Date.now();
      await writeState(config.cursorFile, cursor);
    } catch (loopErr) {
      logger.error('[ld-keeper] loop error', { loopErr });
    }

    await sleep(config.pollIntervalMs);
  }
}

// ─── helpers ────────────────────────────────────

async function fetchNewEvents(
  indexer: ReturnType<typeof getIndexerClient>,
  v7Address: string,
  fromSeq: bigint,
): Promise<DividendMintedEvent[]> {
  // Read v7.1 contract state; extract entries from _dividendMintedLog whose
  // sequence exceeds fromSeq. Map key is Uint<64> monotone counter, so simple
  // forward iteration from fromSeq+1 catches every new entry.
  const state = await indexer.getContractState({
    contractAddress: v7Address,
    atBlock: 'latest',
  });
  const log = state.data.get('_dividendMintedLog');
  if (!log) return [];

  const results: DividendMintedEvent[] = [];
  for (const [seq, entry] of log) {
    const seqBig = BigInt(seq);
    if (seqBig <= fromSeq) continue;
    results.push({
      sourceTxSalt: entry.sourceTxSalt,
      amount:       BigInt(entry.amount),
      recipient:    entry.recipient,
      blockTime:    BigInt(entry.blockTime),
      epochColor:   entry.epochColor,
      block:        seqBig,   // repurposed as monotone log-sequence cursor
      txHash:       '',       // ledger-log doesn't expose parent tx directly
    });
  }
  return results;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

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

// ─── entrypoint ─────────────────────────────────

if (require.main === module) {
  const config: KeeperConfig = {
    v7ContractAddress: process.env.V7_CONTRACT_ADDR!,
    ldContractAddress: process.env.LD_CONTRACT_ADDR!,
    indexerUrl:        process.env.INDEXER_URL ?? 'https://indexer.testnet-02.midnight.network',
    proofServerUrl:    process.env.PROOF_SERVER_URL ?? 'http://localhost:6300',
    pollIntervalMs:    parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10),
    keeperPrivateKey:  hexToBytes(process.env.KEEPER_SK!),
    cursorFile:        process.env.CURSOR_FILE ?? './data/ld-keeper.cursor.json',
  };

  runKeeper(config).catch((err) => {
    logger.error('[ld-keeper] fatal', { err });
    process.exit(1);
  });
}
