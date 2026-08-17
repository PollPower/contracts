// compute-ebt-color.mjs — derive the LD constructor `ebtColor` value.
//
// The LD contract's constructor stores `_ebtColor = disclose(ebtColor)`.
// That value MUST equal what the EBT v8 contract computes internally as
// its unshielded token color, i.e. the Compact expression:
//
//     tokenType(pad(32, "pollpower:ebt:v8:epoch1"), kernel.self())
//
// where kernel.self() is the deployed EBT v8 contract address:
//     c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3
//
// DERIVATION (verified against the compiled EBT v8 build, build/v8/contract/index.js):
//   _tokenType_0(domain_sep, contractAddress) =
//     _persistentCommit_0([domain_sep, contractAddress.bytes], pad(32,"midnight:derive_token"))
//   _persistentCommit_0(value, rand) =
//     __compactRuntime.persistentCommit(CompactTypeVector(2, CompactTypeBytes(32)), value, rand)
//
// So this script reproduces that EXACT call using the same runtime the
// contract uses (@midnight-ntwrk/compact-runtime).

import { pathToFileURL } from 'node:url';

const RUNTIME = '/opt/pollpower/settlement-api/node_modules/@midnight-ntwrk/compact-runtime/dist/index.js';

const EBT_V8_ADDRESS_HEX =
  'c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3';
const DOMAIN_LABEL = 'pollpower:ebt:v8:epoch1';
const DERIVE_TOKEN_RAND_LABEL = 'midnight:derive_token';

// Compact pad(32, str): UTF-8 bytes of str, right-zero-padded to 32 bytes.
// (Verified: the compiled JS emits exactly this byte array for the domain sep.)
function pad32(str) {
  const b = new TextEncoder().encode(str);
  if (b.length > 32) throw new Error(`pad32: "${str}" is ${b.length} bytes > 32`);
  const out = new Uint8Array(32);
  out.set(b, 0);
  return out;
}

function hexToBytes32(hex) {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length !== 64) throw new Error(`expected 64 hex chars, got ${hex.length}`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function toHex(u8) {
  return Buffer.from(u8).toString('hex');
}

async function main() {
  const rt = await import(pathToFileURL(RUNTIME).href);

  if (typeof rt.persistentCommit !== 'function') {
    throw new Error('runtime does not export persistentCommit');
  }
  if (typeof rt.CompactTypeVector !== 'function' || typeof rt.CompactTypeBytes !== 'function') {
    throw new Error('runtime missing CompactTypeVector / CompactTypeBytes');
  }

  const domainSep = pad32(DOMAIN_LABEL);
  const addrBytes = hexToBytes32(EBT_V8_ADDRESS_HEX);
  const rand = pad32(DERIVE_TOKEN_RAND_LABEL);

  // Descriptor for Vector<2, Bytes<32>>  (== _descriptor_30 in the compiled contract).
  const bytes32 = new rt.CompactTypeBytes(32);
  const vec2 = new rt.CompactTypeVector(2, bytes32);

  // Sanity: expected domain-sep byte array from the compiled contract.
  const EXPECTED_DOMAIN = [112,111,108,108,112,111,119,101,114,58,101,98,116,58,118,56,58,101,112,111,99,104,49,0,0,0,0,0,0,0,0,0];
  const EXPECTED_RAND = [109,105,100,110,105,103,104,116,58,100,101,114,105,118,101,95,116,111,107,101,110,0,0,0,0,0,0,0,0,0,0,0];
  const domOK = EXPECTED_DOMAIN.every((v, i) => v === domainSep[i]);
  const randOK = EXPECTED_RAND.every((v, i) => v === rand[i]);
  if (!domOK) throw new Error('domain sep bytes mismatch vs compiled contract');
  if (!randOK) throw new Error('derive_token rand bytes mismatch vs compiled contract');

  const color = rt.persistentCommit(vec2, [domainSep, addrBytes], rand);

  const colorHex = toHex(color);

  console.log('--- LD ebtColor derivation ---');
  console.log(`runtime          : ${RUNTIME}`);
  console.log(`domain label     : "${DOMAIN_LABEL}"`);
  console.log(`domainSep (hex)  : ${toHex(domainSep)}`);
  console.log(`ebt v8 address   : ${EBT_V8_ADDRESS_HEX}`);
  console.log(`derive rand (hex): ${toHex(rand)}`);
  console.log(`method           : persistentCommit(Vector<2,Bytes<32>>=[domainSep, addrBytes], rand)`);
  console.log('');
  console.log(`ebtColor (hex)   : ${colorHex}`);
  console.log(`ebtColor length  : ${color.length} bytes`);

  // Emit machine-readable line for the parent/deploy script.
  console.log(`EBT_COLOR_HEX=${colorHex}`);
}

main().catch((e) => {
  console.error('FATAL:', e?.stack || e?.message || e);
  process.exit(1);
});
