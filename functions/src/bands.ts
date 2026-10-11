/**
 * What Cloud costs, by how much the vault holds -- the SERVER's copy of the table.
 *
 * THIS MUST MATCH `src/billing/entitlements.ts` (`CLOUD_BANDS`). The app and the backend are
 * separate npm packages with separate tsconfigs, so the table cannot simply be imported; it is
 * duplicated here because the server is the only side allowed to decide a price, and the client
 * copy exists only to render it. `test/bandParity.test.js` at the repository root reads both
 * files and fails if a number drifts, which is the guard that makes the duplication safe.
 *
 * The reasoning behind the numbers lives next to the client table. In short: a stored GB costs
 * about $0.0132/month with Autoclass on, and each band keeps 35-65% of net revenue at the TOP
 * of the band, where a subscriber is most expensive. WITHOUT Autoclass the real rate is $0.027
 * and the 160 GB and 512 GB bands lose money, which is why `firebase/README.md` treats enabling
 * it as a prerequisite for selling them rather than an optimisation.
 */
const GIB = 1024 * 1024 * 1024;

export interface CloudBand {
  /** Inclusive upper bound on stored bytes. */
  readonly maxBytes: number;
  readonly priceCentavos: number;
  /** For the plan name PayMongo shows on a statement: "64 GB". */
  readonly label: string;
}

export const CLOUD_BANDS: readonly CloudBand[] = [
  { maxBytes: 64 * GIB, priceCentavos: 9900, label: '64 GB' },
  { maxBytes: 160 * GIB, priceCentavos: 24900, label: '160 GB' },
  { maxBytes: 512 * GIB, priceCentavos: 79900, label: '512 GB' },
];

/** The top band, which is also the ceiling on additions. Never undefined; the table is fixed. */
const TOP_BAND = CLOUD_BANDS[CLOUD_BANDS.length - 1] as CloudBand;

export const CLOUD_CEILING_BYTES = TOP_BAND.maxBytes;

/**
 * The band a vault of this size is billed in.
 *
 * A vault over the ceiling is billed at the top band rather than refused: it cannot grow (the
 * app stops accepting additions), everything in it stays readable, and charging the largest
 * vaults nothing would be exactly backwards. Negative or non-finite input is billed at the
 * cheapest band -- a measurement that went wrong must not produce a ₱799 invoice.
 */
export function bandFor(storedBytes: number): CloudBand {
  if (!Number.isFinite(storedBytes) || storedBytes <= 0) return CLOUD_BANDS[0] as CloudBand;
  return CLOUD_BANDS.find((band) => storedBytes <= band.maxBytes) ?? TOP_BAND;
}

/**
 * The cache key for a band's PayMongo plan.
 *
 * The price and the mode are both in the key on purpose. Changing a band's price must create a
 * NEW plan, because a PayMongo plan's amount is what subscribers are actually charged and
 * reusing the old one would quietly keep billing the old number; and a test-mode plan id is
 * meaningless to a live key, so the two can never be confused.
 */
export function planKey(band: CloudBand, currency: string, livemode: boolean): string {
  const mode = livemode ? 'live' : 'test';
  return `cloud_${mode}_${currency.toLowerCase()}_${String(band.priceCentavos)}`;
}

/** The name PayMongo shows for the plan. The product name is deliberately plain. */
export function planName(band: CloudBand): string {
  return `SilentSum Cloud ${band.label}`;
}
