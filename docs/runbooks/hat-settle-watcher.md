# Runbook: HAT settle watcher alert

Status: watcher built and proven on the devnet (WI-16 step 4, `tooling/watcher/`);
runs as a service (Joi deploys). Decisions: Garrett, 2026-11-24.

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

## Alert channels (Garrett, 2026-11-24)

Every alert goes to **both**:

- a **Telegram bot** posting to the council group (Garrett, Jonathan, Timothy);
- **email** to each of the three council members (backup).

Each channel is a separate delivery: the Telegram group and each member's
email are delivered and retried on their own. If Telegram is down the emails
still go out (and Telegram is retried every pass); if SMTP is down Telegram
still goes out (and the emails are retried). Nothing already delivered is sent
twice. Tests: `tooling/tests/alert-channels.test.mjs` (AC-1..8).

The service refuses to start unless both channels and all three members are
configured. Secrets are read only from files that are owner-only (mode 600)
and outside any git working tree; setting a secret directly in the environment
is refused.

### One-time setup

Telegram (Garrett):

1. In Telegram, open **@BotFather**, send `/newbot`, name it e.g.
   "PollPower Council Alerts" and pick a username ending in `bot`. BotFather
   replies with the **bot token**. Do not paste it into any chat, Signal, ticket
   or repo; it goes only into the token file (step 5).
2. Create a group "PollPower Council Alerts" with Garrett, Jonathan and
   Timothy, and add the bot. In the group settings, only admins may add
   members.
3. Back in @BotFather: `/setjoingroups` -> the bot -> **Disable**, so nobody
   can add it to another group. Leave privacy mode on (the bot only posts).
4. In the group, send `/start@<botusername>` once (lets the bot see the chat).

On the watcher host (Joi):

5. Service user and secrets directory, then the two secret files, typed or
   pasted at the prompt (nothing lands in shell history or the process list):

   ```sh
   sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin ppwatch
   sudo install -d -m 700 -o ppwatch -g ppwatch /etc/pollpower/secrets
   sudo -u ppwatch sh -c 'umask 077; cat > /etc/pollpower/secrets/telegram-bot-token'   # paste token, Enter, Ctrl-D
   sudo -u ppwatch sh -c 'umask 077; cat > /etc/pollpower/secrets/smtp-password'        # paste SMTP app password, Enter, Ctrl-D
   ```

6. Group chat id (negative number), keeping the token out of argv:

   ```sh
   sudo -u ppwatch sh -c 'printf "url = https://api.telegram.org/bot%s/getUpdates
" "$(cat /etc/pollpower/secrets/telegram-bot-token)" | curl -s -K -'      | grep -o '"chat":{"id":-[0-9]*' | sort -u
   ```

7. Email: a sending mailbox (e.g. an `alerts@` address on the domain's mail
   provider; with Google Workspace: 2-step verification on, an **app password**,
   `smtp.gmail.com`, port 465). Each council member adds a filter so mail from
   it is never marked spam.
8. Copy `tooling/watcher/deploy/settle-watcher.env.example` to
   `/etc/pollpower/settle-watcher.env` (mode 640, root:ppwatch) and fill it in
   (no secrets in it). Install `tooling/watcher/deploy/pp-settle-watcher.service`
   into `/etc/systemd/system/`. Run the watcher on a **different host from
   meter-authority-service**: the watcher is what catches a compromised meter
   authority.
9. Test every channel before enabling:

   ```sh
   cd /opt/pollpower/contracts && sudo -u ppwatch env $(grep -v '^#' /etc/pollpower/settle-watcher.env | xargs)      node tooling/watcher/settle-watcher-service.mjs --test-alert
   ```

   Expect `delivered` for `telegram:<chat id>`, `email:garrett`,
   `email:jonathan`, `email:timothy`, and each member confirms receipt.
10. `sudo systemctl daemon-reload && sudo systemctl enable --now pp-settle-watcher`;
    `journalctl -u pp-settle-watcher -f` shows the channels and each pass.

Rotating: replace the file content (same commands as step 5), then
`systemctl restart pp-settle-watcher`. A leaked bot token is revoked with
@BotFather `/revoke`.
