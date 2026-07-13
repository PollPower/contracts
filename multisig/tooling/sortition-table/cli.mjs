#!/usr/bin/env node
// multisig/tooling/sortition-table/cli.mjs
// -----------------------------------------------------------------------------
// Unified CLI dispatcher for the two SORTITION-DRAW-SPEC/v1 reference tools:
//
//   node cli.mjs build-table <args>
//   node cli.mjs audit-draw  <args>
//
// See ./README.md for full usage examples. Every command is pure w.r.t. its
// inputs; the only side-effects live in this file (argv parsing, stdin read,
// stdout/stderr write, file read/write).
// -----------------------------------------------------------------------------

import { runBuildTable } from './build-table.mjs';
import { runAuditDraw } from './audit-draw.mjs';

function usage() {
  return [
    'Usage:',
    '  node cli.mjs build-table [--in <path>|-] [--out <path>|-] [--pretty]',
    '  node cli.mjs audit-draw  [--in <path>|-] [--out <path>|-] [--pretty]',
    '',
    'build-table reads an eligibility snapshot JSON:',
    '  { epoch: <number>, rows: [{ memberAddr: 0x<64hex>, weight: <int>, isFederationSeat?: <bool> }, ...] }',
    'and emits the canonical table (sorted, indexed, cumulative) + membershipRoot.',
    '',
    'audit-draw reads:',
    '  { table: <build-table output>, seed: 0x<64hex>, claimedIncoming: [0x<64hex>, ... 5 total] }',
    'and emits { verdict: "MATCH" | "MISMATCH", ... } per SORTITION-DRAW-SPEC §5.4.',
    '',
    'Both commands are deterministic. --in defaults to stdin, --out defaults to stdout.',
    'Exit codes: 0 on MATCH/success, 2 on MISMATCH (audit only), 1 on any error.',
  ].join('\n');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  switch (cmd) {
    case 'build-table':
      return await runBuildTable(rest);
    case 'audit-draw':
      return await runAuditDraw(rest);
    default:
      process.stderr.write(`unknown subcommand: ${cmd}\n\n${usage()}\n`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exit(code ?? 0); })
  .catch((err) => {
    process.stderr.write(`ERROR: ${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
  });
