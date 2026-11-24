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

**`PollPower/gateway-execution`** (private, single branch `master`, last push
2026-10-28), found by org-wide code search (Garrett, 2026-11-24):

| Path | What |
|---|---|
| `firmware/pp_attest.c`, `pp_attest.h` | HAT attestation: TI `EDDSA` hardware driver (PKA, `ECCParams_Ed25519`), `SHA2` (SHA-512), `TRNG`; key generated on chip |
| `firmware/pp_keystore.c`, `.h` | Ed25519 key persisted in its own flash page (`PPK1` at `0x000A0000`, CRC32), untouched by app-only reflash |
| `firmware/pp_gwattest.c` | The command handler the settle service talks to (`IDENTITY` 0x61, `SIGN_HASH` 0x62, `SET_METER_LIMIT`, `ENERGY_RESET`, ...) |
| `firmware/pp_energy.c`, `pp_gwenergy.c`, `pp_ina226.c` | Metering (INA226) and the energy limit / relay cut-off |
| `firmware/*.syscfg`, `build_*.sh`, `*.lds` | SysConfig + GCC builds for `CC1352P7RGZ` / `LP_CC1352P7_1`, SimpleLink SDK **8.32.00.07**, SysConfig 1.21.1 (no CCS project files; command-line builds under `$HOME/ti`) |
| `pi-bridge/` | Pi-side serial-to-TCP bridge (`pp_hat_bridge.mjs`, `pp_serial_tcp_proxy.py`) behind `192.168.100.18:7300`, plus flashing scripts |
| `settle-service/` | An older copy of what is now `PollPower/pp-settle-service` |

Unrelated CC1352P7 code in `pollpower-monorepo` (`src/cc1352p7-firmware`,
`src/gateway-firmware/cc1352p7-relay`, `pollpower-v2/firmware/cc1352p7-mesh`,
`hardware/gateway-v3.4|3.5/firmware`) is the earlier mesh / relay radio work,
not the HAT signer.

### Confirmed (2026-11-24) and decided

- `ATTEST` (0x60, `pp_gwattest.c`) takes only the 16-byte session id from the
  host and signs `energy.session_uwh`, the chip's own counter fed by
  `pp_energy_sample` from the INA226; uptime and the TRNG nonce are also
  chip-generated. The host can reset the session counter (`ENERGY_RESET`) and
  set the cut-off limit, which only lower or end a reading.
- **Decided (Garrett):** meter-authority-service requires this native
  attestation and refuses `SIGN_HASH` for settles (before Preprod).
- **Next firmware revision:** disable `SIGN_HASH` (0x62) for settle use (keep
  it, if at all, only for non-settle purposes), and add a persistent boot
  counter to the attestation: uptime resets on reboot, so today the server
  can only refuse reused nonces and sessions, not enforce a monotonic clock
  across reboots.

### What this changes for the evaluation

- **The chip already has a stronger attestation than the one production uses.**
  `pp_attest_sign` signs SHA-512 over a 75-byte pre-image that the chip fills
  itself: domain `pollpower:hat:attest:v1`, factory IEEE address, USER_ID,
  session id (16), **the chip's own metered uWh**, its monotonic uptime (ms)
  and a TRNG nonce. pp-settle-service instead uses `SIGN_HASH` (0x62), where
  the chip signs any 32-byte hash the host sends, so a compromised host can get
  any amount signed. Whatever curve the chip moves to, the signed message
  should be the chip-built attestation (amount from the chip's own meter),
  not a host-supplied hash.
- **Interim hardening (before the curve change, small):** meter-authority-
  service could require the chip's native attestation (verify Ed25519 over the
  SHA-512 digest of the pre-image, check the metered uWh equals the settle
  amount × 1000 within rounding, uptime/nonce monotonic) instead of a
  `SIGN_HASH` signature. That closes the "host picks the amount" hole without
  firmware changes. Worth doing before Preprod; to be scheduled.
- secp256k1 on the same hardware: the code already uses the PKA through TI's
  drivers; option A swaps `EDDSA` for the `ECDSA` driver with custom curve
  parameters (see SDK check). Key storage and the command protocol stay.
