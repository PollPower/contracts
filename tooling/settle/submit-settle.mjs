// @ts-check
// On-chain EBT settle submit with retry (WI-16 step 4; used by the devnet run
// and, through its adapter, by pp-settle-service).
//
// A countersigned settle (chip attestation + meter-authority HAT) must not be
// lost: meter-authority-service will not countersign the same session again.
// So the submit retries transient failures, and before every retry checks the
// chain: if the session is already in EBT's _settledSessions, the earlier
// attempt landed (e.g. it timed out locally after submission) and nothing is
// resubmitted. A contract assertion (Bad HAT signature, CHIP_*, SPLIT_OFF_CLASS,
// ...) is permanent: no retry.

const PERMANENT = /failed assert|Bad HAT signature|CHIP_|SPLIT_OFF_CLASS|AMOUNT_NOT_CHIP_METERED|Session already settled|SCHEDULE_NOT_LIVE|CLASS_NOT_LIVE|PRODUCER_NOT_ATTESTED|OPERATOR_DEFEDERATED|LANE_|SLICE_OFF_POLICY/;

/**
 * @param {object} p
 * @param {(args: any[]) => Promise<any>} p.submit      calls ebt.callTx.settle(...args)
 * @param {() => Promise<boolean>} p.alreadySettled     true if EBT has this session in _settledSessions
 * @param {any[]} p.args                                 settle arguments
 * @param {number} [p.attempts]                          default 4
 * @param {number} [p.baseDelayMs]                       default 15000 (x2 each retry)
 * @param {(ms: number) => Promise<void>} [p.sleep]
 * @param {{ log: Function }} [p.log]
 * @returns {Promise<{ status: 'submitted' | 'already-settled', tx?: any, attempts: number }>}
 */
export async function submitSettleWithRetry({ submit, alreadySettled, args, attempts = 4, baseDelayMs = 15000, sleep, log = console }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    if (i > 1 && await alreadySettled()) {
      log.log(`[settle] session already on chain (attempt ${i - 1} landed): not resubmitting`);
      return { status: 'already-settled', attempts: i - 1 };
    }
    try {
      const tx = await submit(args);
      return { status: 'submitted', tx, attempts: i };
    } catch (e) {
      lastErr = e;
      const msg = String(/** @type {any} */ (e)?.message ?? e);
      if (PERMANENT.test(msg)) throw e;                        // the contract said no: retrying cannot help
      log.log(`[settle] attempt ${i}/${attempts} failed (${msg.slice(0, 120)})${i < attempts ? '; retrying' : ''}`);
      if (i < attempts) await wait(baseDelayMs * 2 ** (i - 1));
    }
  }
  if (await alreadySettled()) return { status: 'already-settled', attempts };
  throw lastErr;
}
