#!/usr/bin/env node
// Signs one EBT owner action with the owner key. Prints {"ownerSig": ...}.
//   OWNER_KEY_PASSPHRASE=... node tooling/owner/owner-sign.mjs \
//     --key <file> --ebt <64-hex address> --nonce <EBT _ownerNonce> \
//     --circuit <name> --args <args.json> [--build build/l9/ebt-v8]
// args.json: the circuit's arguments before ownerSig (manualReissue: before
// authoritySig), encoded with {"$bytes": hex} / {"$int": decimal}, e.g.
//   [{"$bytes":"41.."}, {"bytes":{"$bytes":"42.."}}, {"$int":"1000"}, {"$int":"1"},
//    {"$bytes":"43.."}, {"scheduleId":{"$bytes":".."},"classPath":{"$bytes":".."},
//     "epoch":{"$int":"1"},"fiatValueAtMint":{"$int":"2"}}, {"$int":"1795000000"}]
import fs from 'node:fs';
import { decodeArg, loadEbtModule, signOwnerAction, sigToJson } from './owner-key-lib.mjs';

const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const key = opt('key'), ebt = opt('ebt'), nonce = opt('nonce'), circuit = opt('circuit'), argsFile = opt('args');
if (!key || !ebt || nonce === undefined || !circuit || !argsFile || !/^[0-9a-fA-F]{64}$/.test(ebt)) {
  console.error('usage: owner-sign.mjs --key <file> --ebt <64-hex> --nonce <n> --circuit <name> --args <file> [--build dir]');
  process.exit(2);
}
const mod = await loadEbtModule(opt('build', 'build/l9/ebt-v8'));
const args = decodeArg(JSON.parse(fs.readFileSync(argsFile, 'utf8')));
const sig = signOwnerAction({
  mod, keyFile: key, passphrase: process.env.OWNER_KEY_PASSPHRASE, circuit, args,
  ebtAddressBytes: Uint8Array.from(Buffer.from(ebt, 'hex')), nonce,
});
console.log(JSON.stringify({ circuit, nonce: String(nonce), ownerSig: sigToJson(sig) }, null, 2));
