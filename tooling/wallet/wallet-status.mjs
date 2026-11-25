// @ts-check
// Deploy-wallet status (Preprod ceremony). Garrett runs it.
//
//   node tooling/wallet/wallet-status.mjs --seed-file <file> [--state-file <file>] [--register-dust]
//
// The wallet resumes from, and saves to, its encrypted state file (default:
// next to the seed file, <name>.wallet-state; see wallet-state.mjs), the same
// file the ceremony uses: the first run does the long sync once, later runs
// and every ceremony step resume from it. A long first sync saves every minute
// and resumes if interrupted.
//
// Endpoints come from the environment (MIDNIGHT_NETWORK_ID, MIDNIGHT_INDEXER_URL,
// MIDNIGHT_NODE_URL, MIDNIGHT_PROOF_SERVER_URL). Prints the addresses, sync
// progress, NIGHT balance and UTXOs (registered for DUST or not) and the DUST
// balance. --register-dust registers the unregistered NIGHT for DUST
// generation (one transaction; waits until the NIGHT has generated enough DUST
// to pay its own fee). It never deploys or calls a contract. The seed is read
// from the file and never printed.
import * as Rx from 'rxjs';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { DustAddress, MidnightBech32m } from '@midnightntwrk/wallet-sdk';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import path from 'node:path';
import { openPersistentWallet, defaultStateFile } from './wallet-state.mjs';
import { readSeedFile, deriveAddresses } from './wallet-lib.mjs';

/** @type {any} */ (globalThis).WebSocket ??= WebSocket;

const NIGHT = '0'.repeat(64);
export const fmtNight = (/** @type {bigint} */ v) => `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;
export const fmtDust = (/** @type {bigint} */ v) => `${v / 10n ** 15n}.${(v % 10n ** 15n).toString().padStart(15, '0')}`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const i = argv.indexOf('--seed-file');
  const seedFile = i >= 0 ? argv[i + 1] : '';
  if (!seedFile || seedFile.startsWith('--')) throw new Error('usage: node tooling/wallet/wallet-status.mjs --seed-file <file> [--state-file <file>] [--register-dust]');
  const j = argv.indexOf('--state-file');
  const stateFile = j >= 0 && argv[j + 1] && !argv[j + 1].startsWith('--') ? path.resolve(argv[j + 1]) : defaultStateFile(seedFile);
  return { seedFile, stateFile, registerDust: argv.includes('--register-dust') };
}

async function run(/** @type {string[]} */ argv) {
  const { seedFile, stateFile, registerDust } = parseArgs(argv);
  const net = loadNetworkConfig();
  const seedHex = readSeedFile(seedFile);
  const a = deriveAddresses(Uint8Array.from(Buffer.from(seedHex, 'hex')), net.networkId);
  console.log(`[wallet] ${describeNetwork(net)}`);
  console.log(`[wallet] unshielded ${a.unshielded}\n[wallet] shielded   ${a.shielded}\n[wallet] dust       ${a.dust}`);
  const ctx = await openPersistentWallet({ seedHex, net, stateFile, log: (l) => console.log(l) });
  const progress = ctx.wallet.state().pipe(Rx.throttleTime(30_000)).subscribe((s) => {
    if (!s.isSynced) console.log(`[wallet] syncing... (NIGHT so far ${fmtNight(s.unshielded.balances[NIGHT] ?? 0n)})`);
  });
  const s = await ctx.wallet.waitForSyncedState();
  progress.unsubscribe();
  const coins = s.unshielded.availableCoins;
  const unregistered = coins.filter((c) => c.meta?.registeredForDustGeneration !== true);
  console.log(`[wallet] synced. NIGHT ${fmtNight(s.unshielded.balances[NIGHT] ?? 0n)} in ${coins.length} UTXO(s), ${coins.length - unregistered.length} registered for DUST`);
  console.log(`[wallet] DUST ${fmtDust(s.dust.balance(new Date()))}`);
  if (registerDust) {
    if (!unregistered.length) {
      console.log('[wallet] nothing to register: all NIGHT is registered (or there is none yet; fund from the faucet first)');
    } else {
      const { fee } = await ctx.wallet.estimateRegistration(unregistered);
      console.log(`[wallet] registering ${unregistered.length} NIGHT UTXO(s); waiting for ${fmtDust(fee)} DUST of generation to pay the fee`);
      await ctx.wallet.waitForGeneratedDust(unregistered, fee);
      const dustReceiver = MidnightBech32m.parse(a.dust).decode(DustAddress, net.networkId);
      const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
        unregistered, ctx.unshieldedKeystore.getPublicKey(), ctx.unshieldedKeystore.signDataAsync, /** @type {any} */ (dustReceiver),
      );
      const tx = await ctx.wallet.finalizeRecipe(recipe);
      console.log(`[wallet] DUST registration submitted: ${await ctx.wallet.submitTransaction(tx)}`);
      console.log('[wallet] re-run without --register-dust to watch the DUST balance grow');
    }
  }
  await ctx.close();
  console.log(`[wallet] state saved: ${stateFile}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).then(() => process.exit(0), (e) => {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  });
}
