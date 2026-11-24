// Parity: TariffRegistry v1 compiled with Compact 0.36.1 vs the JS mirror
// (tariff-registry/tests/lib.mjs) and the compact-runtime builder used by the
// mirror daemon / ceremony tooling (ebt/settle-flow/ceremony.mjs initEmptyTree).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../tariff-registry/tests/lib.mjs';
import { buildExists, loadContract, deploy, b32, hex, runtimePersistentHash, padTag } from './harness.mjs';

const NAME = 'tariff-registry-v1';
const DEPTH = 24;
const skip = buildExists(NAME) ? false : 'build/l9/tariff-registry-v1 missing: run `npm run build:contracts`';

// No witness is reached by bootstrapActionLog; anything that is reached fails loudly.
const unused = (name) => () => { throw new Error(`witness ${name} must not be called in this test`); };
const witnesses = {
  signature_valid: unused('signature_valid'),
  multisig_signature_valid: unused('multisig_signature_valid'),
  charter_membership_proof: unused('charter_membership_proof'),
  witness_divmod: unused('witness_divmod'),
  action_log_path_bits: unused('action_log_path_bits'),
};

function runtimeEmptyTree(depth) {
  const zeros = [padTag('pp:tariff:v1:actionLogEmpty')];
  for (let i = 1; i <= depth; i++) {
    zeros[i] = runtimePersistentHash([padTag('pp:tariff:v1:actionLogNode'), zeros[i - 1], zeros[i - 1]]);
  }
  return zeros;
}

test('TR-1: empty action-log root and every zero level match the mirror and the daemon builder', { skip }, async () => {
  const mod = await loadContract(NAME);
  const c = await deploy(mod, witnesses, [b32(0xa1), b32(0xa2), 100n]);
  await c.call('bootstrapActionLog', BigInt(DEPTH));
  const L = c.ledger();
  assert.equal(L._bootstrapComplete, true);

  const mirror = M.actionLogZeros(DEPTH);
  const runtime = runtimeEmptyTree(DEPTH);

  assert.equal(hex(L.registryActionLogRoot), hex(mirror.emptyRoot), 'circuit root != JS mirror (SHA-256) root');
  assert.equal(hex(L.registryActionLogRoot), hex(runtime[DEPTH]), 'circuit root != compact-runtime builder root');
  for (let i = 0; i < DEPTH; i++) {
    const onChain = L._actionLogZeros.lookup(BigInt(i));
    assert.equal(hex(onChain), hex(mirror.zeros[i]), `zero level ${i}: circuit != mirror`);
    assert.equal(hex(onChain), hex(runtime[i]), `zero level ${i}: circuit != runtime builder`);
  }
});
