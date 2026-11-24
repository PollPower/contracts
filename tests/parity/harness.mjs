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

/**
 * Used by the tests as `skip: buildExists(name) ? false : '...'`. A missing
 * build must FAIL, not skip: a silently skipped security test reads as green.
 * So this reports "present" unless WI16_ALLOW_MISSING_BUILDS=1, and the test
 * then fails in loadContract() with the missing path.
 */
export function buildExists(name) {
  const present = fs.existsSync(path.join(BUILD, name, 'contract', 'index.js'));
  return present || process.env.WI16_ALLOW_MISSING_BUILDS !== '1';
}

export async function loadContract(name) {
  const file = path.join(BUILD, name, 'contract', 'index.js');
  if (!fs.existsSync(file)) throw new Error(`missing ${file}: run \`npm run build:contracts\` first`);
  return import(pathToFileURL(file).href);
}

const PARENT_BLOCK = '00'.repeat(32);

/**
 * Several in-memory contracts that can call each other (ledger 9
 * cross-contract calls). Register each deployed handle with the build it came
 * from; a callee's state is served with the REAL verifier keys of that build
 * (the runtime checks them against the module's `expectedVk` on every call),
 * so callees need a full-ZK build. Every call resolves callees afresh, so a
 * callee's state is never stale between transactions.
 */
export function createWorld() {
  const entries = new Map(); // address -> { mod, handle, buildName }
  return {
    register(handle, mod, buildName) { entries.set(handle.address, { mod, handle, buildName }); return handle; },
    crossContract: {
      stateProvider: {
        async getContractState(_blockHash, address) {
          const e = entries.get(address);
          return e ? e.handle.contractState(e.buildName) : undefined;
        },
      },
      moduleProvider: {
        resolve(address) {
          const e = entries.get(address);
          return e ? async () => e.mod : undefined;
        },
      },
    },
  };
}

/**
 * Deploys `mod.Contract` in memory and returns a caller that threads the
 * circuit context through successive calls, like successive transactions.
 * `opts.world` (from createWorld) enables cross-contract calls.
 */
export async function deploy(mod, witnesses, ctorArgs = [], privateState = {}, opts = {}) {
  const contract = new mod.Contract(witnesses);
  const ctor = await contract.initialState(RT.createConstructorContext(privateState, COIN), ...ctorArgs);
  const address = RT.sampleContractAddress();
  let ctx = RT.createCircuitContext({
    circuitId: 'constructor',
    contractAddress: address,
    coinPublicKeyOrZswapState: COIN,
    contractState: ctor.currentContractState,
    privateState,
    ...(opts.world ? { parentBlockHash: PARENT_BLOCK, crossContract: opts.world.crossContract } : {}),
  });
  let balance = null;
  return {
    contract,
    address,
    /** Sets the contract's public token balances seen by later calls (Map<TokenType, bigint>). */
    setBalance(b) { balance = b; },
    /** The contract address as the 32 bytes `kernel.self().bytes` sees. */
    addressBytes: Uint8Array.from(Buffer.from(String(address).replace(/^0x/, ''), 'hex')),
    async call(circuitId, ...args) {
      // Each call is a new transaction: drop other contracts' cached state.
      const own = (rec) => (rec && address in rec ? { [address]: rec[address] } : {});
      const at = {
        ...ctx,
        callContext: { ...ctx.callContext, circuitId },
        queryContexts: own(ctx.queryContexts),
        gasCosts: own(ctx.gasCosts),
        zswapLocalStates: own(ctx.zswapLocalStates),
        contractStates: {},
        activeContracts: new Set([address]),
        callProofDataTrace: [],
        events: [],
      };
      if (balance) {
        const q = at.callContext.currentQueryContext;
        q.block = { ...q.block, balance };
      }
      const r = await contract.impureCircuits[circuitId](at, ...args);
      ctx = r.context;
      return r.result;
    },
    ledger() { return mod.ledger(ctx.callContext.currentQueryContext.state); },
    /** This contract's deployed state now: current data plus `buildName`'s verifier keys. */
    contractState(buildName) {
      const cs = new RT.ContractState();
      const data = ctx.callContext.currentQueryContext.state;
      cs.data = data instanceof RT.ChargedState ? data : new RT.ChargedState(data);
      const keys = path.join(BUILD, buildName, 'keys');
      for (const f of fs.existsSync(keys) ? fs.readdirSync(keys) : []) {
        if (!f.endsWith('.verifier')) continue;
        const op = new RT.ContractOperation();
        op.verifierKey = new Uint8Array(fs.readFileSync(path.join(keys, f)));
        cs.setOperation(f.slice(0, -'.verifier'.length), op);
      }
      return cs;
    },
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
