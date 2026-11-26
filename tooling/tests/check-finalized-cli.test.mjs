// Read-only checkFinalized CLI: which record keys map to which builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targets, BUILDS } from '../deploy/check-finalized.mjs';

test('CF-1: record keys map to the suite builds; unknown or undeployed contracts are refused', () => {
  assert.deepEqual(BUILDS, { council: 'multisig-v8', tr: 'tariff-registry-v1', ebt: 'ebt-v8', ld: 'living-dividend-v3' });
  const rec = { council: 'aa', tr: 'bb', ebt: 'cc', ld: 'dd' };
  assert.deepEqual(targets(rec, ['ebt', 'ld']), [{ key: 'ebt', build: 'ebt-v8', address: 'cc' }, { key: 'ld', build: 'living-dividend-v3', address: 'dd' }]);
  assert.equal(targets(rec, []).length, 4, 'no list = all four');
  assert.throws(() => targets(rec, ['nope']), /unknown contract/);
  assert.throws(() => targets({ council: 'aa' }, ['ld']), /not in the record/);
});
