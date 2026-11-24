# Runbook: HAT settle watcher alert

Status: watcher being built in WI-16 step 4 (`tooling/watcher/`). Decisions:
Garrett, 2026-11-24.

## Why the watcher exists

Ledger 9 cannot verify Ed25519, so EBT `settle` cannot check the HAT chip's
own signature. On chain it checks the meter-authority-service countersignature,
that the chip is council-registered and bound to the meter / producer / payout,
that `amount == floor(chipSessionUwh / 1000)`, and single-use session and chip
nonce. The chip's signature is checked by the service before it countersigns,
and **after the fact by this watcher**: every `pp:ebt:v9:settleChip` event
carries the chip key, signature, hardware id, metered µWh, uptime and nonce, so
anyone can rebuild the firmware pre-image and verify it.

The watcher, for every settle event:

1. reads the chip key from the event and the chip's **registered** record from
   EBT (`_chips`): it must exist, be active, and match the event's hardware id;
2. rebuilds the attestation pre-image (`pollpower:hat:attest:v1` || ieee ||
   userid || session id (16) || µWh || uptime || nonce) and verifies the
   Ed25519 signature with the registered key over its SHA-512;
3. checks the minted amount equals `floor(µWh / 1000)`.

Any failure is an **alert**. A failure means either meter-authority-service
countersigned something it should not have (its key is compromised or it has a
bug), or the firmware signed with `SIGN_HASH` (it must not be enabled for
settles at Preprod: hard gate).

## On an alert

1. **Alert all three council members at once** (Garrett, Jonathan, Timothy),
   not only one: revocation needs **2-of-3**, so two approvals must be gathered
   quickly. There is deliberately **no single-member suspend**.
2. Identify the chip (event chip key / hardware id) and the settle tx.
3. Council: approve `revokeChip(chipPubkey, time)` (admin app, rings). Two
   approvals, then anyone submits `revokeChip`. From then on `settle` refuses
   that chip (`CHIP_REVOKED`).
4. If more than one chip is affected, or the signatures that fail are all
   countersigned recently: treat the **meter-authority-service key** as
   compromised. The owner rotates the meter authority (`execOwnerOp` op 1) to a
   fresh Jubjub key from a clean host; until then stop meter-authority-service
   (`pm2 stop meter-authority`) so no further HATs are issued.
5. Over-minted EBT: corrections go through council-approved `manualReissue`
   only in the other direction (it mints); there is no burn-by-council. Record
   the affected settles and decide compensation separately.
6. Write up the incident (which events failed, why, what was revoked or
   rotated, when) in the ops log.

## Not an alert

- A settle that failed on chain (no event).
- Events from before the chip was registered do not exist: `settle` refuses
  unregistered chips.
