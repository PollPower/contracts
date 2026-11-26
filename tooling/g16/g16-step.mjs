// @ts-check
// G16 steps that need no ring approval (the council steps go through
// tooling/council/council-approve.mjs: tr-charter, tr-schedule, tr-lane).
//
//   status      read-only: what is done and what comes next (indexer only)
//   bootstrap   TR bootstrapActionLog(24)                         no key
//   retune      TR retuneClass (the class split + rate)           operator key
//   ebt-mirror  EBT syncRegistryRoot + mirror schedule/class/lanes no key
//   k5-swap     EBT execOwnerOp(1) = setMeterAuthority             owner key (K4)
//
//   node tooling/g16/g16-step.mjs <step> --g16 <params.json> --inputs <inputs.json> [--record <ceremony record>]
//        [--key <file> (passphrase in G16_KEY_PASSPHRASE) | --dry-keys <file>]
//        (--i-have-garretts-go-ahead | --devnet-dry-run --wallet-state <file>)
//   node tooling/g16/g16-step.mjs --devnet-dry-run --make-dry-params <dir> --inputs <dry-run inputs.json>
//
// Every step re-reads the chain, plans with tooling/g16/g16-lib.mjs, refuses
// anything out of order, does nothing if the chain already has it, and reads
// the result back. Preprod transactions need --i-have-garretts-go-ahead.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as RT from '@midnight-ntwrk/compact-runtime';
import { ROOT, loadModule } from '../deploy/network.mjs';
import { reader } from '../council/council-approve.mjs';
import { planBootstrap, planCharter, planSchedule, planRetune, planLane, planEbtMirror, planK5Swap, hex } from './g16-lib.mjs';
import { loadG16, trWitnesses, signer } from './g16-context.mjs';
import { ActionLogTree } from '../../tests/contract/settle-world.mjs';
import { hexToBytes } from '../tangem/ring-signature.mjs';
import { privateStatePassword } from '../wallet/private-state-password.mjs';

const STEPS = ['status', 'bootstrap', 'retune', 'ebt-mirror', 'k5-swap'];
const KEY_ROLE = /** @type {Record<string, string>} */ ({ retune: 'operator', 'k5-swap': 'owner' });
const nowSec = () => BigInt(Math.floor(Date.now() / 1000) - 120);   // safely not ahead of block time

/** The JS action-log tree and entries, from a TR ledger. */
export function actionLogOf(/** @type {any} */ trL) {
  const tree = new ActionLogTree(), entries = [];
  for (let i = 0n; i < BigInt(trL._actionSeq); i++) { const e = trL._actionLog.lookup(i); entries.push(e); tree.append(e.payloadHash); }
  return { tree, entries };
}

/** Read-only: every G16 step's state, in order. */
export async function g16Status(/** @type {any} */ rd, /** @type {any} */ rec, /** @type {any} */ g) {
  const trP = (await loadModule('tariff-registry-v1')).pureCircuits;
  const tr = hexToBytes(rec.tr), t = nowSec();
  const trL = await rd.ledger('tariff-registry-v1', rec.tr);
  const eL = await rd.ledger('ebt-v8', rec.ebt);
  /** @type {[string, string, () => any][]} */
  const rows = [
    ['1 bootstrap', 'g16-step bootstrap', () => planBootstrap(trL)],
    ['2 charter', 'council-approve --action tr-charter', () => planCharter(tr, trL, g, t)],
    ['3 schedule', 'council-approve --action tr-schedule', () => planSchedule(trP, tr, trL, g, t)],
    ['4 retune', 'g16-step retune', () => planRetune(trP, tr, trL, g, t)],
    ...g.lanes.map((/** @type {any} */ _l, /** @type {number} */ i) => /** @type {[string, string, () => any]} */ ([`5 lane ${i}`, `council-approve --action tr-lane --lane ${i}`, () => planLane(tr, trL, g, i, t)])),
    ['6 ebt-mirror', 'g16-step ebt-mirror', () => { const { tree, entries } = actionLogOf(trL); const c = planEbtMirror(trL, eL, g, tree, entries); return c.length ? { todo: c.map((x) => x.circuit).join(', ') } : { done: 'EBT mirrors are current' }; }],
    ['7 k5-swap', 'g16-step k5-swap', () => planK5Swap(eL, g)],
  ];
  return rows.map(([step, how, f]) => {
    try { const p = f(); return { step, how, state: p.done ? `done: ${p.done}` : `NEXT${p.todo ? ` (${p.todo})` : ''}` }; } catch (e) {
      return { step, how, state: `waiting: ${String(/** @type {any} */ (e)?.message ?? e).replace(/^REFUSED: /, '')}` };
    }
  });
}

/** Dry run only: G16 params + throwaway keys for a dry-run deployment (devnet). */
export function makeDryParams(/** @type {string} */ dir, /** @type {any} */ dryInputs, /** @type {any} */ drySecrets) {
  const rnd = () => Buffer.from(RT.convertBigintToBytes(32, RT.jubjubSampleScalar())).toString('hex');
  const jub = () => { const sk = RT.jubjubSampleScalar(); const pk = RT.jubjubSchnorrVerifyingKey(sk); return { sk: String(sk), pk: { x: String(pk.x), y: String(pk.y) } }; };
  const operator = jub(), meter = jub();
  const nodes = [rnd(), rnd()];
  const statutory = rnd();
  const params = {
    note: 'DEVNET DRY RUN ONLY',
    charter: { nodeIds: nodes },
    refRateFiatPerKwh: String(dryInputs.tariff.refRateFiatPerKwh),
    schedule: { nodeId: nodes[1], scheduleHashHex: rnd(), operatorPk: operator.pk },
    class: { classPathHex: rnd(), rateFiatPerKwh: String(dryInputs.tariff.refRateFiatPerKwh),
      split: { producerShareBps: '5700', ldShareBps: '1000', opsShareBps: '2000', daoShareBps: '500', operatorMarginBps: '500', statutoryTotalBps: '300' } },
    statutoryAccounts: [statutory],
    lanes: [{ laneKindByte: '1', leviedByHex: rnd(), bpsShare: '300', remitAddressHex: statutory, basis: '0', applicabilityHashHex: rnd(), statuteRefHashHex: rnd(), remittanceMode: '1' }],
    meterAuthority: { newPk: meter.pk },
  };
  const keys = { note: 'DEVNET DRY RUN ONLY: throwaway keys, never used anywhere else', validator: drySecrets.validator, owner: drySecrets.owner, operator: operator.sk, meterAuthority: meter.sk };
  fs.mkdirSync(dir, { recursive: true });
  const pf = path.join(dir, 'g16-params.json'), kf = path.join(dir, 'g16-dry-keys.json');
  fs.writeFileSync(pf, JSON.stringify(params, null, 2), { flag: 'wx' });
  fs.writeFileSync(kf, JSON.stringify(keys, null, 2), { flag: 'wx', mode: 0o600 });
  return { params: pf, keys: kf };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (/** @type {string} */ k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (/** @type {string} */ k) => argv.includes(k);
  const dry = has('--devnet-dry-run');
  if (dry && has('--i-have-garretts-go-ahead')) throw new Error('refusing: --devnet-dry-run or --i-have-garretts-go-ahead, not both');
  const inputsFile = String(arg('--inputs') ?? '');
  if (!inputsFile) throw new Error('--inputs <inputs.json> is required (K3 and the record next to dry-run inputs)');
  const inputs = JSON.parse(fs.readFileSync(inputsFile, 'utf8'));
  if (arg('--make-dry-params')) {
    if (!dry) throw new Error('--make-dry-params is for the devnet dry run only');
    const secrets = JSON.parse(fs.readFileSync(inputsFile.replace(/[.]json$/, '') + '.secrets.json', 'utf8'));
    const r = makeDryParams(path.resolve(String(arg('--make-dry-params'))), inputs, secrets);
    console.log(`[g16:dry-run] params ${r.params}\n[g16:dry-run] throwaway keys ${r.keys}`);
    return;
  }
  const step = argv[0];
  if (!STEPS.includes(step)) throw new Error(`usage: g16-step.mjs ${STEPS.join('|')} ... (see the header)`);
  const { loadNetworkConfig, describeNetwork } = await import('../midnight-network.mjs');
  const net = loadNetworkConfig();
  if (dry && net.networkId !== 'undeployed') throw new Error(`refusing: the dry run is local devnet only, not ${net.networkId}`);
  if (!dry && net.networkId !== 'preprod') throw new Error(`refusing: network is ${net.networkId}, not preprod`);
  const tag = dry ? '[g16:dry-run]' : '[g16:preprod]';
  const recFile = path.resolve(String(arg('--record') ?? (dry ? `${path.resolve(inputsFile).replace(/[.]json$/, '')}.record.json` : path.join(ROOT, 'build', 'preprod', 'ceremony-record.json'))));
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  for (const k of ['council', 'tr', 'ebt']) if (!rec[k] || !rec[`${k}Final`]) throw new Error(`record ${recFile}: ${k} is not deployed and finalized`);
  const g = loadG16(String(arg('--g16') ?? ''), inputs);
  const rd = reader(net);
  console.log(`${tag} ${describeNetwork(net)}; record ${recFile}`);

  if (step === 'status') {
    for (const r of await g16Status(rd, rec, g)) console.log(`${tag} ${r.step.padEnd(12)} ${r.state}\n${' '.repeat(tag.length + 14)}(${r.how})`);
    return;
  }
  if (!dry && !has('--i-have-garretts-go-ahead')) throw new Error('refusing: a Preprod transaction; pass --i-have-garretts-go-ahead');

  const trMod = await loadModule('tariff-registry-v1');
  const ebtMod = await loadModule('ebt-v8');
  const tr = hexToBytes(rec.tr), ebt = hexToBytes(rec.ebt), t = nowSec();
  const trL = await rd.ledger('tariff-registry-v1', rec.tr);
  const eL = await rd.ledger('ebt-v8', rec.ebt);
  // Plan before opening the wallet: refusals and "already done" cost nothing.
  /** @type {{ build: string, address: string, circuit: string, args: any[] }[]} */
  let calls = [];
  const role = KEY_ROLE[step];
  const keys = role ? signer({ role, dry, keyFile: arg('--key'), dryKeys: arg('--dry-keys') }) : null;
  if (step === 'bootstrap') {
    const p = planBootstrap(trL);
    if (!p.done) calls = [{ build: 'tariff-registry-v1', address: rec.tr, circuit: p.circuit, args: p.args }];
    else console.log(`${tag} ${p.done}`);
  } else if (step === 'retune') {
    const p = planRetune(trMod.pureCircuits, tr, trL, g, t);
    if (p.done) console.log(`${tag} ${p.done}`);
    else {
      const opId = trMod.pureCircuits.operatorKeyId(g.schedule.operatorPk);
      const sid = trL._activeScheduleByNode.lookup(g.schedule.nodeId);
      if (hex(trL._registeredSchedules.lookup(sid).operatorPubkey) !== hex(opId)) throw new Error('REFUSED: the params operator key is not the schedule\'s operator');
      p.args[5] = /** @type {any} */ (keys).sign(p.signerMessage);
      calls = [{ build: 'tariff-registry-v1', address: rec.tr, circuit: p.circuit, args: p.args }];
    }
  } else if (step === 'ebt-mirror') {
    const { tree, entries } = actionLogOf(trL);
    calls = planEbtMirror(trL, eL, g, tree, entries).map((c) => ({ build: 'ebt-v8', address: rec.ebt, ...c }));
    if (!calls.length) console.log(`${tag} EBT mirrors are current`);
  } else if (step === 'k5-swap') {
    const p = planK5Swap(eL, g);
    if (p.done) console.log(`${tag} ${p.done}`);
    else calls = [{ build: 'ebt-v8', address: rec.ebt, circuit: p.circuit, args: [...p.args, /** @type {any} */ (keys).signOwner(ebtMod, p.circuit, p.args, ebt, p.nonce)] }];
  }
  if (!calls.length) return;
  for (const c of calls) console.log(`${tag} will call ${c.build === 'ebt-v8' ? 'EBT' : 'TR'} ${c.circuit}`);

  const psPassword = privateStatePassword(process.env, dry ? { devnetDefault: 'Local-Devnet-Only-1' } : {});   // never printed
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
    const dn = await openNetwork({ net, ctx: wallet, storeName: dry ? 'pp-g16-dryrun' : 'pp-preprod-g16', password: psPassword });
    dn.bind(rec.council, 'multisig-v8');
    dn.bind(rec.tr, 'tariff-registry-v1');
    dn.bind(rec.ebt, 'ebt-v8');
    for (const c of calls) {
      const h = await join(dn, c.build, c.address, c.build === 'tariff-registry-v1' ? trWitnesses(g) : null);
      const t0 = Date.now();
      await h.callTx[c.circuit](...c.args);
      console.log(`${tag} ${c.circuit} landed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } finally {
    if ('close' in wallet) { await wallet.close(); console.log(`${tag} wallet state saved`); }
  }
  // Read back: the step must now report done.
  const after = (await g16Status(rd, rec, g)).filter((r) => ({ bootstrap: '1 ', retune: '4 ', 'ebt-mirror': '6 ', 'k5-swap': '7 ' })[step] === r.step.slice(0, 2));
  for (const r of after) console.log(`${tag} ${r.step}: ${r.state}`);
  if (after.some((r) => !r.state.startsWith('done'))) throw new Error(`${step} does not read back as done`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => process.exit(0), (e) => { console.error(`[g16] ${String(e?.message ?? e)}`); process.exit(1); });
}
