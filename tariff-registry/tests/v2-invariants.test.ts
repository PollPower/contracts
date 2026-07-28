import assert from 'node:assert/strict';
import { expectedBootstrapShards, V2_CONTRACT_ORDER } from './v2-split-fixtures';

describe('WI-15 split invariant scaffolding', () => {
  it('keeps deterministic deploy order', () => {
    assert.deepEqual(V2_CONTRACT_ORDER, [
      'tariff-audit',
      'tariff-governance',
      'tariff-schedule',
      'tariff-lane',
      'tariff-views',
    ]);
  });

  it('keeps WI-13.3 bootstrap shard sequence', () => {
    assert.deepEqual(expectedBootstrapShards(), [8n, 16n, 24n]);
  });
});
