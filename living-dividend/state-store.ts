import * as fs from 'node:fs';
import * as path from 'node:path';

type BigIntJson = { __bigint: string };

function isBigIntJson(value: unknown): value is BigIntJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__bigint' in value &&
    typeof (value as { __bigint?: unknown }).__bigint === 'string'
  );
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { __bigint: value.toString() } satisfies BigIntJson;
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (isBigIntJson(value)) {
    return BigInt(value.__bigint);
  }
  return value;
}

export async function readState<T>(filePath: string, fallback: T): Promise<T> {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = await fs.promises.readFile(filePath, 'utf8');
  if (raw.trim() === '') {
    return fallback;
  }
  return JSON.parse(raw, reviver) as T;
}

export async function writeState<T>(filePath: string, value: T): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const json = JSON.stringify(value, replacer, 2);
  await fs.promises.writeFile(filePath, `${json}\n`, 'utf8');
}
