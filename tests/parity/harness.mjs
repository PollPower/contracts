// Runs compiled (Compact 0.36.1) contracts offline with
// @midnight-ntwrk/compact-runtime 0.21.0, so the parity tests compare the
// CHOSEN encodings of the real circuits against the JS mirrors
// (tests/lib.mjs) and the ceremony/daemon tooling. No network, no proofs.
// Build first: `npm run build:contracts`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as RT from '@midnight-ntwrk/compact-runtime';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUILD = path.join(ROOT, 'build', 'l9');
export const COIN = '00'.repeat(32);

export function buildExists(name) {
  return fs.existsSync(path.join(BUILD, name, 'contract', 'index.js'));
}

export async function loadContract(name) {
  const file = path.join(BUILD, name, 'contract', 'index.js');
  if (!fs.existsSync(file)) throw new Error(`missing ${file}: run \`npm run build:contracts\` first`);
  return import(pathToFileURL(file).href);
}

/**
 * Deploys `mod.Contract` in memory and returns a caller that threads the
 * circuit context through successive calls, like successive transactions.
 */
export async function deploy(mod, witnesses, ctorArgs = [], privateState = {}) {
  const contract = new mod.Contract(witnesses);
  const ctor = await contract.initialState(RT.createConstructorContext(privateState, COIN), ...ctorArgs);
  let ctx = RT.createCircuitContext({
    circuitId: 'constructor',
    contractAddress: RT.sampleContractAddress(),
    coinPublicKeyOrZswapState: COIN,
    contractState: ctor.currentContractState,
    privateState,
  });
  return {
    contract,
    async call(circuitId, ...args) {
      const at = { ...ctx, callContext: { ...ctx.callContext, circuitId } };
      const r = await contract.impureCircuits[circuitId](at, ...args);
      ctx = r.context;
      return r.result;
    },
    ledger() { return mod.ledger(ctx.callContext.currentQueryContext.state); },
  };
}

export const RTlib = RT;
export const hex = (u) => Buffer.from(u).toString('hex');
export const b32 = (byte) => new Uint8Array(32).fill(byte);

/** The ceremony.mjs / mirror-daemon builder: compact-runtime persistentHash over Vector<N, Bytes<32>>. */
export function runtimePersistentHash(parts) {
  return RT.persistentHash(new RT.CompactTypeVector(parts.length, new RT.CompactTypeBytes(32)), parts);
}
/** ceremony.mjs padTag(): UTF-8 bytes, zero-padded to 32. */
export function padTag(tag) {
  const out = new Uint8Array(32);
  out.set(Buffer.from(tag, 'utf8'), 0);
  return out;
}
