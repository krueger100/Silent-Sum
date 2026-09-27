import {
  DAY_MS,
  applySubscriptionEvent,
  cancelCloudAtPeriodEnd,
  cloudActive,
  defaultEntitlements,
  extendCloudTerm,
  grantPro,
  type Entitlements,
} from '../entitlements';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const TERM = 30;

describe('defaultEntitlements', () => {
  it('is the free tier', () => {
    const e = defaultEntitlements(NOW);
    expect(e).toEqual({
      v: 1,
      pro: false,
      proSince: null,
      proPaymentId: null,
      cloud: {
        status: 'none',
        accessUntil: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        source: null,
        subscriptionId: null,
      },
      updatedAt: NOW,
    });
    expect(cloudActive(e, NOW)).toBe(false);
  });
});

describe('grantPro', () => {
  it('turns Pro on once, recording when and by which payment', () => {
    const { next, changed } = grantPro(defaultEntitlements(NOW), { paymentId: 'pay_1', now: NOW });
    expect(changed).toBe(true);
    expect(next.pro).toBe(true);
    expect(next.proSince).toBe(NOW);
    expect(next.proPaymentId).toBe('pay_1');
    expect(next.updatedAt).toBe(NOW);
    // Cloud is not consulted and not touched.
    expect(next.cloud).toEqual(defaultEntitlements(NOW).cloud);
  });

  it('is a no-op for an account that already has Pro, keeping the original grant', () => {
    const first = grantPro(defaultEntitlements(NOW), { paymentId: 'pay_1', now: NOW }).next;
    const { next, changed } = grantPro(first, { paymentId: 'pay_2', now: NOW + DAY_MS });
    expect(changed).toBe(false);
    expect(next).toEqual(first);
  });
});

describe('extendCloudTerm', () => {
  it('starts a term from now for an account with no Cloud', () => {
    const e = extendCloudTerm(defaultEntitlements(NOW), { now: NOW, termDays: TERM });
    expect(e.cloud).toEqual({
      status: 'active',
      accessUntil: NOW + TERM * DAY_MS,
      currentPeriodStart: NOW,
      currentPeriodEnd: NOW + TERM * DAY_MS,
      cancelAtPeriodEnd: false,
      source: 'term',
      subscriptionId: null,
    });
    expect(e.updatedAt).toBe(NOW);
    expect(cloudActive(e, NOW)).toBe(true);
    expect(cloudActive(e, NOW + TERM * DAY_MS)).toBe(false);
    expect(e.pro).toBe(false);
  });

  it('adds a term on top of time already paid for', () => {
    const first = extendCloudTerm(defaultEntitlements(NOW), { now: NOW, termDays: TERM });
    const second = extendCloudTerm(first, { now: NOW + 5 * DAY_MS, termDays: TERM });
    expect(second.cloud.accessUntil).toBe(NOW + 2 * TERM * DAY_MS);
    expect(second.cloud.currentPeriodStart).toBe(NOW + TERM * DAY_MS);
    expect(second.cloud.currentPeriodEnd).toBe(NOW + 2 * TERM * DAY_MS);
  });

  it('starts again from now once a term has lapsed, rather than back-dating', () => {
    const first = extendCloudTerm(defaultEntitlements(NOW), { now: NOW, termDays: TERM });
    const later = NOW + 100 * DAY_MS;
    const renewed = extendCloudTerm(first, { now: later, termDays: TERM });
    expect(renewed.cloud.accessUntil).toBe(later + TERM * DAY_MS);
    expect(renewed.cloud.currentPeriodStart).toBe(later);
  });

  it('un-cancels: paying again means the user wants it after all', () => {
    const cancelled = cancelCloudAtPeriodEnd(
      extendCloudTerm(defaultEntitlements(NOW), { now: NOW, termDays: TERM }),
      NOW,
    );
    const renewed = extendCloudTerm(cancelled, { now: NOW + DAY_MS, termDays: TERM });
    expect(renewed.cloud.status).toBe('active');
    expect(renewed.cloud.cancelAtPeriodEnd).toBe(false);
  });

  it('leaves Pro exactly as it was', () => {
    const pro = grantPro(defaultEntitlements(NOW), { paymentId: 'pay_1', now: NOW }).next;
    const e = extendCloudTerm(pro, { now: NOW, termDays: TERM });
    expect(e.pro).toBe(true);
    expect(e.proSince).toBe(NOW);
    expect(e.proPaymentId).toBe('pay_1');
  });
});

describe('cancelCloudAtPeriodEnd', () => {
  it('keeps access to the paid end and marks the intention', () => {
    const active = extendCloudTerm(defaultEntitlements(NOW), { now: NOW, termDays: TERM });
    const e = cancelCloudAtPeriodEnd(active, NOW + DAY_MS);
    expect(e.cloud.status).toBe('cancelled');
    expect(e.cloud.cancelAtPeriodEnd).toBe(true);
    expect(e.cloud.accessUntil).toBe(NOW + TERM * DAY_MS);
    expect(cloudActive(e, NOW + DAY_MS)).toBe(true);
    expect(e.updatedAt).toBe(NOW + DAY_MS);
  });

  it('is harmless for an account with no Cloud', () => {
    const e = cancelCloudAtPeriodEnd(defaultEntitlements(NOW), NOW);
    expect(e.cloud.status).toBe('none');
    expect(e.cloud.cancelAtPeriodEnd).toBe(false);
  });
});

describe('applySubscriptionEvent', () => {
  const PERIOD_END = NOW + 30 * DAY_MS;

  function subscribed(): Entitlements {
    return applySubscriptionEvent(defaultEntitlements(NOW), {
      kind: 'invoice.paid',
      subscriptionId: 'sub_1',
      periodEndMs: PERIOD_END,
      now: NOW,
    });
  }

  it('activates access to the end of the billing period plus the grace on a paid invoice', () => {
    const e = subscribed();
    expect(e.cloud.status).toBe('active');
    expect(e.cloud.source).toBe('subscription');
    expect(e.cloud.subscriptionId).toBe('sub_1');
    expect(e.cloud.currentPeriodEnd).toBe(PERIOD_END);
    expect(e.cloud.accessUntil).toBe(PERIOD_END + 3 * DAY_MS);
    expect(e.cloud.cancelAtPeriodEnd).toBe(false);
  });

  it('assumes a month when the invoice carries no next billing date', () => {
    const e = applySubscriptionEvent(defaultEntitlements(NOW), {
      kind: 'invoice.paid',
      subscriptionId: 'sub_1',
      periodEndMs: null,
      now: NOW,
    });
    expect(e.cloud.currentPeriodEnd).toBe(NOW + 31 * DAY_MS);
    expect(e.cloud.accessUntil).toBe(NOW + 34 * DAY_MS);
  });

  it('marks past due without taking anything away yet', () => {
    const e = applySubscriptionEvent(subscribed(), {
      kind: 'past_due',
      subscriptionId: 'sub_1',
      now: NOW + 31 * DAY_MS,
    });
    expect(e.cloud.status).toBe('past_due');
    expect(e.cloud.accessUntil).toBe(PERIOD_END + 3 * DAY_MS);
    expect(cloudActive(e, NOW + 31 * DAY_MS)).toBe(true);
    expect(cloudActive(e, NOW + 34 * DAY_MS)).toBe(false);
  });

  it('treats a failed invoice payment as past due', () => {
    const e = applySubscriptionEvent(subscribed(), {
      kind: 'invoice.payment_failed',
      subscriptionId: 'sub_1',
      now: NOW + 30 * DAY_MS,
    });
    expect(e.cloud.status).toBe('past_due');
  });

  it('revokes access when the subscription becomes unpaid', () => {
    const at = NOW + 32 * DAY_MS;
    const e = applySubscriptionEvent(subscribed(), {
      kind: 'unpaid',
      subscriptionId: 'sub_1',
      now: at,
    });
    expect(e.cloud.status).toBe('unpaid');
    expect(e.cloud.accessUntil).toBe(at);
    expect(cloudActive(e, at)).toBe(false);
  });

  it('mirrors a cancellation while keeping what was paid for', () => {
    const e = applySubscriptionEvent(subscribed(), {
      kind: 'updated',
      status: 'cancelled',
      subscriptionId: 'sub_1',
      now: NOW + DAY_MS,
    });
    expect(e.cloud.status).toBe('cancelled');
    expect(e.cloud.cancelAtPeriodEnd).toBe(true);
    expect(e.cloud.accessUntil).toBe(PERIOD_END + 3 * DAY_MS);
    expect(cloudActive(e, NOW + DAY_MS)).toBe(true);
  });

  it('mirrors the other statuses PayMongo reports on an update', () => {
    const base = subscribed();
    expect(
      applySubscriptionEvent(base, {
        kind: 'updated',
        status: 'active',
        subscriptionId: 'sub_1',
        now: NOW,
      }).cloud.status,
    ).toBe('active');
    expect(
      applySubscriptionEvent(base, {
        kind: 'updated',
        status: 'incomplete',
        subscriptionId: 'sub_1',
        now: NOW,
      }).cloud.status,
    ).toBe('incomplete');
    const ended = applySubscriptionEvent(base, {
      kind: 'updated',
      status: 'incomplete_cancelled',
      subscriptionId: 'sub_1',
      now: NOW,
    });
    expect(ended.cloud.status).toBe('none');
    expect(cloudActive(ended, NOW)).toBe(false);
    // An update with a status this code does not know changes nothing.
    expect(
      applySubscriptionEvent(base, {
        kind: 'updated',
        status: 'sideways',
        subscriptionId: 'sub_1',
        now: NOW,
      }),
    ).toEqual(base);
  });

  it('never touches Pro', () => {
    const pro = grantPro(defaultEntitlements(NOW), { paymentId: 'pay_1', now: NOW }).next;
    for (const kind of ['invoice.paid', 'past_due', 'unpaid', 'invoice.payment_failed'] as const) {
      const e = applySubscriptionEvent(pro, { kind, subscriptionId: 'sub_1', now: NOW });
      expect(e.pro).toBe(true);
      expect(e.proPaymentId).toBe('pay_1');
    }
  });
});
