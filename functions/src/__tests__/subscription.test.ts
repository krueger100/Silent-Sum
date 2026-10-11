/**
 * `startCloudSubscription` and `rerateCloudSubscription` against a PayMongo built to the
 * documented contract.
 *
 * The fake answers below are the shapes PayMongo's own reference describes -- a plan and a
 * customer answer with an `id`, a subscription answer with a NESTED `plan` and a
 * `latest_invoice.payment_intent`, an attach answer with `next_action.redirect.url`. The point
 * of asserting the request bodies as well as the outcomes is that this integration cannot be
 * exercised against the live API yet (Subscriptions are not enabled on the account), so the
 * contract itself is what is under test.
 */
import { CLOUD_BANDS, CLOUD_CEILING_BYTES } from '../bands';
import { readConfig } from '../config';
import { BillingFailure } from '../errors';
import { PayMongoApiError } from '../paymongo/client';
import type { StorageMeter } from '../storageMeter';
import { InMemoryBillingStore } from '../store';
import {
  rerateCloudSubscription,
  startCloudSubscription,
  type SubscriptionDeps,
  type SubscriptionPayMongo,
} from '../subscription';

const NOW = Date.UTC(2026, 9, 11, 9, 0, 0);
const GIB = 1024 * 1024 * 1024;
const AUTH_URL = 'https://auth.paymongo.test/pi_1';

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

interface Rig {
  readonly deps: SubscriptionDeps;
  readonly store: InMemoryBillingStore;
  readonly calls: Call[];
  /** Named so a spec can make one call fail without rewriting the whole fake. */
  readonly fail: (name: string, error: unknown) => void;
}

function rig(
  options: {
    readonly storedBytes?: number | null;
    readonly email?: string | null;
    readonly planIdFor?: (amount: number) => string;
    readonly subscriptionPlanId?: string;
    readonly subscriptionStatus?: string;
    readonly paymentIntentId?: string | null;
    readonly redirectUrl?: string | null;
    readonly livemode?: boolean;
  } = {},
): Rig {
  const store = new InMemoryBillingStore(() => NOW);
  const calls: Call[] = [];
  const failures = new Map<string, unknown>();
  const planIdFor = options.planIdFor ?? ((amount: number) => `plan_${String(amount)}`);

  const record = <T>(name: string, args: readonly unknown[], value: T): T => {
    calls.push({ name, args });
    const failure = failures.get(name);
    if (failure !== undefined) throw failure;
    return value;
  };

  const paymongo: SubscriptionPayMongo = {
    createPlan: async (input) => record('createPlan', [input], planIdFor(input.amountCentavos)),
    createCustomer: async (input) => record('createCustomer', [input], 'cus_1'),
    createSubscription: async (input) =>
      record('createSubscription', [input], {
        id: 'sub_1',
        type: 'subscription',
        attributes: {
          status: options.subscriptionStatus ?? 'incomplete',
          customer_id: input.customerId,
          plan: { id: options.subscriptionPlanId ?? input.planId },
          latest_invoice:
            options.paymentIntentId === null
              ? { id: 'in_1', status: 'open' }
              : {
                  id: 'in_1',
                  status: 'open',
                  payment_intent: {
                    id: options.paymentIntentId ?? 'pi_1',
                    status: 'awaiting_payment_method',
                  },
                },
        },
      }),
    retrieveSubscription: async (id) =>
      record('retrieveSubscription', [id], {
        id,
        type: 'subscription',
        attributes: {
          status: options.subscriptionStatus ?? 'active',
          customer_id: 'cus_1',
          plan: { id: options.subscriptionPlanId ?? 'plan_9900' },
        },
      }),
    createWalletMethod: async (type) => record('createWalletMethod', [type], 'pm_1'),
    attachPaymentIntent: async (input) =>
      record('attachPaymentIntent', [input], {
        id: input.paymentIntentId,
        type: 'payment_intent',
        attributes: {
          status: 'awaiting_next_action',
          next_action:
            options.redirectUrl === null
              ? {}
              : { type: 'redirect', redirect: { url: options.redirectUrl ?? AUTH_URL } },
        },
      }),
    changeSubscriptionPlan: async (id, planId) =>
      record('changeSubscriptionPlan', [id, planId], undefined),
  };

  const meter: StorageMeter = {
    measure: async (uid) =>
      record('measure', [uid], options.storedBytes === undefined ? 0 : options.storedBytes),
  };

  const deps: SubscriptionDeps = {
    store,
    paymongo,
    meter,
    config: readConfig(options.livemode === true ? { PAYMONGO_LIVEMODE: 'true' } : {}),
    now: () => NOW,
    returnUrl: (outcome) => `https://return.test/?outcome=${outcome}`,
    accountEmail: async (uid) =>
      record('accountEmail', [uid], options.email === undefined ? 'u1@example.test' : options.email),
  };

  return {
    deps,
    store,
    calls,
    fail: (name, error) => {
      failures.set(name, error);
    },
  };
}

const names = (calls: readonly Call[]): string[] => calls.map((c) => c.name);
const bodyOf = (calls: readonly Call[], name: string): unknown =>
  calls.find((c) => c.name === name)?.args[0];

describe('startCloudSubscription', () => {
  it('creates plan, customer, subscription, wallet and attach -- in that order', async () => {
    const { deps, calls } = rig({ storedBytes: 10 * GIB });

    const start = await startCloudSubscription(deps, { uid: 'u1' });

    expect(start).toEqual({
      subscriptionId: 'sub_1',
      authorizeUrl: AUTH_URL,
      priceCentavos: 9900,
      bandLabel: '64 GB',
      storedBytes: 10 * GIB,
    });
    // Measured before priced, and the subscription made before anything asks for money.
    expect(names(calls)).toEqual([
      'measure',
      'accountEmail',
      'createPlan',
      'createCustomer',
      'createSubscription',
      'createWalletMethod',
      'attachPaymentIntent',
    ]);
  });

  it('sends the bodies PayMongo documents, and nothing else', async () => {
    const { deps, calls } = rig({ storedBytes: 10 * GIB });
    await startCloudSubscription(deps, { uid: 'u1' });

    expect(bodyOf(calls, 'createPlan')).toEqual({
      name: 'SilentSum Cloud 64 GB',
      description: 'Encrypted backup, restore, support chat and cloud services.',
      amountCentavos: 9900,
      currency: 'PHP',
      interval: 'monthly',
      intervalCount: 1,
      metadata: { band: '64 GB' },
    });
    // No phone, and no name the user gave us: PayMongo requires a name, SilentSum does not know
    // one, and a vault app must not start collecting mobile numbers to sell storage.
    expect(bodyOf(calls, 'createCustomer')).toEqual({
      firstName: 'SilentSum',
      lastName: 'Subscriber',
      email: 'u1@example.test',
      metadata: { uid: 'u1' },
    });
    expect(bodyOf(calls, 'createSubscription')).toEqual({
      customerId: 'cus_1',
      planId: 'plan_9900',
    });
    expect(bodyOf(calls, 'attachPaymentIntent')).toEqual({
      paymentIntentId: 'pi_1',
      paymentMethodId: 'pm_1',
      returnUrl: 'https://return.test/?outcome=success',
    });
  });

  it('asks for a Maya wallet and never a card', async () => {
    // The union has one member, so this is really a statement about intent: a card subscription
    // would need `card_number`/`cvc` through this process, which is PCI scope SilentSum declines.
    const { deps, calls } = rig({ storedBytes: 1 });
    await startCloudSubscription(deps, { uid: 'u1' });
    expect(calls.find((c) => c.name === 'createWalletMethod')?.args).toEqual(['paymaya']);
  });

  it.each([
    [1, 9900, '64 GB'],
    [64 * GIB, 9900, '64 GB'],
    [64 * GIB + 1, 24900, '160 GB'],
    [160 * GIB, 24900, '160 GB'],
    [160 * GIB + 1, 79900, '512 GB'],
    [512 * GIB, 79900, '512 GB'],
  ])('prices %p bytes at %p centavos (%s)', async (bytes, centavos, label) => {
    const { deps } = rig({ storedBytes: bytes });
    const start = await startCloudSubscription(deps, { uid: 'u1' });
    expect(start.priceCentavos).toBe(centavos);
    expect(start.bandLabel).toBe(label);
  });

  it('bills a vault past the ceiling at the top band, not at nothing', async () => {
    const { deps } = rig({ storedBytes: CLOUD_CEILING_BYTES * 2 });
    const start = await startCloudSubscription(deps, { uid: 'u1' });
    expect(start.priceCentavos).toBe(CLOUD_BANDS[CLOUD_BANDS.length - 1]?.priceCentavos);
  });

  it('writes the subscription reference BEFORE asking for money', async () => {
    // PayMongo emits the first invoice's events immediately. A reference written after the
    // attach would leave a window where a paid invoice cannot be matched to an account.
    const { deps, store, fail } = rig({ storedBytes: 1 });
    fail('createWalletMethod', new PayMongoApiError(400, 'x', 'no'));

    await expect(startCloudSubscription(deps, { uid: 'u1' })).rejects.toBeInstanceOf(BillingFailure);

    expect(await store.getRef('sub_1')).toEqual({
      kind: 'subscription',
      id: 'sub_1',
      uid: 'u1',
      createdAt: NOW,
    });
  });

  it('records the customer both ways, so a webhook naming only a customer finds the account', async () => {
    const { deps, store } = rig({ storedBytes: 1 });
    await startCloudSubscription(deps, { uid: 'u1' });
    expect(await store.getCustomerId('u1')).toBe('cus_1');
    expect(await store.getRef('cus_1')).toMatchObject({ kind: 'customer', uid: 'u1' });
  });

  it('reuses the cached plan rather than creating a second one at the same price', async () => {
    const { deps, calls, store } = rig({ storedBytes: 1 });
    await startCloudSubscription(deps, { uid: 'u1' });
    expect(names(calls).filter((n) => n === 'createPlan')).toHaveLength(1);

    // A second account on the same band must not make another plan.
    await store.updateEntitlements('u1', () => null);
    const second = rig({ storedBytes: 1 });
    await second.deps.store.putPlanId('cloud_test_php_9900', 'plan_9900', NOW);
    await startCloudSubscription(second.deps, { uid: 'u2' });
    expect(names(second.calls)).not.toContain('createPlan');
  });

  it('keys the plan cache by mode, so a test plan is never handed to a live key', async () => {
    const live = rig({ storedBytes: 1, livemode: true });
    await live.deps.store.putPlanId('cloud_test_php_9900', 'plan_from_test_mode', NOW);
    await startCloudSubscription(live.deps, { uid: 'u1' });
    expect(names(live.calls)).toContain('createPlan');
    expect(await live.deps.store.getPlanId('cloud_live_php_9900')).toBe('plan_9900');
  });

  it('reuses the account PayMongo customer when one already exists', async () => {
    const { deps, calls, store } = rig({ storedBytes: 1 });
    await store.putCustomerId('u1', 'cus_existing', NOW);

    await startCloudSubscription(deps, { uid: 'u1' });

    expect(names(calls)).not.toContain('createCustomer');
    expect(bodyOf(calls, 'createSubscription')).toEqual({
      customerId: 'cus_existing',
      planId: 'plan_9900',
    });
  });

  it('refuses when Cloud already renews on the account', async () => {
    const { deps, calls, store } = rig({ storedBytes: 1 });
    await store.updateEntitlements('u1', (current) => ({
      ...current,
      cloud: {
        status: 'active',
        accessUntil: NOW + 86_400_000,
        currentPeriodStart: NOW,
        currentPeriodEnd: NOW + 86_400_000,
        cancelAtPeriodEnd: false,
        source: 'subscription',
        subscriptionId: 'sub_old',
      },
    }));

    await expect(startCloudSubscription(deps, { uid: 'u1' })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'already-subscribed' },
    });
    expect(calls).toHaveLength(0);
  });

  it('lets a CANCELLED subscriber start a new one', async () => {
    // Cancelling is the only way back to the Renew button; it has to lead somewhere.
    const { deps, store } = rig({ storedBytes: 1 });
    await store.updateEntitlements('u1', (current) => ({
      ...current,
      cloud: {
        status: 'cancelled',
        accessUntil: NOW + 86_400_000,
        currentPeriodStart: NOW,
        currentPeriodEnd: NOW + 86_400_000,
        cancelAtPeriodEnd: true,
        source: 'subscription',
        subscriptionId: 'sub_old',
      },
    }));

    await expect(startCloudSubscription(deps, { uid: 'u1' })).resolves.toMatchObject({
      subscriptionId: 'sub_1',
    });
  });

  it('refuses when storage cannot be measured, rather than guessing a band', async () => {
    const { deps, calls } = rig({ storedBytes: null });
    await expect(startCloudSubscription(deps, { uid: 'u1' })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'storage-unmeasured' },
    });
    expect(names(calls)).toEqual(['measure']);
  });

  it('refuses when the account has no e-mail, which PayMongo requires on a customer', async () => {
    const { deps } = rig({ storedBytes: 1, email: null });
    await expect(startCloudSubscription(deps, { uid: 'u1' })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'no-email' },
    });
  });

  it('fails loudly when the first invoice carries no payment intent', async () => {
    const { deps } = rig({ storedBytes: 1, paymentIntentId: null });
    await expect(startCloudSubscription(deps, { uid: 'u1' })).rejects.toMatchObject({
      code: 'internal',
      details: { reason: 'no-first-invoice' },
    });
  });

  it('fails loudly when the attach answer has no page to authorise on', async () => {
    const { deps } = rig({ storedBytes: 1, redirectUrl: null });
    await expect(startCloudSubscription(deps, { uid: 'u1' })).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('reports PayMongo being unreachable as unavailable, and a refusal as internal', async () => {
    const down = rig({ storedBytes: 1 });
    down.fail('createPlan', new PayMongoApiError(0, null, 'unreachable'));
    await expect(startCloudSubscription(down.deps, { uid: 'u1' })).rejects.toMatchObject({
      code: 'unavailable',
    });

    const refused = rig({ storedBytes: 1 });
    refused.fail('createPlan', new PayMongoApiError(400, 'parameter_invalid', 'no'));
    await expect(startCloudSubscription(refused.deps, { uid: 'u1' })).rejects.toMatchObject({
      code: 'internal',
    });
  });
});

describe('rerateCloudSubscription', () => {
  it('leaves a subscription on its band when the vault has not changed band', async () => {
    const { deps, calls } = rig({ storedBytes: 10 * GIB, subscriptionPlanId: 'plan_9900' });
    await expect(
      rerateCloudSubscription(deps, { uid: 'u1', subscriptionId: 'sub_1' }),
    ).resolves.toBe('unchanged');
    expect(names(calls)).not.toContain('changeSubscriptionPlan');
  });

  it('moves a grown vault up a band', async () => {
    const { deps, calls } = rig({ storedBytes: 300 * GIB, subscriptionPlanId: 'plan_9900' });
    await expect(
      rerateCloudSubscription(deps, { uid: 'u1', subscriptionId: 'sub_1' }),
    ).resolves.toBe('moved');
    expect(calls.find((c) => c.name === 'changeSubscriptionPlan')?.args).toEqual([
      'sub_1',
      'plan_79900',
    ]);
  });

  it('moves a shrunken vault back DOWN a band', async () => {
    // The price follows what is stored, both ways. A vault that empties must get cheaper
    // without anybody having to ask, or the band is a ratchet.
    const { deps, calls } = rig({ storedBytes: 2 * GIB, subscriptionPlanId: 'plan_79900' });
    await expect(
      rerateCloudSubscription(deps, { uid: 'u1', subscriptionId: 'sub_1' }),
    ).resolves.toBe('moved');
    expect(calls.find((c) => c.name === 'changeSubscriptionPlan')?.args).toEqual([
      'sub_1',
      'plan_9900',
    ]);
  });

  it('leaves the price alone when storage cannot be measured', async () => {
    const { deps, calls } = rig({ storedBytes: null });
    await expect(
      rerateCloudSubscription(deps, { uid: 'u1', subscriptionId: 'sub_1' }),
    ).resolves.toBe('unmeasured');
    expect(names(calls)).toEqual(['measure']);
  });

  it.each(['cancelled', 'incomplete_cancelled'])(
    'does not re-price a %s subscription: there is no next cycle',
    async (status) => {
      const { deps, calls } = rig({ storedBytes: 300 * GIB, subscriptionStatus: status });
      await expect(
        rerateCloudSubscription(deps, { uid: 'u1', subscriptionId: 'sub_1' }),
      ).resolves.toBe('not-subscribed');
      expect(names(calls)).not.toContain('changeSubscriptionPlan');
    },
  );
});
