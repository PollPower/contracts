// Verify monolith ceremony deploy state on chain.
//
// The monolith uses a ceremony-fenced deploy: 7 KEEP circuits are compiled
// into the deploy transaction, and 11 DEFER circuits are inserted via
// post-deploy `submitInsertVerifierKeyTx` maintenance transactions.
//
// This script tracks progress against `deployment.json.circuitsRolledIn` —
// so it produces sensible output at any point in the rollout, not only
// pre-rollout.
//
// Success criteria:
//   - All KEEP circuits: DEFINED
//   - Each DEFER circuit that is in circuitsRolledIn: DEFINED
//   - Each DEFER circuit NOT in circuitsRolledIn: UNDEFINED
//
// Env overrides:
//   MONOLITH_ADDR — override deployment.json.contractAddress
//   ROLLED_IN    — comma-separated list to override deployment.json.circuitsRolledIn
//
import * as fs from 'node:fs';

const DEPLOYMENT_PATH = '/home/pollpower/contracts/tariff-registry/deployment.json';

let deployment = {};
try {
  deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
} catch (e) {
  console.warn(`[verify] could not read ${DEPLOYMENT_PATH}: ${e.message}`);
}

const CONTRACT_ADDRESS = process.env.MONOLITH_ADDR || deployment.contractAddress;
if (!CONTRACT_ADDRESS) { console.error('no contractAddress'); process.exit(1); }

// Circuit split — matches tariff-registry-v1-ceremony.compact fence.
const KEEP = [
  'bootstrapActionLog',
  'advanceEpoch',
  'registerSchedule',
  'registerLane',
  'isChartered',
  'getActionEntry',
  'getActionPayloadHash',
];
const DEFER = [
  'retireSchedule',
  'setNationalContext',
  'setFederationAuthority',
  'retireLane',
  'retuneClass',
  'resolvePath',
  'resolveCurrent',
  'isScheduleActive',
  'resolveLane',
  'resolveLanes',
  'isLaneActive',
];

// Which DEFER circuits are expected DEFINED at this point in the rollout?
const rolledInFromEnv = process.env.ROLLED_IN
  ? process.env.ROLLED_IN.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const rolledIn = new Set(rolledInFromEnv || deployment.circuitsRolledIn || []);

console.log('[verify] target address:', CONTRACT_ADDRESS);
console.log('[verify] rolled in so far:', rolledIn.size === 0 ? '(none)' : [...rolledIn].join(', '));
console.log('[verify] still deferred:',
  DEFER.filter((c) => !rolledIn.has(c)).join(', ') || '(none — all 18 present)');

const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
setNetworkId('preview');
const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
const pub = indexerPublicDataProvider(
  'https://indexer.preview.midnight.network/api/v3/graphql',
  'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
);
const state = await pub.queryContractState(CONTRACT_ADDRESS);
if (!state) { console.error('no contract state'); process.exit(1); }

let issues = 0;

console.log();
console.log('=== KEEP (must be DEFINED) ===');
for (const c of KEEP) {
  const defined = state.operation(c) !== undefined;
  console.log(`  ${defined ? '✅' : '❌'} ${c}  ${defined ? '[DEFINED]' : '[UNDEFINED - PROBLEM]'}`);
  if (!defined) issues++;
}

console.log();
console.log('=== DEFER (state depends on rollout progress) ===');
for (const c of DEFER) {
  const defined = state.operation(c) !== undefined;
  const expected = rolledIn.has(c);
  const ok = defined === expected;
  const label = defined ? 'DEFINED' : 'UNDEFINED';
  const note = ok
    ? (expected ? '[rolled in]' : '[pending]')
    : (expected ? '[PROBLEM: expected DEFINED, got UNDEFINED]' : '[PROBLEM: expected UNDEFINED, got DEFINED]');
  console.log(`  ${ok ? '✅' : '❌'} ${c}  [${label}] ${note}`);
  if (!ok) issues++;
}

const totalDefined = [...KEEP, ...DEFER].filter((c) => state.operation(c) !== undefined).length;
console.log();
console.log(`[verify] ${totalDefined}/${KEEP.length + DEFER.length} circuits DEFINED`);
console.log(`[verify] total issues: ${issues}`);
process.exit(issues > 0 ? 1 : 0);
