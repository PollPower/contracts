#!/usr/bin/env node
// Creates the EBT owner key (Jubjub) in an encrypted, owner-only file and
// prints ONLY the public key (it goes into the EBT constructor as ownerPk).
//   OWNER_KEY_PASSPHRASE=... node tooling/owner/owner-keygen.mjs --key <file>
import { generateOwnerKey } from './owner-key-lib.mjs';

const i = process.argv.indexOf('--key');
const file = i > 0 ? process.argv[i + 1] : null;
if (!file) { console.error('usage: OWNER_KEY_PASSPHRASE=... owner-keygen.mjs --key <file>'); process.exit(2); }
const pk = generateOwnerKey(file, process.env.OWNER_KEY_PASSPHRASE);
console.log(JSON.stringify({ keyFile: file, ownerPk: { x: pk.x.toString(), y: pk.y.toString() } }, null, 2));
