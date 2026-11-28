// @ts-check
// The 32-byte user address (hex) of an unshielded Midnight address, for EBT
// constructor inputs operationsRecipientHex / daoRecipientHex (K7, K8).
//
//   node tooling/wallet/address-bytes.mjs <mn_addr_...> [--network preprod]
//
// Prints the hex and the address re-encoded from it, so the two can be
// compared character for character. Public values only; no network access.
import { pathToFileURL } from 'node:url';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';

/** @returns {string} 64 lowercase hex: the UserAddress bytes the contract stores */
export function userAddressHex(/** @type {string} */ bech32, networkId = 'preprod') {
  const s = String(bech32).trim();
  let u;
  try { u = MidnightBech32m.parse(s).decode(UnshieldedAddress, networkId); } catch (e) {
    throw new Error(`not an unshielded ${networkId} address (${/** @type {any} */ (e)?.message ?? e})`);
  }
  const hex = Buffer.from(u.data).toString('hex');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('decoded address is not 32 bytes');
  if (MidnightBech32m.encode(networkId, new UnshieldedAddress(Buffer.from(hex, 'hex'))).asString() !== s) throw new Error('address does not re-encode to itself');
  return hex;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--network');
  const net = i >= 0 ? argv[i + 1] : 'preprod';
  const addr = argv.find((a, j) => !a.startsWith('--') && (i < 0 || j !== i + 1));
  try {
    if (!addr) throw new Error('usage: node tooling/wallet/address-bytes.mjs <mn_addr_...> [--network preprod]');
    const hex = userAddressHex(addr, net);
    console.log(`address ${addr}\nhex     ${hex}\nnetwork ${net}`);
  } catch (e) { console.error(String(/** @type {any} */ (e)?.message ?? e)); process.exit(1); }
}
