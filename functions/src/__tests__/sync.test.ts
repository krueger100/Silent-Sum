import { readConfig } from '../config';
import { BillingFailure } from '../errors';
import { PayMongoApiError } from '../paymongo/client';
import { InMemoryBillingStore, type CheckoutRef } from '../store';
import { syncCheckout, type SyncDeps } from '../sync';

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
    createdAt: NOW - 60_000,
    paidAt: null,
    paymentId: null,
    ...overrides,
  };
}

function session(input: {
  status?: string;
  payments?: { id: string; status: string; amount?: number }[];
}) {
  return {
    id: 'cs_1',
    type: 'checkout_session',
    attributes: {
      status: input.status ?? 'active',
      metadata: { uid: 'u1', product: 'pro', ref: 'ref-1' },
      payments: (input.payments ?? []).map((p) => ({
        id: p.id,
        type: 'payment',
        attributes: { status: p.status, amount: p.amount ?? 29900, currency: 'PHP' },
      })),
    },
  };
}

function rig(answer: () => Promise<Record<string, unknown>>): {
  deps: SyncDeps;
  store: InMemoryBillingStore;
  calls: string[];
} {
  const store = new InMemoryBillingStore(() => NOW);
  const calls: string[] = [];
  const deps: SyncDeps = {
    store,
    paymongo: {
      retrieveCheckoutSession: async (id) => {
        calls.push(id);
        return answer();
      },
    },
    config: readConfig({}),
    now: () => NOW,
  };
  return { deps, store, calls };
}

describe('syncCheckout', () => {
  it('applies a paid session exactly as the webhook would', async () => {
    const { deps, store, calls } = rig(async () =>
      session({ payments: [{ id: 'pay_1', status: 'paid' }] }),
    );
    await store.putRef(checkoutRef());

    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).toBe('paid');

    expect(calls).toEqual(['cs_1']);
    expect((await store.getEntitlements('u1'))?.pro).toBe(true);
    expect(store.payments.get('pay_1')).toMatchObject({
      source: 'sync',
      eventId: null,
      outcome: 'pro_granted',
    });
    expect(await store.getRef('cs_1')).toMatchObject({ status: 'paid', paymentId: 'pay_1' });
  });

  it('is idempotent with the webhook: a payment the webhook applied is not applied again', async () => {
    const { deps, store } = rig(async () =>
      session({ payments: [{ id: 'pay_1', status: 'paid' }] }),
    );
    await store.putRef(checkoutRef({ status: 'paid', paymentId: 'pay_1', paidAt: NOW }));
    await store.applyPayment({
      uid: 'u1',
      record: {
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
      },
      mutate: (current) => ({ ...current, pro: true, proSince: NOW, proPaymentId: 'pay_1' }),
    });

    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).toBe('paid');
    expect(store.payments.size).toBe(1);
    expect(store.payments.get('pay_1')?.eventId).toBe('evt_1');
  });

  it("answers unknown for a session that is not this account's, without asking PayMongo", async () => {
    const { deps, store, calls } = rig(async () => session({}));
    await store.putRef(checkoutRef({ uid: 'someone-else' }));

    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).toBe('unknown');
    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_nope' })).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('refuses a checkout id that is not a string', async () => {
    const { deps } = rig(async () => session({}));
    await expect(syncCheckout(deps, { uid: 'u1', checkoutId: 42 })).rejects.toBeInstanceOf(
      BillingFailure,
    );
  });

  it('reports pending while nothing has been paid', async () => {
    const { deps, store } = rig(async () => session({}));
    await store.putRef(checkoutRef());
    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).toBe('pending');
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('reports and records an expired session', async () => {
    const { deps, store } = rig(async () => session({ status: 'expired' }));
    await store.putRef(checkoutRef());
    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).toBe('expired');
    expect(await store.getRef('cs_1')).toMatchObject({ status: 'expired' });
  });

  it('reports a failed payment when that is all the session has', async () => {
    const { deps, store } = rig(async () =>
      session({ payments: [{ id: 'pay_f', status: 'failed' }] }),
    );
    await store.putRef(checkoutRef());
    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).toBe('failed');
    expect(await store.getRef('cs_1')).toMatchObject({ status: 'failed' });
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('does not grant for a paid payment of the wrong amount, and says pending', async () => {
    const { deps, store } = rig(async () =>
      session({ payments: [{ id: 'pay_1', status: 'paid', amount: 100 }] }),
    );
    await store.putRef(checkoutRef());
    expect(await syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).toBe('pending');
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('reports PayMongo being unreachable as unavailable', async () => {
    const { deps, store } = rig(async () => {
      throw new PayMongoApiError(0, null, 'PayMongo could not be reached');
    });
    await store.putRef(checkoutRef());
    await expect(syncCheckout(deps, { uid: 'u1', checkoutId: 'cs_1' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
