// @ts-check
// Local-devnet wallet for WI-16 tests: the dev chain's genesis master wallet,
// with its NIGHT registered for DUST so it can pay fees.
//
// The seed below is the PUBLIC dev-chain genesis seed documented in
// midnightntwrk/midnight-local-dev ("genesis master wallet (seed 0x00...001)").
// It only holds value on a local `undeployed` chain; this module refuses to
// run against any other network.
import * as Rx from 'rxjs';
import { createWallet } from '../midnight-providers.mjs';

export const DEV_GENESIS_SEED = `${'0'.repeat(63)}1`;

/** @param {import('../midnight-network.mjs').MidnightNetwork} net */
export function assertLocalDevnet(net) {
  if (net.networkId !== 'undeployed') {
    throw new Error(`devnet wallet refuses network "${net.networkId}": local devnet (undeployed) only`);
  }
}

/** @param {import('../midnight-network.mjs').MidnightNetwork} net */
export async function devnetMasterWallet(net) {
  assertLocalDevnet(net);
  const ctx = await createWallet(DEV_GENESIS_SEED, net);
  await ensureSpendableDust(ctx);
  return ctx;
}

/** Register unregistered NIGHT UTXOs for DUST generation, then wait for a spendable DUST coin. */
async function ensureSpendableDust(/** @type {Awaited<ReturnType<typeof createWallet>>} */ ctx) {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced), Rx.timeout(300_000)));
  console.log(`[devnet] master wallet synced; NIGHT UTXOs: ${state.unshielded.availableCoins.length}, DUST coins: ${state.dust.availableCoins.length}`);
  if (state.dust.availableCoins.length >= 1) return;
  const unregistered = state.unshielded.availableCoins.filter((c) => c.meta.registeredForDustGeneration === false);
  if (unregistered.length === 0) throw new Error('no NIGHT to register for DUST: is this the dev chain genesis wallet?');
  const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
    unregistered, ctx.unshieldedKeystore.getPublicKey(), ctx.unshieldedKeystore.signDataAsync,
  );
  const tx = await ctx.wallet.finalizeRecipe(recipe);
  console.log(`[devnet] DUST registration submitted: ${await ctx.wallet.submitTransaction(tx)}`);
  await Rx.firstValueFrom(ctx.wallet.state().pipe(
    Rx.filter((s) => s.dust.availableCoins.length >= 1),
    Rx.timeout(300_000),
  ));
  console.log('[devnet] spendable DUST available');
}
