// @ts-check
// THE deploy script for the WI-16 suite (Garrett, 2026-11-24): the devnet pass
// and the Preprod ceremony call these same functions, unchanged; only the
// inputs (keys, constructor parameters, network) differ. Each step deploys and
// FINALIZES its contract (all audited verifier keys; the last one in the same
// update that locks the maintenance authority), then checkFinalized must pass.
//
// Order (each step needs the previous one's address):
//   deployCouncil -> deployTariffRegistry -> [TR setup: bootstrap, schedule,
//   class, via the council] -> deployEbt (mirrors TR's current action-log
//   root) -> deployLd.
// Post-deploy setup (schedule registration, mirrors, producer attestation,
// chip registration, LD bind, member registration) is NOT part of this script:
// on Preprod it is done by the council's rings and the owner key.
//
// suiteManifest(): SHA-256 of every build that goes on chain (verifier keys,
// generated contract code, contract-info) and of this deploy code. A devnet
// pass records it; the Preprod entry refuses to deploy anything else.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, buildDir, deploy, finalizeContract, liveState, loadModule } from './network.mjs';
import { buildCouncilConstructorArgs } from '../council/council-keys-guard.mjs';

export const SUITE_BUILDS = ['multisig-v8', 'tariff-registry-v1', 'tariff-registry-v1-ceremony', 'ebt-v8', 'ebt-v8-ceremony', 'living-dividend-v3'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOY_CODE = [
  path.join(HERE, 'deploy-suite.mjs'), path.join(HERE, 'network.mjs'), path.join(HERE, 'finalize.mjs'),
  path.join(HERE, '..', 'council', 'council-keys-guard.mjs'), path.join(HERE, '..', 'midnight-providers.mjs'),
  path.join(HERE, '..', 'proving', 'serial-proof-provider.mjs'),
];

const sha = (/** @type {Buffer | string} */ b) => crypto.createHash('sha256').update(b).digest('hex');
/** Line-ending-insensitive file hash (Windows checkouts convert to CRLF). */
const fileHash = (/** @type {string} */ f) => sha(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));

/** { builds: { name: hash }, deployCode: { file: hash } } */
export function suiteManifest() {
  const builds = {};
  for (const name of SUITE_BUILDS) {
    const dir = buildDir(name);
    const h = crypto.createHash('sha256');
    const keys = fs.readdirSync(path.join(dir, 'keys')).filter((f) => f.endsWith('.verifier')).sort();
    for (const f of keys) { h.update(f); h.update(fs.readFileSync(path.join(dir, 'keys', f))); }
    h.update(fs.readFileSync(path.join(dir, 'contract', 'index.js')));
    const info = path.join(dir, 'compiler', 'contract-info.json');
    if (fs.existsSync(info)) h.update(fs.readFileSync(info));
    /** @type {any} */ (builds)[name] = h.digest('hex');
  }
  const deployCode = Object.fromEntries(DEPLOY_CODE.map((f) => [path.relative(ROOT, f).replace(/\\/g, '/'), fileHash(f)]));
  return { builds, deployCode };
}

/** Differences between two manifests (empty = identical). */
export function manifestDiff(/** @type {any} */ a, /** @type {any} */ b) {
  const out = [];
  for (const sec of ['builds', 'deployCode']) {
    const keys = new Set([...Object.keys(a?.[sec] ?? {}), ...Object.keys(b?.[sec] ?? {})]);
    for (const k of keys) if (a?.[sec]?.[k] !== b?.[sec]?.[k]) out.push(`${sec}:${k}`);
  }
  return out;
}

const hex = (/** @type {string} */ h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/**
 * Each step: `rec` is the run record (addresses + progress; persisted by
 * `save`), so a step interrupted after its deploy resumes at finalization.
 * @typedef {{ dn: any, rec: any, save: () => void }} Ctx
 */

/** Council (Multisig v8). inputs: { points: Secp256k1 points, threshold } (devnet keys refused off-devnet). */
export async function deployCouncil(/** @type {Ctx} */ { dn, rec, save }, /** @type {{ points: any[], threshold: bigint }} */ inputs) {
  if (!rec.council) {
    const { address } = await deploy(dn, 'multisig-v8', buildCouncilConstructorArgs(inputs.points, inputs.threshold, dn.net.networkId));
    rec.council = address;
    save();
  }
  dn.bind(rec.council, 'multisig-v8');
  if (!rec.councilFinal) { await finalizeContract(dn, 'multisig-v8', rec.council); rec.councilFinal = true; save(); }
  return rec.council;
}

/** TariffRegistry v1 (staged). inputs: { governanceRoot, refRateFiatPerKwh, validatorPk, witnesses }. */
export async function deployTariffRegistry(/** @type {Ctx} */ { dn, rec, save }, /** @type {any} */ inputs) {
  if (!rec.council) throw new Error('deployTariffRegistry: council first');
  if (!rec.tr) {
    const { address } = await deploy(dn, 'tariff-registry-v1-ceremony',
      [{ bytes: hex(rec.council) }, inputs.governanceRoot, inputs.refRateFiatPerKwh, inputs.validatorPk], inputs.witnesses);
    rec.tr = address;
    save();
  }
  dn.bind(rec.tr, 'tariff-registry-v1');
  if (!rec.trFinal) { await finalizeContract(dn, 'tariff-registry-v1', rec.tr, inputs.witnesses); rec.trFinal = true; save(); }
  return rec.tr;
}

/**
 * EBT v8 (staged). inputs: { ownerPk, meterAuthorityPk, operationsRecipient, daoRecipient, escrowAttestorPk }
 * (recipients: 32-byte hex). The registry action-log root is TR's CURRENT root
 * (read from the chain at deploy time), recorded in rec.ebtRoot.
 */
export async function deployEbt(/** @type {Ctx} */ { dn, rec, save }, /** @type {any} */ inputs) {
  if (!rec.council || !rec.tr) throw new Error('deployEbt: council and TariffRegistry first');
  if (!rec.ebt) {
    const trMod = await loadModule('tariff-registry-v1');
    const trState = await liveState(dn, 'tariff-registry-v1', rec.tr);
    if (!trState) throw new Error(`TariffRegistry ${rec.tr}: no state`);
    const root = trMod.ledger(trState.data).registryActionLogRoot;
    const { address } = await deploy(dn, 'ebt-v8-ceremony', [
      inputs.ownerPk, inputs.meterAuthorityPk, { bytes: hex(rec.council) },
      { bytes: hex(inputs.operationsRecipient) }, { bytes: hex(inputs.daoRecipient) }, inputs.escrowAttestorPk, root,
    ]);
    rec.ebt = address;
    rec.ebtRoot = Buffer.from(root).toString('hex');
    save();
  }
  dn.bind(rec.ebt, 'ebt-v8');
  if (!rec.ebtFinal) { await finalizeContract(dn, 'ebt-v8', rec.ebt); rec.ebtFinal = true; save(); }
  return rec.ebt;
}

/** Living Dividend v3 (full deploy). inputs: { witnesses }. */
export async function deployLd(/** @type {Ctx} */ { dn, rec, save }, /** @type {any} */ inputs) {
  if (!rec.council || !rec.ebt) throw new Error('deployLd: council and EBT first');
  if (!rec.ld) {
    const { address } = await deploy(dn, 'living-dividend-v3', [{ bytes: hex(rec.ebt) }, { bytes: hex(rec.council) }], inputs.witnesses);
    rec.ld = address;
    save();
  }
  dn.bind(rec.ld, 'living-dividend-v3');
  if (!rec.ldFinal) { await finalizeContract(dn, 'living-dividend-v3', rec.ld, inputs.witnesses); rec.ldFinal = true; save(); }
  return rec.ld;
}
