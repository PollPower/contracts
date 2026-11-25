// @ts-check
// Deploy-wallet status (Preprod ceremony). Garrett runs it.
//
//   node tooling/wallet/wallet-status.mjs --seed-file <file> [--register-dust]
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
import { createWallet } from '../midnight-providers.mjs';
import { readSeedFile, deriveAddresses } from './wallet-lib.mjs';

/** @type {any} */ (globalThis).WebSocket ??= WebSocket;

const NIGHT = '0'.repeat(64);
export const fmtNight = (/** @type {bigint} */ v) => `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;
export const fmtDust = (/** @type {bigint} */ v) => `${v / 10n ** 15n}.${(v % 10n ** 15n).toString().padStart(15, '0')}`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const i = argv.indexOf('--seed-file');
  const seedFile = i >= 0 ? argv[i + 1] : '';
  if (!seedFile || seedFile.startsWith('--')) throw new Error('usage: node tooling/wallet/wallet-status.mjs --seed-file <file> [--register-dust]');
  return { seedFile, registerDust: argv.includes('--register-dust') };
}

async function run(/** @type {string[]} */ argv) {
  const { seedFile, registerDust } = parseArgs(argv);
  const net = loadNetworkConfig();
  const seedHex = readSeedFile(seedFile);
  const a = deriveAddresses(Uint8Array.from(Buffer.from(seedHex, 'hex')), net.networkId);
  console.log(`[wallet] ${describeNetwork(net)}`);
  console.log(`[wallet] unshielded ${a.unshielded}\n[wallet] shielded   ${a.shielded}\n[wallet] dust       ${a.dust}`);
  const ctx = await createWallet(seedHex, net);
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
  await /** @type {any} */ (ctx.wallet).stop?.();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).then(() => process.exit(0), (e) => {
    console.error(String(/** @type {any} */ (e)?.message ?? e));
    process.exit(1);
  });
}
