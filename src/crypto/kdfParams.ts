/**
 * Argon2id parameter record. Stored next to every wrapped key so the cost can be raised later
 * without invalidating existing vaults.
 *
 * JSON: {"alg":"argon2id","m":<KiB>,"t":<passes>,"p":<lanes>,"len":32}
 */
import { KDF_LIMITS, RecordFormatError, type KdfParams, type KdfParamsJson } from '@/crypto/types';

export function kdfParamsToJson(params: KdfParams): KdfParamsJson {
  return {
    alg: 'argon2id',
    m: params.memoryKiB,
    t: params.iterations,
    p: params.parallelism,
    len: params.hashLength,
  };
}

function intField(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RecordFormatError(`kdf.${name} is not a number`);
  }
  const rounded = Math.trunc(value);
  if (rounded !== value) throw new RecordFormatError(`kdf.${name} is not an integer`);
  return rounded;
}

/**
 * Parses and bounds-checks. The bounds are what stops a hostile record (a tampered secure-store
 * entry or a downloaded backup envelope) from making the device allocate gigabytes or spin for
 * minutes inside the KDF. Identical limits to the Flutter reference so records interoperate.
 */
export function kdfParamsFromJson(value: unknown): KdfParams {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('kdf is not an object');
  }
  const source = value as Record<string, unknown>;
  if (source.alg !== 'argon2id') {
    throw new RecordFormatError('unsupported kdf algorithm');
  }
  const m = intField(source, 'm');
  const t = intField(source, 't');
  const p = intField(source, 'p');
  const len = source.len === undefined ? KDF_LIMITS.hashLength : intField(source, 'len');

  if (p < 1 || p > KDF_LIMITS.maxParallelism) {
    throw new RecordFormatError(`kdf parallelism ${p} out of range`);
  }
  if (m < 8 * p || m > KDF_LIMITS.maxMemoryKiB) {
    throw new RecordFormatError(`kdf memory ${m} out of range`);
  }
  if (t < 1 || t > KDF_LIMITS.maxIterations) {
    throw new RecordFormatError(`kdf iterations ${t} out of range`);
  }
  if (len !== KDF_LIMITS.hashLength) {
    throw new RecordFormatError(`kdf hash length ${len} unsupported`);
  }
  return { memoryKiB: m, iterations: t, parallelism: p, hashLength: len };
}

export function kdfParamsEqual(a: KdfParams, b: KdfParams): boolean {
  return (
    a.memoryKiB === b.memoryKiB &&
    a.iterations === b.iterations &&
    a.parallelism === b.parallelism &&
    a.hashLength === b.hashLength
  );
}
