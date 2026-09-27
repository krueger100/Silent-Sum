import { createHmac } from 'node:crypto';

import { readConfig } from '../config';
import { DAY_MS, cloudActive } from '../entitlements';
import { InMemoryBillingStore, type CheckoutRef } from '../store';
import { handleWebhook, type WebhookDeps } from '../webhook';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const SECRET = 'whsk-test-secret-value';

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

function checkoutPaidEvent(input: {
  eventId?: string;
  sessionId?: string;
  paymentId?: string;
  amount?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
  livemode?: boolean;
  paymentStatus?: string;
}): Record<string, unknown> {
  return {
    data: {
      id: input.eventId ?? 'evt_1',
      type: 'event',
      attributes: {
        type: 'checkout_session.payment.paid',
        livemode: input.livemode ?? false,
        created_at: Math.floor(NOW / 1000),
        data: {
          id: input.sessionId ?? 'cs_1',
          type: 'checkout_session',
          attributes: {
            status: 'active',
            reference_number: 'ref-1',
            metadata: input.metadata ?? { uid: 'u1', product: 'pro', ref: 'ref-1' },
            payments: [
              {
                id: input.paymentId ?? 'pay_1',
                type: 'payment',
                attributes: {
                  status: input.paymentStatus ?? 'paid',
                  amount: input.amount ?? 29900,
                  currency: input.currency ?? 'PHP',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function subscriptionEvent(input: {
  eventId: string;
  type: string;
  resource: Record<string, unknown>;
  livemode?: boolean;
}): Record<string, unknown> {
  return {
    data: {
      id: input.eventId,
      type: 'event',
      attributes: {
        type: input.type,
        livemode: input.livemode ?? false,
        created_at: Math.floor(NOW / 1000),
        data: input.resource,
      },
    },
  };
}

function signed(body: unknown, options: { secret?: string; t?: number; live?: boolean } = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const t = options.t ?? Math.floor(NOW / 1000);
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(`${String(t)}.${rawBody}`)
    .digest('hex');
  const header =
    options.live === true ? `t=${String(t)},li=${signature}` : `t=${String(t)},te=${signature}`;
  return { rawBody, signatureHeader: header };
}

function rig(options: { livemode?: boolean } = {}): {
  deps: WebhookDeps;
  store: InMemoryBillingStore;
  logs: string[];
} {
  const store = new InMemoryBillingStore(() => NOW);
  const logs: string[] = [];
  const deps: WebhookDeps = {
    store,
    config: readConfig(options.livemode === true ? { PAYMONGO_LIVEMODE: 'true' } : {}),
    webhookSecret: SECRET,
    now: () => NOW,
    log: (message) => {
      logs.push(message);
    },
  };
  return { deps, store, logs };
}

describe('handleWebhook: checkout sessions', () => {
  it('grants Pro for a signed, matching, correctly priced payment', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());

    const response = await handleWebhook(deps, signed(checkoutPaidEvent({})));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: 'applied:1' });
    const entitlements = await store.getEntitlements('u1');
    expect(entitlements?.pro).toBe(true);
    expect(entitlements?.proPaymentId).toBe('pay_1');
    expect(entitlements?.proSince).toBe(NOW);
    expect(cloudActive(entitlements!, NOW)).toBe(false);
    expect(store.payments.get('pay_1')).toMatchObject({
      uid: 'u1',
      product: 'pro',
      amountCentavos: 29900,
      checkoutSessionId: 'cs_1',
      eventId: 'evt_1',
      source: 'webhook',
      outcome: 'pro_granted',
    });
    expect(await store.getRef('cs_1')).toMatchObject({
      status: 'paid',
      paymentId: 'pay_1',
      paidAt: NOW,
    });
    expect(store.events.get('evt_1')).toMatchObject({ outcome: 'applied:1', processedAt: NOW });
  });

  it('extends Cloud by one term for a Cloud payment, and again for the next one', async () => {
    const { deps, store } = rig();
    await store.putRef(
      checkoutRef({ id: 'cs_c1', product: 'cloud', amountCentavos: 9900, ref: 'ref-c1' }),
    );
    await store.putRef(
      checkoutRef({ id: 'cs_c2', product: 'cloud', amountCentavos: 9900, ref: 'ref-c2' }),
    );

    await handleWebhook(
      deps,
      signed(
        checkoutPaidEvent({
          eventId: 'evt_c1',
          sessionId: 'cs_c1',
          paymentId: 'pay_c1',
          amount: 9900,
          metadata: { uid: 'u1', product: 'cloud', ref: 'ref-c1' },
        }),
      ),
    );
    let entitlements = await store.getEntitlements('u1');
    expect(entitlements?.cloud.status).toBe('active');
    expect(entitlements?.cloud.accessUntil).toBe(NOW + 30 * DAY_MS);
    expect(entitlements?.pro).toBe(false);

    await handleWebhook(
      deps,
      signed(
        checkoutPaidEvent({
          eventId: 'evt_c2',
          sessionId: 'cs_c2',
          paymentId: 'pay_c2',
          amount: 9900,
          metadata: { uid: 'u1', product: 'cloud', ref: 'ref-c2' },
        }),
      ),
    );
    entitlements = await store.getEntitlements('u1');
    expect(entitlements?.cloud.accessUntil).toBe(NOW + 60 * DAY_MS);
    expect(store.payments.get('pay_c2')?.outcome).toBe('cloud_extended');
  });

  it('acknowledges a redelivered event without applying it again', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());
    await handleWebhook(deps, signed(checkoutPaidEvent({})));
    const before = await store.getEntitlements('u1');

    const response = await handleWebhook(deps, signed(checkoutPaidEvent({})));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: 'duplicate' });
    expect(await store.getEntitlements('u1')).toEqual(before);
    expect(store.payments.size).toBe(1);
  });

  it('never applies the same payment twice even under a fresh event id', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());
    await handleWebhook(deps, signed(checkoutPaidEvent({ eventId: 'evt_first' })));

    const response = await handleWebhook(
      deps,
      signed(checkoutPaidEvent({ eventId: 'evt_second' })),
    );

    expect(response.body).toEqual({ received: true, outcome: 'applied:0' });
    expect(store.payments.size).toBe(1);
    expect(store.payments.get('pay_1')?.eventId).toBe('evt_first');
    expect(store.events.get('evt_second')?.outcome).toBe('applied:0');
  });

  it('records a second Pro payment as already owned and changes nothing', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef({ id: 'cs_1' }));
    await store.putRef(checkoutRef({ id: 'cs_2', ref: 'ref-2' }));
    await handleWebhook(
      deps,
      signed(checkoutPaidEvent({ eventId: 'evt_1', sessionId: 'cs_1', paymentId: 'pay_1' })),
    );

    await handleWebhook(
      deps,
      signed(
        checkoutPaidEvent({
          eventId: 'evt_2',
          sessionId: 'cs_2',
          paymentId: 'pay_2',
          metadata: { uid: 'u1', product: 'pro', ref: 'ref-2' },
        }),
      ),
    );

    const entitlements = await store.getEntitlements('u1');
    expect(entitlements?.proPaymentId).toBe('pay_1');
    expect(store.payments.get('pay_2')?.outcome).toBe('pro_already');
  });

  it('refuses a payment for the wrong amount or currency', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());

    const cheap = await handleWebhook(deps, signed(checkoutPaidEvent({ amount: 100 })));
    expect(cheap.body).toEqual({ received: true, outcome: 'applied:0' });
    expect(await store.getEntitlements('u1')).toBeNull();
    expect(store.payments.size).toBe(0);

    const foreign = await handleWebhook(
      deps,
      signed(checkoutPaidEvent({ eventId: 'evt_2', currency: 'USD' })),
    );
    expect(foreign.body).toEqual({ received: true, outcome: 'applied:0' });
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('refuses a session it never created, whatever the body claims', async () => {
    const { deps, store } = rig();

    const response = await handleWebhook(
      deps,
      signed(checkoutPaidEvent({ sessionId: 'cs_forged' })),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: 'applied:0' });
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('refuses a session whose metadata disagrees with the server record', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());

    await handleWebhook(
      deps,
      signed(checkoutPaidEvent({ metadata: { uid: 'u2', product: 'pro', ref: 'ref-1' } })),
    );
    expect(await store.getEntitlements('u1')).toBeNull();
    expect(await store.getEntitlements('u2')).toBeNull();

    await handleWebhook(
      deps,
      signed(
        checkoutPaidEvent({
          eventId: 'evt_2',
          metadata: { uid: 'u1', product: 'cloud', ref: 'ref-1' },
        }),
      ),
    );
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('ignores payments in the session that are not paid', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());
    const response = await handleWebhook(
      deps,
      signed(checkoutPaidEvent({ paymentStatus: 'failed' })),
    );
    expect(response.body).toEqual({ received: true, outcome: 'applied:0' });
    expect(await store.getEntitlements('u1')).toBeNull();
  });
});

describe('handleWebhook: verification', () => {
  it('rejects a bad signature and records nothing', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());

    const response = await handleWebhook(deps, signed(checkoutPaidEvent({}), { secret: 'wrong' }));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid-signature' });
    expect(store.events.size).toBe(0);
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('rejects a missing header and a stale timestamp', async () => {
    const { deps } = rig();
    const missing = await handleWebhook(deps, {
      rawBody: JSON.stringify(checkoutPaidEvent({})),
      signatureHeader: undefined,
    });
    expect(missing.status).toBe(400);
    const stale = await handleWebhook(
      deps,
      signed(checkoutPaidEvent({}), { t: Math.floor(NOW / 1000) - 3600 }),
    );
    expect(stale.status).toBe(400);
  });

  it('rejects a body that is not an event', async () => {
    const { deps } = rig();
    expect((await handleWebhook(deps, signed('{"hello":"world"}'))).status).toBe(400);
    expect((await handleWebhook(deps, signed('not json'))).status).toBe(400);
  });

  it('verifies a live event against the live signature, and only that one', async () => {
    const { deps, store } = rig({ livemode: true });
    await store.putRef(checkoutRef());

    const testSigned = await handleWebhook(deps, signed(checkoutPaidEvent({ livemode: true })));
    expect(testSigned.status).toBe(400);

    const liveSigned = await handleWebhook(
      deps,
      signed(checkoutPaidEvent({ livemode: true }), { live: true }),
    );
    expect(liveSigned.status).toBe(200);
    expect((await store.getEntitlements('u1'))?.pro).toBe(true);
  });

  it('acknowledges but ignores an event from the other mode', async () => {
    const { deps, store } = rig({ livemode: true });
    await store.putRef(checkoutRef());

    const response = await handleWebhook(deps, signed(checkoutPaidEvent({ livemode: false })));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: 'ignored-mode' });
    expect(await store.getEntitlements('u1')).toBeNull();
  });

  it('acknowledges event types it does not handle', async () => {
    const { deps, store } = rig();
    const response = await handleWebhook(
      deps,
      signed(
        subscriptionEvent({
          eventId: 'evt_x',
          type: 'payout.deposited',
          resource: { id: 'po_1', attributes: {} },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: 'ignored' });
    expect(store.events.get('evt_x')?.outcome).toBe('ignored');
  });

  it('answers 500 when applying throws, so PayMongo retries, and marks the event', async () => {
    const { deps, store } = rig();
    await store.putRef(checkoutRef());
    jest.spyOn(store, 'applyPayment').mockRejectedValueOnce(new Error('firestore unavailable'));

    const response = await handleWebhook(deps, signed(checkoutPaidEvent({})));

    expect(response.status).toBe(500);
    expect(store.events.get('evt_1')?.outcome).toBe('error');
    // The retry is a new delivery of the same event id, and it must be allowed to run.
    const retry = await handleWebhook(deps, signed(checkoutPaidEvent({})));
    expect(retry.status).toBe(200);
    expect((await store.getEntitlements('u1'))?.pro).toBe(true);
  });
});

describe('handleWebhook: subscriptions', () => {
  const NEXT = '2026-10-21';

  it('activates Cloud on a paid invoice for a known subscription', async () => {
    const { deps, store } = rig();
    await store.putRef({ kind: 'subscription', id: 'sub_1', uid: 'u1', createdAt: NOW });

    const response = await handleWebhook(
      deps,
      signed(
        subscriptionEvent({
          eventId: 'evt_inv',
          type: 'subscription.invoice.paid',
          resource: {
            id: 'inv_1',
            type: 'invoice',
            attributes: {
              status: 'paid',
              subscription: { id: 'sub_1', status: 'active', next_billing_schedule: NEXT },
            },
          },
        }),
      ),
    );

    expect(response.body).toEqual({ received: true, outcome: 'subscription:invoice.paid' });
    const entitlements = await store.getEntitlements('u1');
    expect(entitlements?.cloud).toMatchObject({
      status: 'active',
      source: 'subscription',
      subscriptionId: 'sub_1',
      currentPeriodEnd: Date.UTC(2026, 9, 21),
      accessUntil: Date.UTC(2026, 9, 21) + 3 * DAY_MS,
    });
  });

  it('mirrors past due, unpaid and cancellation', async () => {
    const { deps, store } = rig();
    await store.putRef({ kind: 'subscription', id: 'sub_1', uid: 'u1', createdAt: NOW });
    const send = (eventId: string, type: string, status: string) =>
      handleWebhook(
        deps,
        signed(
          subscriptionEvent({
            eventId,
            type,
            resource: { id: 'sub_1', type: 'subscription', attributes: { status } },
          }),
        ),
      );

    await send('evt_pd', 'subscription.past_due', 'past_due');
    expect((await store.getEntitlements('u1'))?.cloud.status).toBe('past_due');

    await send('evt_up', 'subscription.updated', 'cancelled');
    expect((await store.getEntitlements('u1'))?.cloud).toMatchObject({
      status: 'cancelled',
      cancelAtPeriodEnd: true,
    });

    await send('evt_un', 'subscription.unpaid', 'unpaid');
    expect((await store.getEntitlements('u1'))?.cloud.status).toBe('unpaid');
  });

  it('ignores subscription events for subscriptions it does not know', async () => {
    const { deps, store } = rig();
    const response = await handleWebhook(
      deps,
      signed(
        subscriptionEvent({
          eventId: 'evt_s',
          type: 'subscription.updated',
          resource: { id: 'sub_unknown', attributes: { status: 'active' } },
        }),
      ),
    );
    expect(response.body).toEqual({ received: true, outcome: 'ignored-unknown-subscription' });
    expect(store.entitlements.size).toBe(0);
  });
});
