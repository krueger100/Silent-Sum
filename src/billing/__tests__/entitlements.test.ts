import {
  BILLING_PATHS,
  FREE_ENTITLEMENTS,
  FREE_TIER,
  MAX_ITEM_BYTES,
  cloudActive,
  deriveCloudState,
  entitlementsToJson,
  parseEntitlements,
  vaultGate,
} from '@/billing/entitlements';
import { PRODUCTS } from '@/billing/products';

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
      tagline: 'An unlimited vault and encrypted cloud backup.',
      priceCentavos: 9900,
      kind: 'monthly',
    });
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

describe('vaultGate', () => {
  const free = { cloudActive: false, enforced: true };

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
      vaultGate({ cloudActive: true, enforced: true, itemCount: 0, bytes: MAX_ITEM_BYTES + 1 }),
    ).toEqual({ allowed: false, reason: 'fileSize' });
  });

  it('lifts the item limit with Cloud, never with anything else', () => {
    expect(vaultGate({ cloudActive: true, enforced: true, itemCount: 999, bytes: 1 })).toEqual({
      allowed: true,
    });
  });

  it('gates nothing in a build that cannot sell', () => {
    expect(
      vaultGate({ cloudActive: false, enforced: false, itemCount: 999, bytes: MAX_ITEM_BYTES + 1 }),
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
