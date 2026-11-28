// @ts-check
// Cross-contract call support for Midnight.js 5 providers (ledger 9).
//
// Midnight.js has no default way to find a callee's code: a circuit that calls
// another contract fails unless `contractModuleProvider` maps the callee's
// address to its compiled module. And a cross-contract transaction carries one
// proof per contract in the call tree, so the proof provider must find keys
// for every callee too: a ZKConfigRegistry over the caller's and the callees'
// builds (matched by the deployed verifier key, so a redeploy or a wrong
// build cannot be used by mistake).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';
import { serialProofProvider } from './proving/serial-proof-provider.mjs';   // one proof at a time (job capacity 1)
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

const norm = (/** @type {string} */ a) => String(a).replace(/^0x/, '').toLowerCase();

/**
 * @param {any} providers  base providers (any build)
 * @param {{ proofServer: string }} net
 * @param {{ ownBuildDir: string, callees: { address: string, buildDir: string }[] }} o
 */
export function withCrossContract(providers, net, { ownBuildDir, callees }) {
  const byAddress = new Map(callees.map((c) => [norm(c.address), c.buildDir]));
  const contractModuleProvider = {
    resolve(/** @type {string} */ address) {
      const dir = byAddress.get(norm(address));
      return dir ? () => import(pathToFileURL(path.join(dir, 'contract', 'index.js')).href) : undefined;
    },
  };
  const own = new NodeZkConfigProvider(ownBuildDir);
  const dirs = [...new Set(callees.map((c) => c.buildDir))].filter((d) => d !== ownBuildDir);
  const registry = new ZKConfigRegistry([own, ...dirs.map((d) => new NodeZkConfigProvider(d))]);
  return {
    ...providers,
    zkConfigProvider: own,
    proofProvider: serialProofProvider({ url: net.proofServer, zkConfigProvider: registry }),
    contractModuleProvider,
  };
}
