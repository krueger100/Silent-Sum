import {
  parseWebhookEvent,
  readCheckoutSession,
  readInvoice,
  readPayment,
  readSubscription,
} from '../paymongo/events';

const CHECKOUT_RESOURCE = {
  id: 'cs_abc',
  type: 'checkout_session',
  attributes: {
    status: 'active',
    reference_number: 'ref-1',
    metadata: { uid: 'u1', product: 'pro', ref: 'ref-1', PYM_ignored: 3 },
    payment_intent: { id: 'pi_1', type: 'payment_intent', attributes: { status: 'succeeded' } },
    payments: [
      {
        id: 'pay_1',
        type: 'payment',
        attributes: { status: 'paid', amount: 29900, currency: 'PHP', metadata: { ref: 'ref-1' } },
      },
      {
        id: 'pay_0',
        type: 'payment',
        attributes: { status: 'failed', amount: 29900, currency: 'PHP' },
      },
    ],
  },
};

const CHECKOUT_PAID_EVENT = {
  data: {
    id: 'evt_ck1',
    type: 'event',
    attributes: {
      type: 'checkout_session.payment.paid',
      livemode: false,
      created_at: 1_758_000_000,
      updated_at: 1_758_000_000,
      data: CHECKOUT_RESOURCE,
      previous_data: {},
    },
  },
};

describe('parseWebhookEvent', () => {
  it('reads the envelope PayMongo sends', () => {
    const event = parseWebhookEvent(CHECKOUT_PAID_EVENT);
    expect(event).not.toBeNull();
    expect(event?.id).toBe('evt_ck1');
    expect(event?.type).toBe('checkout_session.payment.paid');
    expect(event?.livemode).toBe(false);
    expect(event?.createdAt).toBe(1_758_000_000_000);
    expect(event?.resource).toBe(CHECKOUT_RESOURCE);
  });

  it('returns null for anything that is not an event', () => {
    expect(parseWebhookEvent(null)).toBeNull();
    expect(parseWebhookEvent('{}')).toBeNull();
    expect(parseWebhookEvent({ data: { id: 'evt_1' } })).toBeNull();
    expect(parseWebhookEvent({ data: { id: '', attributes: { type: 'x', data: {} } } })).toBeNull();
    expect(
      parseWebhookEvent({ data: { id: 'evt_1', attributes: { type: 'x', data: 'no' } } }),
    ).toBeNull();
    expect(
      parseWebhookEvent({ data: { id: 'evt_1', attributes: { type: '', data: {} } } }),
    ).toBeNull();
  });

  it('treats a missing livemode as live, so a test event can never pass for one by omission', () => {
    const event = parseWebhookEvent({
      data: {
        id: 'evt_1',
        attributes: { type: 'payment.paid', data: { id: 'pay_1', attributes: {} } },
      },
    });
    expect(event?.livemode).toBe(true);
    expect(event?.createdAt).toBeNull();
  });
});

describe('readCheckoutSession', () => {
  it('reads the session, its string metadata and every payment', () => {
    const session = readCheckoutSession(CHECKOUT_RESOURCE);
    expect(session).toEqual({
      id: 'cs_abc',
      status: 'active',
      referenceNumber: 'ref-1',
      metadata: { uid: 'u1', product: 'pro', ref: 'ref-1' },
      paymentIntentStatus: 'succeeded',
      payments: [
        { id: 'pay_1', status: 'paid', amount: 29900, currency: 'PHP', metadata: { ref: 'ref-1' } },
        { id: 'pay_0', status: 'failed', amount: 29900, currency: 'PHP', metadata: {} },
      ],
    });
  });

  it('copes with a session that has nothing optional', () => {
    expect(readCheckoutSession({ id: 'cs_1', attributes: {} })).toEqual({
      id: 'cs_1',
      status: null,
      referenceNumber: null,
      metadata: {},
      paymentIntentStatus: null,
      payments: [],
    });
  });

  it('returns null without an id or attributes', () => {
    expect(readCheckoutSession(null)).toBeNull();
    expect(readCheckoutSession({ attributes: {} })).toBeNull();
    expect(readCheckoutSession({ id: 'cs_1' })).toBeNull();
    expect(readCheckoutSession({ id: 42, attributes: {} })).toBeNull();
  });

  it('drops payments that have no id', () => {
    const session = readCheckoutSession({
      id: 'cs_1',
      attributes: { payments: [{ attributes: { status: 'paid' } }, 'junk', null] },
    });
    expect(session?.payments).toEqual([]);
  });
});

describe('readPayment', () => {
  it('reads a payment resource', () => {
    expect(
      readPayment({
        id: 'pay_9',
        type: 'payment',
        attributes: { status: 'paid', amount: 9900, currency: 'PHP', metadata: { uid: 'u1' } },
      }),
    ).toEqual({
      id: 'pay_9',
      status: 'paid',
      amount: 9900,
      currency: 'PHP',
      metadata: { uid: 'u1' },
    });
  });

  it('ignores a non-numeric amount', () => {
    expect(readPayment({ id: 'pay_9', attributes: { amount: '9900' } })?.amount).toBeNull();
  });
});

describe('readSubscription', () => {
  it('reads the status, the customer and the next billing date as UTC midnight', () => {
    expect(
      readSubscription({
        id: 'sub_1',
        type: 'subscription',
        attributes: { status: 'active', customer_id: 'cus_1', next_billing_schedule: '2026-10-21' },
      }),
    ).toEqual({
      id: 'sub_1',
      status: 'active',
      customerId: 'cus_1',
      nextBillingMs: Date.UTC(2026, 9, 21),
    });
  });

  it('leaves an unreadable billing date null', () => {
    expect(
      readSubscription({ id: 'sub_1', attributes: { next_billing_schedule: 'next month' } })
        ?.nextBillingMs,
    ).toBeNull();
    expect(readSubscription({ id: 'sub_1', attributes: {} })?.nextBillingMs).toBeNull();
  });
});

describe('readInvoice', () => {
  it('reads the invoice with its nested subscription', () => {
    expect(
      readInvoice({
        id: 'inv_1',
        type: 'invoice',
        attributes: {
          status: 'paid',
          customer_id: 'cus_1',
          subscription: { id: 'sub_1', status: 'active', next_billing_schedule: '2026-10-21' },
        },
      }),
    ).toEqual({
      id: 'inv_1',
      status: 'paid',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      nextBillingMs: Date.UTC(2026, 9, 21),
    });
  });

  it('accepts a bare subscription id too', () => {
    expect(readInvoice({ id: 'inv_1', attributes: { subscription_id: 'sub_2' } })).toMatchObject({
      subscriptionId: 'sub_2',
      subscriptionStatus: null,
      nextBillingMs: null,
    });
  });
});
