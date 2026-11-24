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
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { deployContract, findDeployedContract, submitInsertVerifierKeyTx } from '@midnight-ntwrk/midnight-js-contracts';
import { loadNetworkConfig, describeNetwork } from '../midnight-network.mjs';
import { createProviders, withZkConfigDir } from '../midnight-providers.mjs';
import { devnetMasterWallet, assertLocalDevnet } from './devnet-wallet.mjs';
import { checkFinalized, buildVerifierKeys, submitMaintenance, vkInsert, replaceAuthority, lockedAuthority } from '../deploy/finalize.mjs';

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
  // Cross-contract callees: address -> build name (midnight-js 5 has no default
  // module provider; a call to an unbound address fails naming the call).
  const modules = new Map();
  const contractModuleProvider = {
    resolve(/** @type {string} */ address) {
      const name = modules.get(String(address).replace(/^0x/, '').toLowerCase());
      return name ? () => loadModule(name) : undefined;
    },
  };
  // Proving: a cross-contract call carries one proof per contract in the call
  // tree, so the proof provider resolves keys through a registry over this
  // build AND every bound callee's build (matched by deployed verifier key).
  const providersFor = (name) => {
    const own = withZkConfigDir(base, net, buildDir(name));
    const sources = [own.zkConfigProvider, ...[...new Set(modules.values())].filter((n) => n !== name).map((n) => new NodeZkConfigProvider(buildDir(n)))];
    const registry = new ZKConfigRegistry(sources);
    return { ...own, proofProvider: httpClientProofProvider({ url: net.proofServer, zkConfigProvider: registry }), contractModuleProvider };
  };
  /** Registers the build behind a deployed address, for cross-contract calls into it. */
  const bind = (/** @type {string} */ address, /** @type {string} */ name) => { modules.set(address.replace(/^0x/, '').toLowerCase(), name); };
  return { net, ctx, providersFor, bind };
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
 * A deployed contract's live state from the indexer, decoded with our own
 * runtime (midnight-js 5 hands out SerializedContractState). Null if absent.
 */
export async function liveState(dn, name, address) {
  const read = await /** @type {any} */ (dn.providersFor(name)).publicDataProvider.queryContractState(address);
  return read ? read.contractState.deserialize({ v9: ContractState }) : null;
}


/**
 * Finalizes a deployment: inserts every audited verifier key the contract
 * lacks, the LAST one in the same maintenance update that locks the authority
 * (so the complete contract never exists with a live deployer key), then
 * requires checkFinalized() to pass. For a full deploy (nothing missing) the
 * update only locks the authority.
 */
export async function finalizeContract(dn, fullName, address, witnesses = null) {
  const providers = /** @type {any} */ (dn.providersFor(fullName));
  const c = await compiled(fullName, witnesses);
  const keys = buildVerifierKeys(buildDir(fullName));
  let live = await liveState(dn, fullName, address);
  const missing = [...keys.keys()].filter((id) => live.operation(id) === undefined);
  const last = missing.pop();
  for (const id of missing) {
    const t0 = Date.now();
    await submitInsertVerifierKeyTx(providers, /** @type {any} */ (c), address, id, keys.get(id));
    console.log(`[devnet]   vk ${id} inserted in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  live = await liveState(dn, fullName, address);
  const deployerKey = await providers.privateStateProvider.getSigningKey(address);
  const updates = [...(last ? [vkInsert(last, keys.get(last))] : []), replaceAuthority(lockedAuthority(live.maintenanceAuthority.counter))];
  const t0 = Date.now();
  await submitMaintenance(providers, address, live, updates, [deployerKey], dn.net.networkId);
  console.log(`[devnet]   ${last ? `final vk ${last} + ` : ''}authority locked in one update (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const r = checkFinalized(await liveState(dn, fullName, address), buildDir(fullName));
  if (!r.ok) throw new Error(`${fullName} at ${address} NOT finalized: ${r.problems.join(', ')}`);
  console.log(`[devnet]   ${fullName} finalized: ${keys.size} audited verifier keys, authority locked`);
  return [...missing, ...(last ? [last] : [])];
}
