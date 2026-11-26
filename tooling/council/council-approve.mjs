// @ts-check
// Council approval with the rings (Multisig v8), first used on Preprod for the
// EBT -> Living Dividend binding (EBT council op 0, needed in G16 anyway).
//
//   prepare  --action ld-bind --out <pending.json>                      read-only: computes the hash to sign
//   status   --pending <pending.json>                                    read-only: approvals so far
//   submit   --pending <pending.json> --result <ring-result.json> [--slot N]   one approval (a transaction)
//   execute  --pending <pending.json>                                    runs the approved action (a transaction)
//
// Common: --record <ceremony record> (default build/preprod/ceremony-record.json),
// --inputs <inputs file> (the escrow-attestor key the op-0 hash binds), and
// --council-keys <council-keys.json> (the off-chain slots; must equal the chain).
// Preprod transactions need --i-have-garretts-go-ahead; --devnet-dry-run uses
// the local devnet, the dry run's record and the devnet genesis wallet.
//
// The digest every member signs is Multisig v8 approvalDigest(council, actionHash,
// epoch), the same for all slots. submit refuses (see council-approval-lib.mjs)
// unless the ring result is for that digest, signed with a key that IS council
// slot 0, 1 or 2 on chain (and in the council file), and verifies; it also
// refuses a slot that already approved. Nothing here ever holds a private key.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ROOT, loadModule, liveState } from '../deploy/network.mjs';
import { checkRingResult, slotsFromLedger, assertSlotsMatchFile } from './council-approval-lib.mjs';
import { hexToBytes } from '../tangem/ring-signature.mjs';

const hx = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString('hex');
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

function args(/** @type {string[]} */ argv) {
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return { cmd: argv[0], arg, has: (/** @type {string} */ k) => argv.includes(k) };
}

/** Read-only view of the chain (indexer only, no wallet). */
function reader(/** @type {any} */ net) {
  const pdp = indexerPublicDataProvider({ queryURL: net.indexer, subscriptionURL: net.indexerWS });
  const dn = { providersFor: () => ({ publicDataProvider: pdp }) };
  return {
    async ledger(/** @type {string} */ name, /** @type {string} */ address) {
      const mod = await loadModule(name);
      const st = await liveState(dn, name, address);
      if (!st) throw new Error(`${name} at ${address}: no state from the indexer`);
      return mod.ledger(st.data);
    },
  };
}

/** approvalKey(h, epoch), as the Multisig v8 circuit computes it (not exported by the build). */
export function approvalKeyOf(/** @type {Uint8Array} */ h, /** @type {bigint} */ epoch) {
  const pad = new Uint8Array(32); pad.set(new TextEncoder().encode('pp:ms:v8:approvalKey'));
  return RT.persistentHash(new RT.CompactTypeVector(3, new RT.CompactTypeBytes(32)), [pad, h, RT.convertBigintToBytes(32, epoch)]);
}

/** On-chain council slots (checked against the council file), epoch, and who approved this action. */
async function councilView(/** @type {any} */ rd, /** @type {any} */ p, /** @type {string} */ councilKeysFile) {
  const L = await rd.ledger('multisig-v8', p.council);
  const slots = slotsFromLedger(L);
  assertSlotsMatchFile(slots, JSON.parse(fs.readFileSync(councilKeysFile, 'utf8')).council);
  const epoch = BigInt(L._epoch);
  if (epoch !== BigInt(p.epoch)) throw new Error(`REFUSED: council epoch is ${epoch}, the pending approval was prepared for epoch ${p.epoch} (the council rotated): prepare again`);
  const key = approvalKeyOf(hexToBytes(p.actionHash), epoch);
  const bySlot = L._approvals.member(key) ? slots.filter((s) => L._approvals.lookup(key).member(BigInt(s.slot))).map((s) => s.slot) : [];
  return { slots, count: bySlot.length, bySlot, threshold: Number(L._threshold) };
}

async function main() {
  const { cmd, arg, has } = args(process.argv.slice(2));
  if (!['prepare', 'status', 'submit', 'execute'].includes(String(cmd))) throw new Error('usage: council-approve.mjs prepare|status|submit|execute ... (see the header)');
  const dry = has('--devnet-dry-run');
  if (dry && has('--i-have-garretts-go-ahead')) throw new Error('refusing: --devnet-dry-run or --i-have-garretts-go-ahead, not both');
  const { loadNetworkConfig, describeNetwork } = await import('../midnight-network.mjs');
  const net = loadNetworkConfig();
  if (dry && net.networkId !== 'undeployed') throw new Error(`refusing: the dry run is local devnet only, not ${net.networkId}`);
  if (!dry && net.networkId !== 'preprod') throw new Error(`refusing: network is ${net.networkId}, not preprod`);
  const councilKeys = String(arg('--council-keys') ?? '');
  if (!councilKeys) throw new Error('--council-keys <council-keys.json> is required (the off-chain slots)');
  const rd = reader(net);
  const tag = dry ? '[approve:dry-run]' : '[approve:preprod]';

  if (cmd === 'prepare') {
    if (arg('--action') !== 'ld-bind') throw new Error('--action must be ld-bind (EBT council op 0: bind Living Dividend v3, once)');
    const recFile = path.resolve(String(arg('--record') ?? path.join(ROOT, 'build', 'preprod', 'ceremony-record.json')));
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    for (const k of ['council', 'ebt', 'ld']) if (!rec[k] || !rec[`${k}Final`]) throw new Error(`record ${recFile}: ${k} is not deployed and finalized`);
    const inputs = JSON.parse(fs.readFileSync(String(arg('--inputs')), 'utf8'));
    const esc = inputs.ebt?.escrowAttestorPk;
    if (!esc) throw new Error('--inputs: no ebt.escrowAttestorPk');
    const escrow = { x: BigInt(esc.x), y: BigInt(esc.y) };
    const out = path.resolve(String(arg('--out') ?? ''));
    if (!arg('--out') || fs.existsSync(out)) throw new Error('--out <new pending.json> is required and must not exist');
    const ebtL = await rd.ledger('ebt-v8', rec.ebt);
    if (ebtL._livingDividendAddress.is_some) throw new Error('REFUSED: Living Dividend is already bound in this EBT');
    const ebtMod = await loadModule('ebt-v8');
    const ms = await loadModule('multisig-v8');
    const t = nowSec();
    const actionHash = ebtMod.pureCircuits.councilActionHash(hexToBytes(rec.ebt), 0n, { bytes: hexToBytes(rec.ld) }, escrow, t);
    const msL = await rd.ledger('multisig-v8', rec.council);
    assertSlotsMatchFile(slotsFromLedger(msL), JSON.parse(fs.readFileSync(councilKeys, 'utf8')).council);
    const epoch = BigInt(msL._epoch);
    const digest = ms.pureCircuits.approvalDigest(hexToBytes(rec.council), actionHash, epoch);
    const p = {
      network: net.networkId, action: 'ld-bind (EBT council op 0)', council: rec.council, ebt: rec.ebt, ld: rec.ld,
      escrowAttestorPk: { x: String(escrow.x), y: String(escrow.y) }, time: String(t), epoch: String(epoch),
      threshold: String(msL._threshold), actionHash: hx(actionHash), digest: hx(digest),
    };
    fs.writeFileSync(out, JSON.stringify(p, null, 2) + '\n', { flag: 'wx' });
    console.log(`${tag} ${describeNetwork(net)}`);
    console.log(`${tag} action: bind Living Dividend ${rec.ld} in EBT ${rec.ebt} (op 0, once)`);
    console.log(`${tag} council ${rec.council}, epoch ${epoch}, threshold ${msL._threshold} of 3; slots match the council file`);
    console.log(`\nHASH TO SIGN (each member, on the ring-check screen):\n\n    ${hx(digest)}\n`);
    console.log(`${tag} pending approval written: ${out}`);
    return;
  }

  const p = JSON.parse(fs.readFileSync(String(arg('--pending')), 'utf8'));
  if (p.network !== net.networkId) throw new Error(`REFUSED: the pending approval is for ${p.network}, this is ${net.networkId}`);
  const v = await councilView(rd, p, councilKeys);
  console.log(`${tag} ${p.action}: approvals ${v.count}/${v.threshold} (slots ${v.bySlot.join(', ') || 'none'})`);
  if (cmd === 'status') return;

  if (!dry && !has('--i-have-garretts-go-ahead')) throw new Error('refusing: a Preprod transaction; pass --i-have-garretts-go-ahead');
  const claimed = arg('--slot') !== undefined ? Number(arg('--slot')) : undefined;
  let check;
  if (cmd === 'submit') {
    const result = JSON.parse(fs.readFileSync(String(arg('--result')), 'utf8'));
    check = checkRingResult({ result, digestHex: p.digest, slots: v.slots, claimedSlot: claimed });
    if (v.bySlot.includes(check.slot)) throw new Error(`REFUSED: council slot ${check.slot} has already approved this action`);
    console.log(`${tag} ring result OK: council slot ${check.slot}, signature ${check.encoding}${check.wasHighS ? ' (S normalised to low-S)' : ''}, verifies against the on-chain slot key`);
  } else if (v.count < v.threshold) {
    throw new Error(`REFUSED: ${v.count}/${v.threshold} approvals; execute needs the threshold`);
  }

  // Transactions: the deploy wallet (persisted state, G3b) or the devnet genesis wallet.
  const { openPersistentWallet } = await import('../wallet/wallet-state.mjs');
  const { openNetwork, join } = await import('../deploy/network.mjs');
  let wallet;
  if (dry) {
    const dw = await import('../devnet/devnet-wallet.mjs');
    wallet = await openPersistentWallet({ seedHex: dw.DEV_GENESIS_SEED, net, stateFile: String(arg('--wallet-state')) });
    await dw.ensureSpendableDust(wallet);
  } else {
    const { deployWalletSeed, walletStateFile } = await import('../deploy/preprod-ceremony.mjs');
    wallet = await openPersistentWallet({ seedHex: deployWalletSeed(), net, stateFile: walletStateFile() });
  }
  try {
    const dn = await openNetwork({ net, ctx: wallet, storeName: dry ? 'pp-approve-dryrun' : 'pp-preprod-approve',
      password: process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD ?? (dry ? 'Local-Devnet-Only-1' : '') });
    dn.bind(p.council, 'multisig-v8');
    dn.bind(p.ebt, 'ebt-v8');
    if (cmd === 'submit' && check) {
      const council = await join(dn, 'multisig-v8', p.council);
      const t0 = Date.now();
      await council.callTx.approve(hexToBytes(p.actionHash), BigInt(check.slot), { r: check.r, s: check.s });
      const after = await councilView(rd, p, councilKeys);
      console.log(`${tag} approval by slot ${check.slot} landed in ${((Date.now() - t0) / 1000).toFixed(0)}s; approvals ${after.count}/${after.threshold} (slots ${after.bySlot.join(', ')})`);
    } else {
      const ebt = await join(dn, 'ebt-v8', p.ebt);
      const t0 = Date.now();
      await ebt.callTx.execMultisigOp(0n, { bytes: hexToBytes(p.ld) }, { x: BigInt(p.escrowAttestorPk.x), y: BigInt(p.escrowAttestorPk.y) }, BigInt(p.time));
      const L = await rd.ledger('ebt-v8', p.ebt);
      const bound = L._livingDividendAddress.is_some ? hx(L._livingDividendAddress.value.bytes) : '(none)';
      if (bound !== String(p.ld).toLowerCase()) throw new Error(`EBT reports Living Dividend ${bound}, expected ${p.ld}`);
      console.log(`${tag} executed in ${((Date.now() - t0) / 1000).toFixed(0)}s: EBT ${p.ebt} now binds Living Dividend ${bound}`);
    }
  } finally {
    if ('close' in wallet) { await wallet.close(); console.log(`${tag} wallet state saved`); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => process.exit(0), (e) => { console.error(`[approve] ${String(e?.message ?? e)}`); process.exit(1); });
}
