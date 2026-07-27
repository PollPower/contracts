export const V2_CONTRACT_ORDER = [
  'tariff-audit',
  'tariff-governance',
  'tariff-schedule',
  'tariff-lane',
  'tariff-views',
] as const;

export function expectedBootstrapShards(): bigint[] {
  return [8n, 16n, 24n];
}
