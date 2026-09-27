import { defaultEntitlements, extendCloudTerm, grantPro } from '../entitlements';
import { InMemoryBillingStore, type CheckoutRef, type PaymentRecord } from '../store';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function checkoutRef(overrides: Partial<CheckoutRef> = {}): CheckoutRef {
  return {
    kind: 'checkout',
    id: 'cs_1',
    uid: 'u1',
    product: 'pro',
    ref: 'ref-1',
    amountCentavos: 29900,
    currency: 'PHP',
    status: 'open',
    createdAt: NOW,
    paidAt: null,
    paymentId: null,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    paymentId: 'pay_1',
    uid: 'u1',
    product: 'pro',
    amountCentavos: 29900,
    currency: 'PHP',
    checkoutSessionId: 'cs_1',
    eventId: 'evt_1',
    source: 'webhook',
    paidAt: NOW,
    appliedAt: NOW,
    outcome: 'pro_granted',
    ...overrides,
  };
}

describe('InMemoryBillingStore', () => {
  it('reports no entitlements for an account that has none', async () => {
    const store = new InMemoryBillingStore();
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('records each webhook event once', async () => {
    const store = new InMemoryBillingStore();
    const event = { id: 'evt_1', type: 'payment.paid', livemode: false, receivedAt: NOW };
    expect(await store.beginEvent(event)).toBe('new');
    expect(await store.beginEvent(event)).toBe('duplicate');
    await store.finishEvent('evt_1', 'applied:1', NOW + 5);
    expect(store.events.get('evt_1')).toMatchObject({ outcome: 'applied:1', processedAt: NOW + 5 });
  });

  it('applies a payment exactly once, however many times it is presented', async () => {
    const store = new InMemoryBillingStore();
    const mutate = (current: ReturnType<typeof defaultEntitlements>) =>
      grantPro(current, { paymentId: 'pay_1', now: NOW }).next;

    expect(await store.applyPayment({ uid: 'u1', record: payment(), mutate })).toBe('applied');
    expect((await store.getEntitlements('u1'))?.pro).toBe(true);
    expect(store.payments.get('pay_1')).toMatchObject({ outcome: 'pro_granted' });

    // A retry, a second event type for the same payment, or the sync path: all the same payment.
    const again = await store.applyPayment({
      uid: 'u1',
      record: payment({ eventId: 'evt_2', source: 'sync' }),
      mutate: () => {
        throw new Error('must not be consulted for a payment already in the ledger');
      },
    });
    expect(again).toBe('duplicate');
    expect(store.payments.get('pay_1')?.eventId).toBe('evt_1');
  });

  it('records a payment that changes nothing, so it is not re-applied later either', async () => {
    const store = new InMemoryBillingStore();
    await store.applyPayment({
      uid: 'u1',
      record: payment(),
      mutate: (current) => grantPro(current, { paymentId: 'pay_1', now: NOW }).next,
    });
    const outcome = await store.applyPayment({
      uid: 'u1',
      record: payment({ paymentId: 'pay_2', outcome: 'pro_already' }),
      mutate: (current) => {
        const { next, changed } = grantPro(current, { paymentId: 'pay_2', now: NOW + 1 });
        return changed ? next : null;
      },
    });
    expect(outcome).toBe('unchanged');
    expect((await store.getEntitlements('u1'))?.proPaymentId).toBe('pay_1');
    expect(store.payments.has('pay_2')).toBe(true);
  });

  it('keeps references by PayMongo id and patches them in place', async () => {
    const store = new InMemoryBillingStore();
    await store.putRef(checkoutRef());
    expect(await store.getRef('cs_1')).toEqual(checkoutRef());
    await store.updateRef('cs_1', { status: 'paid', paidAt: NOW + 1, paymentId: 'pay_1' });
    expect(await store.getRef('cs_1')).toMatchObject({
      status: 'paid',
      paidAt: NOW + 1,
      paymentId: 'pay_1',
    });
    expect(await store.getRef('cs_missing')).toBeNull();
  });

  it('updates entitlements through a mutation and hands back the result', async () => {
    const store = new InMemoryBillingStore();
    const result = await store.updateEntitlements('u1', (current) =>
      extendCloudTerm(current, { now: NOW, termDays: 30 }),
    );
    expect(result.cloud.status).toBe('active');
    expect(await store.getEntitlements('u1')).toEqual(result);
    // A mutation that returns null leaves the document alone.
    const same = await store.updateEntitlements('u1', () => null);
    expect(same).toEqual(result);
  });

  it('gives mutations the free tier when nothing is stored yet, stamped with the time', async () => {
    const store = new InMemoryBillingStore(() => NOW);
    const seen: unknown[] = [];
    await store.updateEntitlements('u1', (current) => {
      seen.push(current);
      return null;
    });
    expect(seen).toEqual([defaultEntitlements(NOW)]);
  });
});
