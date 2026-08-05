// Read-only Preview state dump: registry head + EBT mirror + attestation.
// Run: node state-dump.mjs  (from ~/contracts/ebt, symlinked node_modules realm)
import { WebSocket } from 'ws'; globalThis.WebSocket = WebSocket;
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

const EBT = 'c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3';
const REG = '556fe46f8dfd5234e97974bfd8b455ef4ea8c785641d80a4d7c12530a3776dd9';
const EBT_BUILD = '/home/pollpower/contracts/ebt/build/v8';
const REG_BUILD = '/home/pollpower/contracts/ebt/registry-build/ceremony';
const INDEXER = 'https://indexer.preview.midnight.network/api/v3/graphql';
const INDEXER_WS = 'wss://indexer.preview.midnight.network/api/v3/graphql/ws';
const toHex = (u) => Buffer.from(u).toString('hex');

setNetworkId('preview');
async function ledgerOf(buildPath) {
  const mod = await import(pathToFileURL(path.join(buildPath, 'contract', 'index.js')).href);
  return mod.ledger;
}
const pdp = indexerPublicDataProvider(INDEXER, INDEXER_WS);

// ---- registry ----
const regLedger = await ledgerOf(REG_BUILD);
const regSt = await pdp.queryContractState(REG);
const r = regLedger(regSt.data);
console.log('=== REGISTRY 556fe46f ===');
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
const ebtSt = await pdp.queryContractState(EBT);
const b = ebtLedger(ebtSt.data);
console.log('\n=== EBT c9ee6171 ===');
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
