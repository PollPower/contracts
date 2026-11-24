// @ts-check
// Network plumbing shared by the devnet pass and the Preprod ceremony
// (tooling/deploy/deploy-suite.mjs). Nothing here knows which network it is
// on: the caller opens it (openNetwork) with that network's wallet and store.
//
// - providersFor(build): Midnight.js 5 providers for one build, with
//   cross-contract support (module provider + ZK key registry over every bound
//   callee's build, matched by deployed verifier key).
// - deploy / join / liveState / finalizeContract (last verifier key + authority
//   lock in ONE maintenance update, then checkFinalized must pass).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { deployContract, findDeployedContract, submitInsertVerifierKeyTx } from '@midnight-ntwrk/midnight-js-contracts';
import { createProviders, withZkConfigDir } from '../midnight-providers.mjs';
import { checkFinalized, buildVerifierKeys, submitMaintenance, vkInsert, replaceAuthority, lockedAuthority } from './finalize.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUILD = path.join(ROOT, 'build', 'l9');

export function buildDir(/** @type {string} */ name) {
  const d = path.join(BUILD, name);
  if (!fs.existsSync(path.join(d, 'keys'))) throw new Error(`${name}: full-ZK build missing (node tooling/build-contracts.mjs --zk ${name})`);
  return d;
}

export async function loadModule(/** @type {string} */ name) {
  return import(pathToFileURL(path.join(buildDir(name), 'contract', 'index.js')).href);
}

/** CompiledContract for a build; no witnesses = vacant (witness-free contracts). */
export async function compiled(/** @type {string} */ name, /** @type {any} */ witnesses = null, tag = name) {
  const mod = await loadModule(name);
  const dir = buildDir(name);
  return CompiledContract.make(tag, mod.Contract).pipe(
    witnesses ? CompiledContract.withWitnesses(witnesses) : CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(dir),
  );
}

/**
 * @param {{ net: any, ctx: any, storeName: string, password: string, log?: any }} o
 */
export async function openNetwork({ net, ctx, storeName, password, log = console }) {
  const base = await createProviders(ctx, net, { zkConfigDir: BUILD, privateStateStoreName: storeName, privateStatePassword: password });
  const modules = new Map();
  const contractModuleProvider = {
    resolve(/** @type {string} */ address) {
      const name = modules.get(String(address).replace(/^0x/, '').toLowerCase());
      return name ? () => loadModule(name) : undefined;
    },
  };
  const providersFor = (/** @type {string} */ name) => {
    const own = withZkConfigDir(base, net, buildDir(name));
    const sources = [own.zkConfigProvider, ...[...new Set(modules.values())].filter((n) => n !== name).map((n) => new NodeZkConfigProvider(buildDir(n)))];
    const registry = new ZKConfigRegistry(sources);
    return { ...own, proofProvider: httpClientProofProvider({ url: net.proofServer, zkConfigProvider: registry }), contractModuleProvider };
  };
  /** Registers the build behind a deployed address, for cross-contract calls into it. */
  const bind = (/** @type {string} */ address, /** @type {string} */ name) => { modules.set(address.replace(/^0x/, '').toLowerCase(), name); };
  return { net, ctx, providersFor, bind, log };
}

/** Deploys build `name` with constructor args. */
export async function deploy(/** @type {any} */ dn, /** @type {string} */ name, /** @type {any[]} */ args, /** @type {any} */ witnesses = null) {
  const t0 = Date.now();
  const c = await compiled(name, witnesses);
  /** @type {any} */
  const deployed = await deployContract(/** @type {any} */ (dn.providersFor(name)), { compiledContract: /** @type {any} */ (c), args });
  const address = deployed.deployTxData.public.contractAddress;
  (dn.log ?? console).log(`[deploy] ${name} at ${address} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { deployed, address };
}

/** Re-joins a deployed contract (by address) with build `name`'s circuits. */
export async function join(/** @type {any} */ dn, /** @type {string} */ name, /** @type {string} */ address, /** @type {any} */ witnesses = null) {
  const c = await compiled(name, witnesses);
  return findDeployedContract(/** @type {any} */ (dn.providersFor(name)), { compiledContract: /** @type {any} */ (c), contractAddress: address });
}

/** A deployed contract's live state from the indexer (decoded with our runtime), or null. */
export async function liveState(/** @type {any} */ dn, /** @type {string} */ name, /** @type {string} */ address) {
  const read = await /** @type {any} */ (dn.providersFor(name)).publicDataProvider.queryContractState(address);
  return read ? read.contractState.deserialize({ v9: ContractState }) : null;
}

/**
 * Finalizes a deployment: inserts every audited verifier key the contract
 * lacks, the LAST one in the same maintenance update that locks the authority
 * (the complete contract never exists with a live deployer key), then requires
 * checkFinalized() to pass. For a full deploy the update only locks.
 */
export async function finalizeContract(/** @type {any} */ dn, /** @type {string} */ fullName, /** @type {string} */ address, /** @type {any} */ witnesses = null) {
  const log = dn.log ?? console;
  const providers = /** @type {any} */ (dn.providersFor(fullName));
  const c = await compiled(fullName, witnesses);
  const keys = buildVerifierKeys(buildDir(fullName));
  let live = await liveState(dn, fullName, address);
  const missing = [...keys.keys()].filter((id) => live.operation(id) === undefined);
  const last = missing.pop();
  for (const id of missing) {
    const t0 = Date.now();
    await submitInsertVerifierKeyTx(providers, /** @type {any} */ (c), address, id, keys.get(id));
    log.log(`[deploy]   vk ${id} inserted in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  live = await liveState(dn, fullName, address);
  const deployerKey = await providers.privateStateProvider.getSigningKey(address);
  const updates = [...(last ? [vkInsert(last, keys.get(last))] : []), replaceAuthority(lockedAuthority(live.maintenanceAuthority.counter))];
  const t0 = Date.now();
  await submitMaintenance(providers, address, live, updates, [deployerKey], dn.net.networkId);
  log.log(`[deploy]   ${last ? `final vk ${last} + ` : ''}authority locked in one update (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const r = checkFinalized(await liveState(dn, fullName, address), buildDir(fullName));
  if (!r.ok) throw new Error(`${fullName} at ${address} NOT finalized: ${r.problems.join(', ')}`);
  log.log(`[deploy]   ${fullName} finalized: ${keys.size} audited verifier keys, authority locked`);
  return [...missing, ...(last ? [last] : [])];
}
