// A full settle path in memory: Multisig v8 council, TariffRegistry v1 with a
// registered schedule and a retuned class, EBT v8 mirroring both through real
// action-log Merkle proofs, an attested producer, and a meter-authority HAT.
//
// Used by the LD v3 tests (EBT must accrue a real dividend) and by the settle
// attack tests. Everything goes through the compiled contracts; the only JS
// logic is the action-log tree, which must reproduce TariffRegistry's root
// (checked against the ledger on every proof).
import { loadContract, deploy, createWorld, b32, runtimePersistentHash, padTag, hex } from '../parity/harness.mjs';
import { newCouncilKey, approvalDigest, signDigest } from './council-signer.mjs';
import { newOwnerKey, signOwnerAction } from './owner-signer.mjs';
import { newMachineKey, signMessage } from './machine-signer.mjs';

const DEPTH = 24;
const NODE_TAG = padTag('pp:tariff:v1:actionLogNode');
const EMPTY_LEAF = padTag('pp:tariff:v1:actionLogEmpty');
const h3 = (a, b) => runtimePersistentHash([NODE_TAG, a, b]);

/** TariffRegistry's append-only action log as a sparse Merkle tree (leaves = payloadHash). */
export class ActionLogTree {
  constructor() {
    this.leaves = [];
    this.zeros = [EMPTY_LEAF];
    for (let i = 0; i < DEPTH; i++) this.zeros.push(h3(this.zeros[i], this.zeros[i]));
  }
  append(leaf) { this.leaves.push(leaf); }
  node(level, index) {
    if (level === 0) return index < this.leaves.length ? this.leaves[index] : EMPTY_LEAF;
    if (index * 2 ** level >= this.leaves.length) return this.zeros[level];
    return h3(this.node(level - 1, 2 * index), this.node(level - 1, 2 * index + 1));
  }
  root() { return this.node(DEPTH, 0); }
  /** EventProof for leaf `seq` (bits: true = this node is the right child). */
  proof(seq, actionSeq = BigInt(seq)) {
    const merkleProof = [];
    const merkleSiblings = [];
    for (let i = 0; i < DEPTH; i++) {
      const idx = Math.floor(seq / 2 ** i);
      const right = idx % 2 === 1;
      merkleSiblings.push(right);
      merkleProof.push(this.node(i, right ? idx - 1 : idx + 1));
    }
    return { actionSeq, payloadHash: this.leaves[seq], merkleProof, merkleSiblings };
  }
}

const NODE = b32(0x0e);
const ZERO = b32(0);
const charterProof = { siblings: Array(12).fill(ZERO), indices: Array(12).fill(false) };
const charterRoot = (() => {
  let h = runtimePersistentHash([padTag('pp:fed:charter:leaf'), NODE]);
  for (let i = 0; i < 12; i++) h = runtimePersistentHash([padTag('pp:fed:charter:node'), h, ZERO]);
  return h;
})();
const pathBits = (seq) => Array.from({ length: DEPTH }, (_, i) => ((seq >> BigInt(i)) & 1n) === 1n);
const divmod = (_ctx, n, d) => ({ quotient: n / d, remainder: n % d });

export const CLASS = b32(0xc1);
// producer 6000 + margin 500 = producer slice 6500; ld 1000; ops 2000; dao 500; statutory 0.
export const SPLIT = { producerShareBps: 6000n, ldShareBps: 1000n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 0n };
export const T0 = 1000n;

/**
 * @param opts.ebtCtor (keys) => EBT constructor args, for the pre-change ABI in PoC runs.
 * @param opts.ebtName build name (default ebt-v8).
 */
export async function settleWorld(opts = {}) {
  const world = createWorld();
  const ms = await loadContract('multisig-v8');
  const trMod = await loadContract('tariff-registry-v1');
  const ebtMod = await loadContract(opts.ebtName ?? 'ebt-v8');
  const councilKeys = Array.from({ length: 7 }, newCouncilKey);
  const council = world.register(await deploy(ms, {}, [councilKeys.map((k) => k.point), 3n, 2n], {}, { world }), ms, 'multisig-v8');
  const approve = async (hash, slots = [0, 1]) => {
    for (const i of slots) {
      await council.call('approve', hash, BigInt(i), signDigest(approvalDigest(ms, council.addressBytes, hash, 0n), councilKeys[i].sk));
    }
  };

  // --- TariffRegistry: schedule + class ---------------------------------
  const validator = newMachineKey();
  const operator = newMachineKey();
  const tr = await deploy(trMod, {
    charter_membership_proof: (ctx) => [ctx.privateState, charterProof],
    witness_divmod: (ctx, n, d) => [ctx.privateState, divmod(ctx, n, d)],
    action_log_path_bits: (ctx, seq) => [ctx.privateState, pathBits(seq)],
  }, [{ bytes: council.addressBytes }, charterRoot, 100n, validator.pk], {}, { world });
  await tr.call('bootstrapActionLog', BigInt(DEPTH));
  const P = trMod.pureCircuits;
  const opId = P.operatorKeyId(operator.pk);
  const regHash = P.registerScheduleActionHash(tr.addressBytes, NODE, b32(0x5c), opId, 100n, 1n, tr.ledger()._currentEpoch);
  await approve(regHash);
  await tr.call('registerSchedule', NODE, b32(0x5c), opId, 100n, 1n, signMessage(P.signerMessage(regHash), validator.sk), T0);
  const scheduleId = tr.ledger()._activeScheduleByNode.lookup(NODE);
  const retune = async (split, rate, nonce, time) => {
    const auth = P.retuneAuthHash(tr.addressBytes, scheduleId, CLASS, split, rate, tr.ledger()._currentEpoch, nonce, time);
    await tr.call('retuneClass', scheduleId, CLASS, split, rate, operator.pk, signMessage(P.signerMessage(auth), operator.sk), nonce, time,
      { quotient: 20n, remainder: 0n }, { quotient: 20n, remainder: 0n });
  };
  await retune(opts.split ?? SPLIT, 100n, 1n, T0);

  // --- the action log, mirrored in JS --------------------------------------
  const tree = new ActionLogTree();
  const entries = [];
  const syncTree = () => {
    const L = tr.ledger();
    for (let i = tree.leaves.length; i < Number(L._actionSeq); i++) {
      const e = L._actionLog.lookup(BigInt(i));
      entries.push(e);
      tree.append(e.payloadHash);
    }
    if (hex(tree.root()) !== hex(L.registryActionLogRoot)) throw new Error('JS action-log tree != TariffRegistry root');
  };
  syncTree();

  // --- EBT -------------------------------------------------------------------
  const keys = { owner: newOwnerKey(), hat: newMachineKey(), escrow: newMachineKey() };
  const ctor = opts.ebtCtor
    ? opts.ebtCtor(keys, council, tree.root())
    : [keys.owner.pk, keys.hat.pk, { bytes: council.addressBytes },
       { bytes: b32(0x21) }, { bytes: b32(0x23) }, keys.escrow.pk, tree.root()];
  const ebt = Object.assign(await deploy(ebtMod, {}, ctor, {}, { world }), { mod: ebtMod });
  const ownerCall = (circuit, args) =>
    ebt.call(circuit, ...args, signOwnerAction(ebtMod, ebt, circuit, args, { sk: keys.owner.sk }));

  const record = tr.ledger()._registeredSchedules.lookup(scheduleId);
  const mirrorSchedule = (seq = 0) => ebt.call('mirrorScheduleLifecycle', entries[seq], record, tree.proof(seq));
  const mirrorClass = (seq, split, rate = 100n, at = T0) =>
    ebt.call('mirrorClassStatutoryTotal', entries[seq], scheduleId, CLASS, split, rate, at, tree.proof(seq));
  await mirrorSchedule(0);
  await mirrorClass(1, opts.split ?? SPLIT);

  // --- producer --------------------------------------------------------------
  const producerKey = b32(0x63);
  const meterKeyHash = b32(0x65);
  const attestationKey = runtimePersistentHash([producerKey, meterKeyHash]);
  await ownerCall('attestProducerOwnership', [attestationKey, producerKey, meterKeyHash, 1n, b32(0x53), T0]);

  let session = 0;
  /**
   * Settles `amount` with the given bps split (default: the class split) and
   * slice amounts computed by floor; the producer slice takes the rounding.
   */
  const settle = async (amount, bps = {}) => {
    const s = opts.split ?? SPLIT;
    const ld = bps.ld ?? s.ldShareBps;
    const ops = bps.ops ?? s.opsShareBps;
    const dao = bps.dao ?? s.daoShareBps;
    const prod = 10000n - ld - ops - dao - s.statutoryTotalBps;
    const opsAmt = (amount * ops) / 10000n;
    const divAmt = (amount * ld) / 10000n;
    const daoAmt = (amount * dao) / 10000n;
    const producerAmt = amount - opsAmt - divAmt - daoAmt;
    const sessionID = b32(0x80 + (session++ % 120));
    const producerAddr = { bytes: b32(0x64) };
    const msg = ebtMod.pureCircuits.hatMessage(ebt.addressBytes, sessionID, amount, producerKey, producerAddr, meterKeyHash);
    await ebt.call('settle', sessionID, amount, producerKey, producerAddr, meterKeyHash, signMessage(msg, keys.hat.sk),
      scheduleId, CLASS, 1n, 2n, [ZERO, ZERO, ZERO, ZERO], [0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n],
      prod, ops, ld, dao, producerAmt, opsAmt, divAmt, daoAmt, T0);
    return { divAmt, producerAmt };
  };

  return {
    world, ms, council, councilKeys, approve, tr, trMod, ebt, ebtMod, keys, ownerCall,
    scheduleId, record, tree, entries, syncTree, retune, mirrorSchedule, mirrorClass, settle,
  };
}
