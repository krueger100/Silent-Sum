import { createCheckout, type CreateCheckoutDeps } from '../checkout';
import { readConfig } from '../config';
import { defaultEntitlements, grantPro } from '../entitlements';
import { BillingFailure } from '../errors';
import { PayMongoApiError } from '../paymongo/client';
import type { CreateCheckoutSessionInput, CreatedCheckoutSession } from '../paymongo/client';
import { InMemoryBillingStore } from '../store';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function rig(
  answer: (input: CreateCheckoutSessionInput) => Promise<CreatedCheckoutSession> = async () => ({
    id: 'cs_new',
    checkoutUrl: 'https://checkout.paymongo.com/cs_new',
    resource: {},
  }),
): { deps: CreateCheckoutDeps; store: InMemoryBillingStore; calls: CreateCheckoutSessionInput[] } {
  const store = new InMemoryBillingStore(() => NOW);
  const calls: CreateCheckoutSessionInput[] = [];
  const deps: CreateCheckoutDeps = {
    store,
    paymongo: {
      createCheckoutSession: async (input) => {
        calls.push(input);
        return answer(input);
      },
    },
    config: readConfig({}),
    now: () => NOW,
    newRef: () => 'ref-0001',
    returnUrl: (outcome) => `https://example.test/return?outcome=${outcome}`,
  };
  return { deps, store, calls };
}

async function failureOf(action: () => Promise<unknown>): Promise<BillingFailure> {
  try {
    await action();
  } catch (error) {
    if (error instanceof BillingFailure) return error;
    throw error;
  }
  throw new Error('expected a BillingFailure');
}

describe('createCheckout', () => {
  it('creates a hosted session for Pro at the server price and remembers who it is for', async () => {
    const { deps, store, calls } = rig();

    const result = await createCheckout(deps, { uid: 'u1', product: 'pro' });

    expect(result).toEqual({
      checkoutId: 'cs_new',
      checkoutUrl: 'https://checkout.paymongo.com/cs_new',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      lineItem: {
        name: 'SilentSum Pro',
        description: 'Pay once. Keep Pro forever.',
        amountCentavos: 29900,
        currency: 'PHP',
      },
      paymentMethodTypes: ['gcash', 'paymaya', 'card', 'grab_pay', 'qrph'],
      successUrl: 'https://example.test/return?outcome=success',
      cancelUrl: 'https://example.test/return?outcome=cancel',
      description: 'SilentSum Pro',
      referenceNumber: 'ref-0001',
      metadata: { uid: 'u1', product: 'pro', ref: 'ref-0001' },
    });
    expect(await store.getRef('cs_new')).toEqual({
      kind: 'checkout',
      id: 'cs_new',
      uid: 'u1',
      product: 'pro',
      ref: 'ref-0001',
      amountCentavos: 29900,
      currency: 'PHP',
      status: 'open',
      createdAt: NOW,
      paidAt: null,
      paymentId: null,
    });
  });

  it('prices Cloud from the config and sells it again to an account that already has it', async () => {
    const { deps, store, calls } = rig();
    await store.updateEntitlements('u1', (current) => ({
      ...current,
      cloud: { ...current.cloud, status: 'active', accessUntil: NOW + 1, source: 'term' },
    }));

    await createCheckout(deps, { uid: 'u1', product: 'cloud' });

    expect(calls[0]?.lineItem).toMatchObject({ name: 'SilentSum Cloud', amountCentavos: 9900 });
    expect(calls[0]?.lineItem.description).toBe(
      'Encrypted backup, restore, support chat and cloud services.',
    );
  });

  it('refuses a product it does not sell, before talking to PayMongo', async () => {
    const { deps, calls } = rig();
    const failure = await failureOf(() => createCheckout(deps, { uid: 'u1', product: 'gold' }));
    expect(failure.code).toBe('invalid-argument');
    expect(calls).toHaveLength(0);
  });

  it('refuses to sell Pro to an account that owns it', async () => {
    const { deps, store, calls } = rig();
    await store.updateEntitlements(
      'u1',
      (current) => grantPro(current, { paymentId: 'pay_0', now: NOW }).next,
    );

    const failure = await failureOf(() => createCheckout(deps, { uid: 'u1', product: 'pro' }));

    expect(failure.code).toBe('failed-precondition');
    expect(failure.details).toEqual({ reason: 'already-owned' });
    expect(calls).toHaveLength(0);
  });

  it('reports PayMongo refusing the request without leaking its detail', async () => {
    const { deps } = rig(async () => {
      throw new PayMongoApiError(400, 'parameter_invalid', 'amount must be at least 100');
    });
    const failure = await failureOf(() => createCheckout(deps, { uid: 'u1', product: 'pro' }));
    expect(failure.code).toBe('internal');
    expect(failure.message).not.toContain('amount must be');
  });

  it('reports PayMongo being down as unavailable', async () => {
    const { deps } = rig(async () => {
      throw new PayMongoApiError(0, null, 'PayMongo could not be reached');
    });
    expect((await failureOf(() => createCheckout(deps, { uid: 'u1', product: 'pro' }))).code).toBe(
      'unavailable',
    );
    const down = rig(async () => {
      throw new PayMongoApiError(503, null, 'Service Unavailable');
    });
    expect(
      (await failureOf(() => createCheckout(down.deps, { uid: 'u1', product: 'pro' }))).code,
    ).toBe('unavailable');
  });

  it('does not touch the entitlements just by starting a checkout', async () => {
    const { deps, store } = rig();
    await createCheckout(deps, { uid: 'u1', product: 'pro' });
    expect(await store.getEntitlements('u1')).toBeNull();
    expect(defaultEntitlements(NOW).pro).toBe(false);
  });
});
