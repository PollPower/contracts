# WI-16 recorded demo (2–3 min)

Scope (Garrett, 2026-11-24): a council approval signed by a real Tangem ring;
a metered settle with the chip attestation; a member claiming Living Dividend
through the contract-to-contract call; an attack refused; the watcher alerting
on a forged settle.

Everything runs on the local devnet with the same builds and deploy code as
the qualifying fresh pass (`docs/devnet-passes/`). The demo is a separate
deployment of that suite, because the pass council has only devnet test keys
and a ring can only approve for a council it sits in.

## Honest framing (say it or show it on screen)

- Local devnet, not Preprod. Real zero-knowledge proofs, real transactions.
- Council slot 0 is a real Tangem ring. Slots 1–2 are devnet stand-ins for
  the other two members (their rings join at the Preprod ceremony).
- The meter is a devnet software HAT chip (hardware id prefix `PPDEV`, refused
  off-devnet). The chip signature and the meter-authority countersignature are
  real Ed25519 / Jubjub signatures over the real formats.
- Proof generation takes 30–120 s per transaction; those waits are sped up
  in the edit, with a visible "proving, sped up" label.

## Shot list and narration (≈ 2:30)

| Time | Picture | Narration |
|---|---|---|
| 0:00–0:15 | Title, then the terminal | "PollPower turns metered solar into tokens on Midnight. Here is the whole path on a local Midnight network: real proofs, real transactions." |
| 0:15–0:50 | Scene 1: hash on screen; phone, ring tap, shared result; approval lands; second approval; member registered | "A new member passed KYC. Registering them needs two of the three council members. The first approval is signed by a Tangem ring, a hardware key worn on the hand, and the contract checks that signature inside the proof. A second member approves, and the Living Dividend contract asks the council contract directly before it registers them." |
| 0:50–1:25 | Scene 2: chip reading, split, settle, event re-verified | "A meter's HAT chip signs its reading. The meter authority checks it and countersigns. The contract mints exactly the metered energy and splits it as the tariff class says: producer, operations, Living Dividend, DAO, and the statutory levy, paid on chain to its remit address. Anyone can re-check the chip's signature from the public event." |
| 1:25–1:50 | Scene 3: claim | "The new member claims their Living Dividend with their own key. Living Dividend calls the token contract twice in one transaction, and the tokens go straight to the member." |
| 1:50–2:10 | Scene 4: three REFUSED lines, supply unchanged | "Now the attacks. Replaying a settled reading: refused. A valid reading where the submitter takes the members' share: refused. Skipping the statutory levy: refused. Nothing changed." |
| 2:10–2:35 | Scene 5: forged settle accepted, watcher pass, Telegram group message + email arriving | "The hardest case: a compromised meter service countersigns a reading with a fake chip signature. The chain cannot check that signature type, so it accepts it. The watcher re-checks every settle, catches it within a minute, and alerts the whole council on Telegram and by email, so two of them can revoke the chip." |
| 2:35–2:45 | End card | "Next: the same contracts, the same deploy script, on Midnight Preprod." |

## Preparation, recording procedure and checks

Kept in the private ops repository (`PollPower/ops`, private) at
`contracts/docs/demo/wi16-demo.md` (hosts, environment, on-camera steps).
