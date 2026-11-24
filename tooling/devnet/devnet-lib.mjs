// @ts-check
// WI-16 step 4: shared helpers for the local-devnet stack run (stack.mjs).
// LOCAL DEVNET ONLY (MIDNIGHT_NETWORK_ID=undeployed): every entry point calls
// assertLocalDevnet. Deploys are a manual ceremony on real networks; nothing
// here is meant for Preprod/Mainnet.
//
// Endpoints come from the environment (tooling/midnight-network.mjs). Through
// the SSH tunnel to kenya's devnet:
//   MIDNIGHT_NETWORK_ID=undeployed
//   MIDNIGHT_NODE_URL=http://127.0.0.1:19944
//   MIDNIGHT_INDEXER_URL=http://127.0.0.1:18088/api/v4/graphql
//   MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:16300
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract, submitInsertVerifierKeyTx } from '@midnight-ntwrk/midnight-js-contracts';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createProviders, withZkConfigDir } from '../midnight-providers.mjs';
import { devnetMasterWallet, assertLocalDevnet } from './devnet-wallet.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUILD = path.join(ROOT, 'build', 'l9');
const STATE_FILE = path.join(ROOT, 'build', 'devnet', 'state.json');

/** Run state (addresses, keys' public parts, progress) so a long run can resume. */
export const state = {
  load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } },
  save(s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2));
  },
  file: STATE_FILE,
};

export function buildDir(name) {
  const d = path.join(BUILD, name);
  if (!fs.existsSync(path.join(d, 'keys'))) throw new Error(`${name}: full-ZK build missing (node tooling/build-contracts.mjs --zk ${name})`);
  return d;
}

export async function loadModule(name) {
  return import(pathToFileURL(path.join(buildDir(name), 'contract', 'index.js')).href);
}

/** CompiledContract for a build; `witnesses` empty = vacant (witness-free contracts). */
export async function compiled(name, witnesses = null, tag = name) {
  const mod = await loadModule(name);
  const dir = buildDir(name);
  return CompiledContract.make(tag, mod.Contract).pipe(
    witnesses ? CompiledContract.withWitnesses(witnesses) : CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(dir),
  );
}

export async function openDevnet() {
  const net = loadNetworkConfig();
  assertLocalDevnet(net);
  console.log(`[devnet] ${describeNetwork(net)}`);
  const ctx = await devnetMasterWallet(net);
  const base = await createProviders(ctx, net, {
    zkConfigDir: BUILD,
    privateStateStoreName: 'wi16-devnet-stack',
    privateStatePassword: process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? 'Local-Devnet-Only-1',   // local devnet only
  });
  const providersFor = (name) => withZkConfigDir(base, net, buildDir(name));
  return { net, ctx, providersFor };
}

/** Deploys build `name` (or `deployAs`, e.g. a ceremony variant) with constructor args. */
export async function deploy(dn, name, args, witnesses = null) {
  const t0 = Date.now();
  const c = await compiled(name, witnesses);
  /** @type {any} */
  const deployed = await deployContract(/** @type {any} */ (dn.providersFor(name)), { compiledContract: /** @type {any} */ (c), args });
  const address = deployed.deployTxData.public.contractAddress;
  console.log(`[devnet] deployed ${name} at ${address} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { deployed, address };
}

/** Re-joins a deployed contract (by address) with build `name`'s circuits. */
export async function join(dn, name, address, witnesses = null) {
  const c = await compiled(name, witnesses);
  return findDeployedContract(/** @type {any} */ (dn.providersFor(name)), { compiledContract: /** @type {any} */ (c), contractAddress: address });
}

/**
 * Staged deploy, second half: insert every verifier key of the FULL build that
 * the (ceremony-deployed) contract does not have yet, one maintenance tx each.
 * Returns the circuit ids inserted.
 */
export async function insertMissingVks(dn, fullName, address, witnesses = null) {
  const providers = /** @type {any} */ (dn.providersFor(fullName));
  const c = await compiled(fullName, witnesses);
  const live = await providers.publicDataProvider.queryContractState(address);
  const dir = path.join(buildDir(fullName), 'keys');
  const inserted = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.verifier')).sort()) {
    const id = f.slice(0, -'.verifier'.length);
    if (live?.operation(id) !== undefined) continue;
    const vk = fs.readFileSync(path.join(dir, f));
    const t0 = Date.now();
    await submitInsertVerifierKeyTx(providers, /** @type {any} */ (c), address, id, vk);
    console.log(`[devnet]   vk ${id} (${vk.length} B) inserted in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    inserted.push(id);
  }
  return inserted;
}
