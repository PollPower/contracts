import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

setNetworkId('preview');

/**
 * WI-15 local-sandbox split deploy harness.
 *
 * NOTE: This script intentionally targets local/sandbox execution only.
 * It does not run preview deployment in this implementation session.
 */
async function main(): Promise<void> {
  console.log('[wi15] split deploy script scaffold (local sandbox only)');
  console.log('[wi15] deploy order: audit -> governance -> schedule -> lane -> views');
  console.log('[wi15] bootstrap: bootstrapActionLog(8), (16), (24)');
  console.log('[wi15] seed governance: advanceEpoch(1, ...)');
  console.log('[wi15] start mirror-writer daemon after seed');

  // TODO(WI-15): wire concrete deployContract calls for each sibling contract artifact.
  // TODO(WI-15): thread constructor addresses AUDIT_ADDR/GOV_ADDR/SCHED_ADDR/LANE_ADDR.
  // TODO(WI-15): perform commitAuditEntry smoke call and resolveGlobalSeq assertion.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
