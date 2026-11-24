// Read-only state dump: registry head + EBT mirror + attestation.
// Run: node state-dump.mjs  (network, addresses and build dirs from ./env.mjs)
import { WebSocket } from 'ws'; globalThis.WebSocket = WebSocket;
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { EBT_BUILD, REG_BUILD, contractAddress, publicDataProvider, readContractData } from './env.mjs';

const EBT = contractAddress('EBT_ADDRESS');
const REG = contractAddress('REGISTRY_ADDRESS');
const toHex = (u) => Buffer.from(u).toString('hex');

async function ledgerOf(buildPath) {
  const mod = await import(pathToFileURL(path.join(buildPath, 'contract', 'index.js')).href);
  return mod.ledger;
}
const pdp = publicDataProvider();

// ---- registry ----
const regLedger = await ledgerOf(REG_BUILD);
const r = regLedger(await readContractData(pdp, REG));
console.log(`=== REGISTRY ${REG.slice(0, 8)} ===`);
console.log('_actionSeq       =', String(r._actionSeq));
console.log('_actionLogBaseSeq=', String(r._actionLogBaseSeq));
console.log('registryActionLogRoot =', toHex(new Uint8Array(r.registryActionLogRoot)));
console.log('_currentEpoch    =', String(r._currentEpoch.read ? r._currentEpoch.read() : r._currentEpoch));
console.log('_classEntries size=', r._classEntries ? String(r._classEntries.size ? r._classEntries.size() : '?') : 'n/a');
// list action log entries
const base = BigInt(r._actionLogBaseSeq), seqEnd = BigInt(r._actionSeq);
for (let s = base; s < seqEnd; s++) {
  if (r._actionLog.member(s)) {
    const e = r._actionLog.lookup(s);
    console.log(`  action[${s}] kind=${e.kind} payloadHash=${toHex(new Uint8Array(e.payloadHash))}`);
  }
}
// schedule record
try {
  const SID = new Uint8Array(Buffer.from('0a0ca2e41632da85802a34207c58883f54cc2a1375ca77887c7b8dc682df101a','hex'));
  if (r._registeredSchedules.member(SID)) {
    const sc = r._registeredSchedules.lookup(SID);
    console.log('schedule.operatorPubkey =', toHex(new Uint8Array(sc.operatorPubkey)));
    console.log('schedule.refRateFiatPerKwh =', String(sc.refRateFiatPerKwh));
    console.log('schedule.effectiveEpoch =', String(sc.effectiveEpoch));
    console.log('schedule.retiredEpoch =', String(sc.retiredEpoch));
    console.log('schedule.nodeId =', toHex(new Uint8Array(sc.nodeId)));
  } else console.log('schedule NOT FOUND');
} catch(e){ console.log('schedule read err:', e.message); }

// ---- EBT ----
const ebtLedger = await ledgerOf(EBT_BUILD);
const b = ebtLedger(await readContractData(pdp, EBT));
console.log(`\n=== EBT ${EBT.slice(0, 8)} ===`);
console.log('_registryActionLogHeadSeqMirror =', String(b._registryActionLogHeadSeqMirror));
console.log('_registryActionLogRootMirror    =', toHex(new Uint8Array(b._registryActionLogRootMirror)));
console.log('_scheduleLiveMirror size =', b._scheduleLiveMirror && b._scheduleLiveMirror.size ? String(b._scheduleLiveMirror.size()) : '?');
console.log('_classStatutoryTotalBpsMirror size =', b._classStatutoryTotalBpsMirror && b._classStatutoryTotalBpsMirror.size ? String(b._classStatutoryTotalBpsMirror.size()) : '?');
console.log('_registeredLanesMirror size =', b._registeredLanesMirror && b._registeredLanesMirror.size ? String(b._registeredLanesMirror.size()) : '?');
console.log('_meterAuthorityPubkey =', b._meterAuthorityPubkey ? toHex(new Uint8Array(b._meterAuthorityPubkey)) : 'n/a');
console.log('_totalSupply =', b._totalSupply !== undefined ? String(b._totalSupply) : 'n/a');
// producer attestation
try {
  const pb = new Uint8Array(Buffer.from('a11ce0000000000000000000000000000000000000000000000000000000e2e1','hex'));
  const mk = new Uint8Array(Buffer.from('be7e40000000000000000000000000000000000000000000000000000000e2e0','hex'));
  const { persistentHash, CompactTypeVector, CompactTypeBytes } = await import('@midnight-ntwrk/compact-runtime');
  const B32 = new CompactTypeBytes(32);
  const akey = persistentHash(new CompactTypeVector(2, B32), [pb, mk]);
  console.log('attestationKey =', toHex(new Uint8Array(akey)));
  if (b.producerAttestations && b.producerAttestations.member(akey)) {
    const at = b.producerAttestations.lookup(akey);
    console.log('  attestation.active =', at.active);
  } else console.log('  attestation NOT present');
} catch(e){ console.log('attestation read err:', e.message); }
process.exit(0);
