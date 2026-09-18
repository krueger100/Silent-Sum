/**
 * ISO-8601 UTC timestamps in the exact shape the Flutter reference writes:
 * `YYYY-MM-DDTHH:mm:ss.SSSZ` (3 fractional digits). Parsing accepts 0-9 fractional digits and an
 * optional offset, so records produced by either implementation interoperate.
 */
export function toIso8601Utc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export class Iso8601Error extends Error {
  constructor(value: unknown) {
    super(`invalid ISO-8601 timestamp: ${typeof value === 'string' ? value : typeof value}`);
    this.name = 'Iso8601Error';
  }
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/** Strict parser; returns epoch milliseconds or throws Iso8601Error. */
export function parseIso8601(value: unknown): number {
  if (typeof value !== 'string') throw new Iso8601Error(value);
  const m = ISO_RE.exec(value.trim());
  if (!m) throw new Iso8601Error(value);
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const millis = frac ? Number((frac + '000').slice(0, 3)) : 0;
  let epoch = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    millis,
  );
  if (Number.isNaN(epoch)) throw new Iso8601Error(value);
  if (zone && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    epoch -= sign * offsetMin * 60_000;
  }
  return epoch;
}

/** Lenient variant for optional fields: null for anything unparseable. */
export function tryParseIso8601(value: unknown): number | null {
  try {
    return parseIso8601(value);
  } catch {
    return null;
  }
}
