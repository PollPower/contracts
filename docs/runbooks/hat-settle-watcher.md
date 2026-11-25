# HAT settle watcher

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


On an alert the council verifies and revokes the chip 2-of-3 (`revokeChip`).
Alerts go to every council member on two independent channels, so one
channel failing never holds back the other.

**Moved (2026-11-25).** The operational procedure (hosts, people, day-of steps)
is kept in PollPower's private ops repository (`PollPower/ops`, private) at
`contracts/docs/runbooks/hat-settle-watcher.md`. This repository stays public on purpose; operational
and council details do not live here.
