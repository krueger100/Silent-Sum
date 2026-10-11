/**
 * The band depends entirely on this number, so the ways it can be wrong matter more than the
 * way it is right. The GCS JSON API reports `size` as a STRING of decimal digits, and an object
 * can come back without one.
 */
import { bandFor, planKey, CLOUD_BANDS, CLOUD_CEILING_BYTES } from '../bands';
import { accountPrefix, sumObjectSizes } from '../storageMeter';

const GIB = 1024 * 1024 * 1024;

describe('accountPrefix', () => {
  it('is the account subtree and nothing else', () => {
    expect(accountPrefix('abc123')).toBe('users/abc123/');
  });

  it('refuses anything that could widen the listing past one account', () => {
    // A prefix of `users/` would measure EVERY account as one vault. The uid comes from a
    // verified token today, which is exactly why this must still hold if that ever changes.
    expect(() => accountPrefix('')).toThrow();
    expect(() => accountPrefix('../..')).toThrow();
    expect(() => accountPrefix('a/b')).toThrow();
    expect(() => accountPrefix('a*')).toThrow();
  });
});

describe('sumObjectSizes', () => {
  it('adds up sizes reported as strings, which is how the JSON API gives them', () => {
    expect(
      sumObjectSizes([{ metadata: { size: '1000' } }, { metadata: { size: '2500' } }]),
    ).toBe(3500);
  });

  it('accepts numbers too', () => {
    expect(sumObjectSizes([{ metadata: { size: 1000 } }])).toBe(1000);
  });

  it('treats a missing or unreadable size as zero, never as NaN', () => {
    // One NaN would poison the total, and a NaN total falls to the CHEAPEST band -- so a
    // listing with one odd object would bill a 500 GB vault at 64 GB.
    const total = sumObjectSizes([
      { metadata: { size: '1000' } },
      {},
      { metadata: {} },
      { metadata: { size: null } },
      { metadata: { size: 'unknown' } },
      { metadata: { size: '-5' } },
    ]);
    expect(total).toBe(1000);
    expect(Number.isFinite(total)).toBe(true);
  });

  it('is zero for an empty vault', () => {
    expect(sumObjectSizes([])).toBe(0);
  });
});

describe('bandFor', () => {
  it.each([
    [0, 9900],
    [1, 9900],
    [64 * GIB, 9900],
    [64 * GIB + 1, 24900],
    [160 * GIB, 24900],
    [160 * GIB + 1, 79900],
    [512 * GIB, 79900],
  ])('bills %p bytes at %p centavos', (bytes, centavos) => {
    expect(bandFor(bytes).priceCentavos).toBe(centavos);
  });

  it('bills a vault past the ceiling at the top band', () => {
    // It cannot grow, everything in it stays readable, and charging the largest vaults nothing
    // would be exactly backwards.
    expect(bandFor(CLOUD_CEILING_BYTES + 1).priceCentavos).toBe(79900);
    expect(bandFor(Number.MAX_SAFE_INTEGER).priceCentavos).toBe(79900);
  });

  it('falls to the cheapest band for a measurement that went wrong', () => {
    // A failed measurement must not produce a 799-peso invoice.
    expect(bandFor(Number.NaN).priceCentavos).toBe(9900);
    expect(bandFor(-1).priceCentavos).toBe(9900);
    expect(bandFor(Number.POSITIVE_INFINITY).priceCentavos).toBe(9900);
  });

  it('has bands in ascending order of both size and price', () => {
    for (let i = 1; i < CLOUD_BANDS.length; i += 1) {
      expect(CLOUD_BANDS[i]!.maxBytes).toBeGreaterThan(CLOUD_BANDS[i - 1]!.maxBytes);
      expect(CLOUD_BANDS[i]!.priceCentavos).toBeGreaterThan(CLOUD_BANDS[i - 1]!.priceCentavos);
    }
  });
});

describe('planKey', () => {
  it('separates modes, so a test plan is never charged to a live card', () => {
    const band = CLOUD_BANDS[0]!;
    expect(planKey(band, 'PHP', false)).toBe('cloud_test_php_9900');
    expect(planKey(band, 'PHP', true)).toBe('cloud_live_php_9900');
  });

  it('separates prices, so changing a band makes a NEW plan', () => {
    // A PayMongo plan's amount is what subscribers are actually charged. Reusing a plan after a
    // price change would quietly keep billing the old number for as long as it existed.
    const keys = CLOUD_BANDS.map((band) => planKey(band, 'PHP', true));
    expect(new Set(keys).size).toBe(CLOUD_BANDS.length);
  });
});
