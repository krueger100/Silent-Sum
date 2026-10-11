import {
  BILLING_PATHS,
  FREE_ENTITLEMENTS,
  type Entitlements,
  CLOUD_BANDS,
  CLOUD_TIER,
  FREE_TIER,
  MAX_ITEM_BYTES,
  bandFor,
  cloudChargeCentavos,
  cloudActive,
  deriveCloudState,
  entitlementsToJson,
  parseEntitlements,
  vaultGate,
} from '@/billing/entitlements';
import { PRODUCTS, pesoNote, usdPrice } from '@/billing/products';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const DAY = 86_400_000;

describe('products', () => {
  it('carries the exact copy from the brief', () => {
    expect(PRODUCTS.pro).toMatchObject({
      name: 'SilentSum Pro',
      price: '₱299 one-time',
      tagline: 'Private messaging with other SilentSum users. Pay once, keep it forever.',
      priceCentavos: 29900,
      kind: 'one-time',
    });
    expect(PRODUCTS.cloud).toMatchObject({
      name: 'SilentSum Cloud',
      price: '₱99/month',
      tagline: 'A bigger vault and encrypted cloud backup. You pay for what you store.',
      priceCentavos: 9900,
      kind: 'monthly',
    });
  });

  /**
   * The headline carries the term, because "US$1.58" alone reads as a one-off -- and for Cloud
   * it carries "from", because the figure is the cheapest of three bands. A single price above
   * a line listing three is read as the price, which it is not.
   */
  it('builds the dollar price line from the price actually charged', () => {
    expect(usdPrice(PRODUCTS.pro)).toBe('US$4.76 one-time');
    expect(usdPrice(PRODUCTS.cloud)).toBe('from US$1.58/month');
  });

  it('names the peso in full underneath, because that is what leaves the card', () => {
    expect(pesoNote(PRODUCTS.pro)).toBe('about PH ₱299');
    expect(pesoNote(PRODUCTS.cloud)).toBe('about PH ₱99/month and up');
  });

  /** A banded product must never show a bare price; an unbanded one must never say "from". */
  it('says "from" exactly where the price is the first of several', () => {
    expect(PRODUCTS.cloud.banded).toBe(true);
    expect(PRODUCTS.pro.banded).toBe(false);
    expect(usdPrice(PRODUCTS.pro)).not.toMatch(/from/);
    expect(pesoNote(PRODUCTS.pro)).not.toMatch(/and up/);
  });

  /**
   * Both lines are computed from `priceCentavos`, so a price change moves them together. A
   * dollar headline that had not heard about a price rise would be a discount nobody agreed to,
   * and it is now the line a customer reads as the price.
   */
  it('moves both lines together when the charged price changes', () => {
    const dearer = { ...PRODUCTS.cloud, priceCentavos: 19900 };
    expect(usdPrice(dearer)).toBe('from US$3.17/month');
    expect(pesoNote(dearer)).toBe('about PH ₱199/month and up');
  });

  /** The peso must still be on screen somewhere in every inline mention. */
  it('keeps the peso in the copy used mid-sentence elsewhere', () => {
    expect(PRODUCTS.pro.price).toContain('₱');
    expect(PRODUCTS.cloud.price).toContain('₱');
  });
});

describe('parseEntitlements', () => {
  it('is free for a missing or malformed document', () => {
    expect(parseEntitlements(null)).toEqual(FREE_ENTITLEMENTS);
    expect(parseEntitlements(undefined)).toEqual(FREE_ENTITLEMENTS);
    expect(parseEntitlements({ pro: 'yes', cloud: 'active' })).toEqual(FREE_ENTITLEMENTS);
    expect(parseEntitlements({ pro: true, cloud: { status: 'sideways' } }).cloud.status).toBe(
      'none',
    );
  });

  it('reads Firestore timestamps, ISO strings and numbers', () => {
    const ts = { seconds: Math.floor(NOW / 1000), nanoseconds: 0, toMillis: () => NOW };
    const parsed = parseEntitlements({
      v: 1,
      pro: true,
      proSince: ts,
      proPaymentId: 'pay_1',
      cloud: {
        status: 'active',
        accessUntil: new Date(NOW + DAY).toISOString(),
        currentPeriodStart: NOW - DAY,
        currentPeriodEnd: { seconds: Math.floor((NOW + DAY) / 1000), nanoseconds: 0 },
        cancelAtPeriodEnd: false,
        source: 'term',
        subscriptionId: null,
      },
      updatedAt: ts,
    });
    expect(parsed.pro).toBe(true);
    expect(parsed.proSince).toBe(NOW);
    expect(parsed.cloud.accessUntil).toBe(NOW + DAY);
    expect(parsed.cloud.currentPeriodStart).toBe(NOW - DAY);
    expect(parsed.cloud.currentPeriodEnd).toBe(NOW + DAY);
    expect(parsed.cloud.status).toBe('active');
    expect(parsed.cloud.source).toBe('term');
    expect(parsed.updatedAt).toBe(NOW);
  });

  it('round-trips through the cache encoding', () => {
    const e = parseEntitlements({
      pro: true,
      proSince: NOW,
      cloud: {
        status: 'cancelled',
        accessUntil: NOW + DAY,
        cancelAtPeriodEnd: true,
        source: 'term',
        subscriptionId: 'sub_1',
      },
      updatedAt: NOW,
    });
    expect(parseEntitlements(entitlementsToJson(e))).toEqual(e);
    expect(parseEntitlements(entitlementsToJson(FREE_ENTITLEMENTS))).toEqual(FREE_ENTITLEMENTS);
  });

  it('never lets cloud state imply pro or the reverse', () => {
    const cloudOnly = parseEntitlements({
      pro: false,
      cloud: { status: 'active', accessUntil: NOW + DAY },
    });
    expect(cloudOnly.pro).toBe(false);
    expect(cloudActive(cloudOnly, NOW)).toBe(true);

    const proOnly = parseEntitlements({ pro: true, proSince: NOW });
    expect(proOnly.pro).toBe(true);
    expect(cloudActive(proOnly, NOW)).toBe(false);
  });
});

describe('deriveCloudState', () => {
  it('is inactive with no subscription', () => {
    expect(deriveCloudState(FREE_ENTITLEMENTS, NOW)).toEqual({ kind: 'inactive' });
  });

  it('is active with the days left and flags the renewal window', () => {
    const e = parseEntitlements({ cloud: { status: 'active', accessUntil: NOW + 10 * DAY } });
    expect(deriveCloudState(e, NOW)).toEqual({
      kind: 'active',
      until: NOW + 10 * DAY,
      daysLeft: 10,
      renewalDue: false,
      cancelAtPeriodEnd: false,
      pastDue: false,
      // A parsed document with no source is a term, and a term never renews itself.
      autoRenews: false,
    });
    const soon = parseEntitlements({ cloud: { status: 'active', accessUntil: NOW + 3 * DAY } });
    expect(deriveCloudState(soon, NOW)).toMatchObject({
      kind: 'active',
      daysLeft: 3,
      renewalDue: true,
    });
  });

  it('is expired once accessUntil has passed, whatever the stored status says', () => {
    const e = parseEntitlements({ cloud: { status: 'active', accessUntil: NOW - 1 } });
    expect(deriveCloudState(e, NOW)).toEqual({ kind: 'expired', on: NOW - 1 });
    expect(cloudActive(e, NOW)).toBe(false);
  });

  it('reports cancellation while access lasts', () => {
    const e = parseEntitlements({
      cloud: { status: 'cancelled', accessUntil: NOW + DAY, cancelAtPeriodEnd: true },
    });
    expect(deriveCloudState(e, NOW)).toMatchObject({
      kind: 'active',
      cancelAtPeriodEnd: true,
    });
    expect(cloudActive(e, NOW)).toBe(true);
  });

  it('keeps past-due access until the paid period ends, and says so', () => {
    const e = parseEntitlements({ cloud: { status: 'past_due', accessUntil: NOW + DAY } });
    expect(deriveCloudState(e, NOW)).toMatchObject({ kind: 'active', pastDue: true });
    expect(cloudActive(e, NOW)).toBe(true);
  });

  it('treats unpaid and incomplete as inactive even if a date is set', () => {
    for (const status of ['unpaid', 'incomplete', 'none'] as const) {
      const e = parseEntitlements({ cloud: { status, accessUntil: NOW + DAY } });
      expect(cloudActive(e, NOW)).toBe(false);
      expect(deriveCloudState(e, NOW)).toEqual({ kind: 'inactive' });
    }
  });
});

/**
 * Whether the provider will charge again on its own, which decides both the Renew button and
 * which of two opposite promises the screen makes.
 *
 * A `term` never renews itself: that is the billing SilentSum has today, and "Renew" has to keep
 * working for it. A `subscription` does -- until it is cancelled, after which access runs to the
 * end of the paid period and renewing becomes something the user might want again.
 */
describe('autoRenews', () => {
  const base = (over: Partial<Entitlements['cloud']>): Entitlements => ({
    ...FREE_ENTITLEMENTS,
    cloud: {
      ...FREE_ENTITLEMENTS.cloud,
      status: 'active',
      accessUntil: NOW + 10 * DAY,
      ...over,
    },
  });
  const active = (e: Entitlements) => {
    const s = deriveCloudState(e, NOW);
    if (s.kind !== 'active') throw new Error('expected an active term');
    return s;
  };

  it('is false for a term, which is bought one payment at a time', () => {
    expect(active(base({ source: 'term' })).autoRenews).toBe(false);
  });

  it('is false when there is no source at all', () => {
    expect(active(base({ source: null })).autoRenews).toBe(false);
  });

  it('is true for a live subscription', () => {
    expect(active(base({ source: 'subscription', subscriptionId: 'sub_1' })).autoRenews).toBe(true);
  });

  /** The window where Renew must come BACK: cancelled, but still inside the paid period. */
  it('is false once a subscription is cancelled, while access runs on', () => {
    const s = active(base({ source: 'subscription', subscriptionId: 'sub_1', cancelAtPeriodEnd: true }));
    expect(s.autoRenews).toBe(false);
    expect(s.cancelAtPeriodEnd).toBe(true);
    expect(s.until).toBeGreaterThan(NOW);
  });

  it('is false for a subscription the provider marked cancelled', () => {
    expect(
      active(base({ source: 'subscription', subscriptionId: 'sub_1', status: 'cancelled' })).autoRenews,
    ).toBe(false);
  });
});

describe('cloud storage bands', () => {
  const GIB = 1024 ** 3;

  it('charges by what is stored, at the first band that fits', () => {
    expect(bandFor(0)?.pricePhp).toBe(99);
    expect(bandFor(64 * GIB)?.pricePhp).toBe(99);
    expect(bandFor(64 * GIB + 1)?.pricePhp).toBe(249);
    expect(bandFor(160 * GIB)?.pricePhp).toBe(249);
    expect(bandFor(160 * GIB + 1)?.pricePhp).toBe(799);
    expect(bandFor(512 * GIB)?.pricePhp).toBe(799);
  });

  /** Past the top band there is no band, and that is a full vault rather than a free one. */
  it('has no band past the ceiling, and still charges the top price there', () => {
    expect(bandFor(512 * GIB + 1)).toBeNull();
    expect(cloudChargeCentavos(512 * GIB + 1)).toBe(79900);
    expect(cloudChargeCentavos(9999 * GIB)).toBe(79900);
  });

  it('bills a vault that shrank at the smaller band next time', () => {
    expect(cloudChargeCentavos(200 * GIB)).toBe(79900);
    expect(cloudChargeCentavos(100 * GIB)).toBe(24900);
    expect(cloudChargeCentavos(1 * GIB)).toBe(9900);
  });

  /** Bands must ascend in both size and price, or `bandFor`'s first-fit picks the wrong one. */
  it('ascends in size and in price', () => {
    const sizes = CLOUD_BANDS.map((b) => b.maxBytes);
    const prices = CLOUD_BANDS.map((b) => b.pricePhp);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it('keeps the price fields agreeing with each other', () => {
    for (const band of CLOUD_BANDS) expect(band.priceCentavos).toBe(band.pricePhp * 100);
  });

  /**
   * Every band must cost less to serve than it brings in, at the TOP of the band where the
   * subscriber is most expensive. The rate is the Autoclass blended figure a backup actually
   * attracts -- cold by nature, so mostly Coldline -- plus restore egress. If a band ever fails
   * this, it is being sold at a loss and the table is wrong, not the test.
   */
  it('earns more than it costs at the top of every band', () => {
    const PER_GB_MONTH = 0.0132;
    const FX = 0.01592;
    const netUsd = (php: number) => (php - (php * 0.035 + 15)) * FX;
    for (const band of CLOUD_BANDS) {
      const cost = (band.maxBytes / GIB) * PER_GB_MONTH;
      const net = netUsd(band.pricePhp);
      expect(net).toBeGreaterThan(cost);
      // And not merely break-even: a third of the revenue has to survive the storage bill.
      expect((net - cost) / net).toBeGreaterThan(0.33);
    }
  });

  /** The ceiling is the top band, so the two can never drift apart. */
  it('takes the ceiling from the top band', () => {
    expect(CLOUD_TIER.maxBytes).toBe(CLOUD_BANDS[CLOUD_BANDS.length - 1]?.maxBytes);
  });
});

describe('vaultGate', () => {
  const free = { cloudActive: false, enforced: true, storedBytes: 0 };
  const paid = { cloudActive: true, enforced: true, storedBytes: 0 };

  it('allows video on the free tier, counted as one item like a photo', () => {
    expect(vaultGate({ ...free, itemCount: 49, bytes: 5_000_000 })).toEqual({ allowed: true });
  });

  it('refuses a 51st item whatever it holds', () => {
    expect(vaultGate({ ...free, itemCount: 50, bytes: 1 })).toEqual({
      allowed: false,
      reason: 'itemLimit',
    });
  });

  it('refuses an oversized item on the free tier', () => {
    expect(vaultGate({ ...free, itemCount: 0, bytes: MAX_ITEM_BYTES + 1 })).toEqual({
      allowed: false,
      reason: 'fileSize',
    });
  });

  // The size cap is about the device, not the plan, so paying does not lift it.
  it('refuses an oversized item with Cloud active too', () => {
    expect(
      vaultGate({ ...paid, itemCount: 0, bytes: MAX_ITEM_BYTES + 1 }),
    ).toEqual({ allowed: false, reason: 'fileSize' });
  });

  it('lifts the item limit with Cloud, never with anything else', () => {
    expect(vaultGate({ ...paid, itemCount: 999, bytes: 1 })).toEqual({
      allowed: true,
    });
  });

  /**
   * Cloud lifts the ITEM count and replaces it with a byte ceiling. "Unlimited" was the whole
   * cost problem: ₱99 nets $1.54 a month and a subscriber stops paying for themselves somewhere
   * near 57 GB, while the product's own limits allowed 1,953.
   */
  it('holds Cloud to a byte ceiling instead of no ceiling at all', () => {
    expect(vaultGate({ ...paid, itemCount: 999, bytes: 1, storedBytes: 1 })).toEqual({
      allowed: true,
    });
    expect(
      vaultGate({ ...paid, itemCount: 999, bytes: 1, storedBytes: CLOUD_TIER.maxBytes }),
    ).toEqual({ allowed: false, reason: 'cloudStorageLimit' });
  });

  /** Measured against the total the item WOULD make, so the cap is never crossed. */
  it('refuses the item that would cross the ceiling, and allows the one that just fits', () => {
    const almost = CLOUD_TIER.maxBytes - 1000;
    expect(vaultGate({ ...paid, itemCount: 1, bytes: 1000, storedBytes: almost })).toEqual({
      allowed: true,
    });
    expect(vaultGate({ ...paid, itemCount: 1, bytes: 1001, storedBytes: almost })).toEqual({
      allowed: false,
      reason: 'cloudStorageLimit',
    });
  });

  /**
   * The ceiling bounds ADDITIONS and nothing else. A vault already over it -- restored from a
   * bigger device, or filled before the cap existed -- keeps everything and stays readable; it
   * simply stops taking more. Nothing in this file may ever delete to make room.
   */
  it('leaves a vault that is already over the ceiling alone', () => {
    const over = CLOUD_TIER.maxBytes * 3;
    expect(vaultGate({ ...paid, itemCount: 9999, bytes: 1, storedBytes: over })).toEqual({
      allowed: false,
      reason: 'cloudStorageLimit',
    });
    // Still nothing about removal: the decision is a refusal to add, and that is all it is.
    expect(Object.keys(vaultGate({ ...paid, itemCount: 9999, bytes: 1, storedBytes: over }))).toEqual([
      'allowed',
      'reason',
    ]);
  });

  /** The free tier is unaffected: it is still counted in items, not bytes. */
  it('does not apply the byte ceiling to the free tier', () => {
    expect(
      vaultGate({ ...free, itemCount: 1, bytes: 1, storedBytes: CLOUD_TIER.maxBytes * 10 }),
    ).toEqual({ allowed: true });
  });

  /** A build with no billing gates nothing, ceiling included. */
  it('does not apply the byte ceiling in a build that cannot sell', () => {
    expect(
      vaultGate({
        cloudActive: true,
        enforced: false,
        itemCount: 1,
        bytes: 1,
        storedBytes: CLOUD_TIER.maxBytes * 10,
      }),
    ).toEqual({ allowed: true });
  });

  it('gates nothing in a build that cannot sell', () => {
    expect(
      vaultGate({ cloudActive: false, enforced: false, storedBytes: 0, itemCount: 999, bytes: MAX_ITEM_BYTES + 1 }),
    ).toEqual({ allowed: true });
  });

  it('skips the size check when the size is not yet known', () => {
    expect(vaultGate({ ...free, itemCount: 0, bytes: 0 })).toEqual({ allowed: true });
  });

  it('blocks the item that would exceed the free cap and nothing before it', () => {
    expect(vaultGate({ ...free, itemCount: FREE_TIER.maxItems - 1, bytes: 1 })).toEqual({
      allowed: true,
    });
    expect(vaultGate({ ...free, itemCount: FREE_TIER.maxItems, bytes: 1 })).toEqual({
      allowed: false,
      reason: 'itemLimit',
    });
  });
});

describe('BILLING_PATHS', () => {
  it('files entitlements under the owner', () => {
    expect(BILLING_PATHS.entitlements('u1')).toBe('users/u1/billing/entitlements');
  });
});
