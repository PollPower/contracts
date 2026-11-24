# Tracked item: HAT chip signs directly (after Preprod)

Status: **open, scheduled after the Preprod deploy** (Garrett, 2026-11-24).
Owner: contracts + firmware. Nothing here blocks the devnet run, the demo or Preprod.

## Why

Since WI16-C-1c, EBT `settle` verifies the HAT in-circuit, but ledger 9 has no
Ed25519 verifier and the HAT chip (TI CC1352P7) signs Ed25519. For now
(option 3) meter-authority-service checks the chip's Ed25519 signature and
countersigns with a Jubjub key the circuit can verify. **Until the chip signs
a curve the circuit verifies, the on-chain proof vouches for the service, not
the chip.** The chip key and chip signature are bound into the HAT message and
emitted in the `pp:ebt:v9:settleChip` event, so the audit trail is chip-rooted
even though the proof is not.

Goal of this item: let the circuit verify the chip's own signature, so a
compromised relay key alone cannot mint.

## Options

| | A. secp256k1 ECDSA on chip | B. Jubjub Schnorr on chip |
|---|---|---|
| In-circuit verify | stdlib `secp256k1EcdsaVerify` (already proven on chain with the Tangem ring, devnet block 627) | stdlib `jubjubSchnorrVerify` (in use for the service key today) |
| Chip crypto | Hardware PKA does the curve maths; secp256k1 defined as custom curve parameters (see SDK check below) | Jubjub (twisted Edwards over the BLS12-381 scalar field) has no SDK support; either software arithmetic or a Weierstrass mapping onto the PKA, plus Midnight's Poseidon-based `transientHash` and the exact Schnorr challenge construction of compact-runtime, all ported to C |
| Message hash | Keccak-256 (Garrett's suggestion) in software on chip (~1-2 KB code; CC1352P7 has SHA-2 hardware only), or the chip signs a host-supplied 32-byte digest as the Tangem ring does (no hash on chip) | Poseidon over BLS12-381 Fr, constants must match midnight-ledger exactly |
| Proof cost | ~117 MB more `settle` prover key (secp256k1 spike, see auth fix design); settle is already ~86 MiB | ~2 MB (Schnorr spike) |
| Firmware effort (estimate) | **3-5 dev-days**: curve params, key generation and storage, new SIGN command, low-S optional (circuit accepts both), test vectors against `@noble/curves` | **10-15 dev-days**: Poseidon port and constant tables, field and curve arithmetic, challenge parity with the runtime, constant-time review |
| Main risk | Bigger settle proofs (proving time on the keeper) | Parity with Midnight's hash and challenge; any upstream change breaks it |

Recommendation for the evaluation: start with **A**, measure settle proving
time with the extra ECDSA verify, and fall back to B only if that cost is
unacceptable.

## SDK check (read-only, throne, 2026-11-24)

- SimpleLink CC13xx/CC26xx SDK **8.32.00.07** at `C:\ti\simplelink_cc13xx_cc26xx_sdk_8_32_00_07`
  (CCS 20.5.1 at `C:\ti\ccs2051`).
- `source/ti/drivers/cryptoutils/ecc/ECCParams.h`: built-in curves are NIST
  P-224/256/384/521, Brainpool P256R1/384R1/512R1, Curve25519, Ed25519,
  Wei25519. **No built-in secp256k1.** The non-TF-M `ECCParams_CurveParams`
  struct carries `curveType` (incl. `ECCParams_CURVE_TYPE_SHORT_WEIERSTRASS_GEN`),
  `prime`, `a`, `b`, `order`, `cofactor`, `length`, `generatorX/Y`.
- `source/ti/drivers/ecdsa/ECDSACC26X2.c` (the driver for CC13x2x7 parts such
  as the CC1352P7) passes `curve->prime`, `curve->a`, `curve->b` and the order
  straight to the PKA (`PKAEccMultiplyStart`, `PKAEccAddStart`). So secp256k1
  (`a = 0`, `b = 7`) should work as custom curve parameters on the hardware
  PKA. **To confirm on the device**: sign with custom secp256k1 params and
  verify with `@noble/curves`, then with the compiled `secp256k1EcdsaVerify`
  circuit (the Tangem test harness in `tooling/tangem/` already does both).

## Where the firmware source lives

**Not found on throne.** `C:\Users\Garrett\workspace_ccstheia` holds only the
TI Wi-SUN example projects (`ns_br`, `ns_node`, `gpiointerrupt`), the same as
the `pollpower-br-firmware` / `pollpower-node-firmware` repos, with no HAT
command handler (`SIGN_HASH` 0x62, `IDENTITY` 0x61). `C:\Users\Garrett\ti` is
empty. The host side of the protocol is `pp-settle-service/pp_hat_session.mjs`
(commands `IDENTITY` 0x61, `SIGN_HASH` 0x62; the HAT is reached through a TCP
proxy at `192.168.100.18:7300`). **Garrett: please point to the HAT firmware
source** (another machine, or the device's build workspace) before this item
starts.
