// @ts-check
// G16 I/O helpers shared by council-approve.mjs and g16-step.mjs: the params
// file, the TariffRegistry witnesses, and key signers.
//
// Keys: one key per command. Preprod: --key <file> (owner-key format, outside
// every repo) and its passphrase in G16_KEY_PASSPHRASE (from Read-Host
// -AsSecureString; never on the command line). Devnet dry run: --dry-keys
// <file>, the throwaway scalars written by g16-step.mjs --make-dry-params.
import fs from 'node:fs';
import path from 'node:path';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { parseG16Params } from './g16-lib.mjs';
import { signFieldWithKeyFile, signOwnerAction } from '../owner/owner-key-lib.mjs';
import { gitWorkTreeOf } from '../wallet/wallet-lib.mjs';

const MSG = new RT.CompactTypeVector(1, RT.CompactTypeField);

/** The G16 params, validated against K3 (inputs.tariff.refRateFiatPerKwh). */
export function loadG16(/** @type {string} */ file, /** @type {any} */ inputs) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`G16 params not found: ${abs}`);
  const k3 = inputs?.tariff?.refRateFiatPerKwh;
  if (k3 === undefined) throw new Error('--inputs has no tariff.refRateFiatPerKwh (K3)');
  return parseG16Params(JSON.parse(fs.readFileSync(abs, 'utf8')), { refRate: BigInt(k3) });
}

/** TariffRegistry witnesses: the charter proof comes from the params' charter. */
export function trWitnesses(/** @type {any} */ g) {
  return {
    charter_membership_proof: (/** @type {any} */ ctx, /** @type {Uint8Array} */ nodeId) => [ctx.privateState, g.charterProof(nodeId)],
    witness_divmod: (/** @type {any} */ ctx, /** @type {bigint} */ n, /** @type {bigint} */ d) => [ctx.privateState, { quotient: n / d, remainder: n % d }],
    action_log_path_bits: (/** @type {any} */ ctx, /** @type {bigint} */ seq) => [ctx.privateState, Array.from({ length: 24 }, (_, i) => ((seq >> BigInt(i)) & 1n) === 1n)],
  };
}

export const ROLES = ['validator', 'operator', 'owner'];

/**
 * @param {{ role: string, dry: boolean, keyFile?: string, dryKeys?: string, env?: Record<string, string | undefined> }} o
 * @returns {{ sign: (msg: bigint) => any, signOwner: (mod: any, circuit: string, args: any[], ebt: Uint8Array, nonce: bigint) => any }}
 */
export function signer({ role, dry, keyFile, dryKeys, env = process.env }) {
  if (!ROLES.includes(role)) throw new Error(`unknown key role ${role}`);
  if (dry) {
    if (keyFile) throw new Error('the dry run signs with --dry-keys, never with a real key file');
    if (!dryKeys) throw new Error('--dry-keys <file> is required in the dry run');
    const k = JSON.parse(fs.readFileSync(dryKeys, 'utf8'));
    if (!/DEVNET DRY RUN ONLY/.test(String(k.note))) throw new Error(`${dryKeys} is not a dry-run key file`);
    const sk = BigInt(k[role]);
    return {
      sign: (msg) => RT.jubjubSchnorrSign(MSG, [msg], sk),
      signOwner: (mod, circuit, args, ebt, nonce) => {
        const tag = new Uint8Array(32); tag.set(Buffer.from(circuit, 'utf8'));
        const m = mod.pureCircuits.ownerActionMessage(ebt, tag, mod.pureCircuits[`ownerDigest_${circuit}`](...args), nonce);
        return RT.jubjubSchnorrSign(MSG, [m], sk);
      },
    };
  }
  if (dryKeys) throw new Error('--dry-keys is for the devnet dry run only');
  if (!keyFile) throw new Error(`--key <file> (the ${role} key) is required`);
  const abs = path.resolve(keyFile);
  if (gitWorkTreeOf(path.dirname(abs))) throw new Error(`REFUSING: ${abs} is inside a git checkout`);
  const passphrase = env.G16_KEY_PASSPHRASE;
  if (!passphrase) throw new Error('G16_KEY_PASSPHRASE is required (from Read-Host -AsSecureString)');
  return {
    sign: (msg) => signFieldWithKeyFile({ keyFile: abs, passphrase, msg, checkMode: false }),
    signOwner: (mod, circuit, args, ebt, nonce) => signOwnerAction({ mod, keyFile: abs, passphrase, circuit, args, ebtAddressBytes: ebt, nonce, checkMode: false }),
  };
}
