import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  persistentHash as runtimePersistentHash,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'deploy', 'artifacts');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'empty-charter-root-verification.txt');
const CHARTER_DEPTH = 12;

function pad32(tag) {
  const out = new Uint8Array(32);
  const b = Buffer.from(tag, 'utf8');
  if (b.length > 32) throw new Error(`tag too long: ${tag}`);
  out.set(b);
  return out;
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function persistentHash(parts) {
  return runtimePersistentHash(
    new CompactTypeVector(parts.length, new CompactTypeBytes(32)),
    parts,
  );
}

function computeLevels() {
  const levels = [];
  let current = persistentHash([pad32('pp:fed:charter:leaf'), new Uint8Array(32)]);
  levels.push(current);
  const nodeDomain = pad32('pp:fed:charter:node');
  for (let i = 0; i < CHARTER_DEPTH; i++) {
    current = persistentHash([nodeDomain, current, current]);
    levels.push(current);
  }
  return levels;
}

function main() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const levelsA = computeLevels();
  const levelsB = computeLevels();
  const rootA = levelsA[CHARTER_DEPTH];
  const rootB = levelsB[CHARTER_DEPTH];
  const deterministic = Buffer.from(rootA).equals(Buffer.from(rootB));
  const nonZero = !Buffer.from(rootA).equals(Buffer.alloc(32));
  const lines = [
    '# Empty Charter Root Verification',
    `generatedAt=${new Date().toISOString()}`,
    `CHARTER_DEPTH=${CHARTER_DEPTH}`,
    '',
  ];
  for (let i = 0; i < levelsA.length; i++) {
    lines.push(`level[${i}]=${toHex(levelsA[i])}`);
  }
  lines.push('');
  lines.push(`root=${toHex(rootA)}`);
  lines.push(`deterministic=${deterministic}`);
  lines.push(`nonZero=${nonZero}`);
  if (!deterministic) throw new Error('determinism check failed');
  if (!nonZero) throw new Error('root must not be all zeros');
  writeFileSync(OUT_PATH, `${lines.join('\n')}\n`);
  console.log(`wrote ${OUT_PATH}`);
}

main();
