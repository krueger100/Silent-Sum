/**
 * The subscription calls, each asserted against the path and body PayMongo's reference gives.
 *
 * These assertions ARE the verification. The integration cannot be exercised against the live
 * API until PayMongo enables Subscriptions on the account, so the only thing standing between
 * this code and a wrong request is that the documented shape is written down and checked here:
 *
 *   POST /subscriptions/plans            `plan_type`, `amount`, `currency`, `name`,
 *                                        `description`, `interval`, `interval_count`
 *   POST /customers                      `first_name`, `last_name`, `email`, `default_device`
 *   POST /subscriptions                  `customer_id`, `plan_id` -- and nothing else
 *   PUT  /subscriptions/{id}/plan        `plan_id`
 *   PUT  /subscriptions/{id}/payment_method
 *                                        `payment_method_id`, `redirect_url`
 *   POST /subscriptions/invoices/{id}/pay        no body
 *   POST /subscriptions/{id}/test_cycle          no body, test keys only
 *   POST /payment_methods                `type`
 *   POST /payment_intents/{id}/attach    `payment_method`, `return_url`
 */
import {
  PayMongoApiError,
  PayMongoClient,
  type PayMongoFetch,
  type PayMongoHttpResponse,
} from '../paymongo/client';

const SECRET = 'sk_test_placeholder';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function respond(status: number, body: unknown): PayMongoHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function rig(responder: () => PayMongoHttpResponse): {
  client: PayMongoClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: PayMongoFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return responder();
  };
  return { client: new PayMongoClient(SECRET, { fetchImpl }), calls };
}

const resource = (id: string, attributes: Record<string, unknown> = {}) => ({
  data: { id, type: 'x', attributes },
});

/** The `data.attributes` a recorded call sent. */
function attributesOf(call: Recorded | undefined): Record<string, unknown> {
  const body = call?.body as { data?: { attributes?: Record<string, unknown> } } | undefined;
  return body?.data?.attributes ?? {};
}

const PLAN_INPUT = {
  name: 'SilentSum Cloud 64 GB',
  description: 'Encrypted backup.',
  amountCentavos: 9900,
  currency: 'PHP',
  interval: 'monthly' as const,
  intervalCount: 1,
};

describe('PayMongoClient: subscriptions', () => {
  it('creates a plan at POST /subscriptions/plans with plan_type scheduled', async () => {
    const { client, calls } = rig(() => respond(200, resource('plan_1')));

    const id = await client.createPlan({ ...PLAN_INPUT, metadata: { band: '64 GB' } });

    expect(id).toBe('plan_1');
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/subscriptions/plans');
    expect(calls[0]?.method).toBe('POST');
    expect(attributesOf(calls[0])).toEqual({
      plan_type: 'scheduled',
      name: 'SilentSum Cloud 64 GB',
      description: 'Encrypted backup.',
      amount: 9900,
      currency: 'PHP',
      interval: 'monthly',
      interval_count: 1,
      metadata: { band: '64 GB' },
    });
  });

  it('creates a customer with default_device email and NO phone', async () => {
    const { client, calls } = rig(() => respond(200, resource('cus_1')));

    await client.createCustomer({
      firstName: 'SilentSum',
      lastName: 'Subscriber',
      email: 'u1@example.test',
      metadata: { uid: 'u1' },
    });

    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/customers');
    expect(attributesOf(calls[0])).toEqual({
      first_name: 'SilentSum',
      last_name: 'Subscriber',
      email: 'u1@example.test',
      default_device: 'email',
      metadata: { uid: 'u1' },
    });
    // PayMongo marks `phone` optional, and not sending it is the point: a vault app has no
    // business holding a mobile number, and nothing can leak a field that was never there.
    expect(attributesOf(calls[0])).not.toHaveProperty('phone');
  });

  it('creates a subscription with exactly customer_id and plan_id', async () => {
    const { client, calls } = rig(() => respond(200, resource('sub_1', { status: 'incomplete' })));

    const subscription = await client.createSubscription({ customerId: 'cus_1', planId: 'plan_1' });

    expect(subscription).toMatchObject({ id: 'sub_1' });
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/subscriptions');
    expect(attributesOf(calls[0])).toEqual({ customer_id: 'cus_1', plan_id: 'plan_1' });
  });

  it('changes a plan with PUT /subscriptions/{id}/plan', async () => {
    const { client, calls } = rig(() => respond(200, resource('sub_1')));
    await client.changeSubscriptionPlan('sub_1', 'plan_2');
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/subscriptions/sub_1/plan');
    expect(calls[0]?.method).toBe('PUT');
    expect(attributesOf(calls[0])).toEqual({ plan_id: 'plan_2' });
  });

  it('changes a payment method with PUT /subscriptions/{id}/payment_method', async () => {
    const { client, calls } = rig(() => respond(200, resource('sub_1')));
    await client.changeSubscriptionPaymentMethod('sub_1', {
      paymentMethodId: 'pm_2',
      redirectUrl: 'https://return.test/',
    });
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/subscriptions/sub_1/payment_method');
    expect(calls[0]?.method).toBe('PUT');
    expect(attributesOf(calls[0])).toEqual({
      payment_method_id: 'pm_2',
      redirect_url: 'https://return.test/',
    });
  });

  it('pays an open invoice with no body at all', async () => {
    const { client, calls } = rig(() => respond(200, resource('in_1', { status: 'paid' })));
    await client.payInvoice('in_1');
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/subscriptions/invoices/in_1/pay');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBeUndefined();
  });

  it('triggers a test cycle with no body', async () => {
    const { client, calls } = rig(() => respond(200, resource('sub_1')));
    await client.triggerTestCycle('sub_1');
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/subscriptions/sub_1/test_cycle');
    expect(calls[0]?.body).toBeUndefined();
  });

  it('creates a wallet method from its type alone, with no details object', async () => {
    const { client, calls } = rig(() => respond(200, resource('pm_1', { type: 'paymaya' })));
    await client.createWalletMethod('paymaya');
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/payment_methods');
    // No `details`: no card number, no CVC, no PCI scope. This one assertion is the reason the
    // subscription path is wallet-only.
    expect(Object.keys(attributesOf(calls[0]))).toEqual(['type']);
    expect(attributesOf(calls[0])).toEqual({ type: 'paymaya' });
  });

  it('attaches a payment method to the first invoice payment intent', async () => {
    const { client, calls } = rig(() =>
      respond(
        200,
        resource('pi_1', {
          status: 'awaiting_next_action',
          next_action: { type: 'redirect', redirect: { url: 'https://auth.test/pi_1' } },
        }),
      ),
    );

    const attached = await client.attachPaymentIntent({
      paymentIntentId: 'pi_1',
      paymentMethodId: 'pm_1',
      returnUrl: 'https://return.test/?outcome=success',
    });

    expect(attached).toMatchObject({ id: 'pi_1' });
    expect(calls[0]?.url).toBe('https://api.paymongo.com/v1/payment_intents/pi_1/attach');
    expect(attributesOf(calls[0])).toEqual({
      payment_method: 'pm_1',
      return_url: 'https://return.test/?outcome=success',
    });
  });

  it('refuses every id that could rewrite a URL, before making any request', async () => {
    const { client, calls } = rig(() => respond(200, {}));
    await expect(client.retrieveSubscription('../customers')).rejects.toBeInstanceOf(
      PayMongoApiError,
    );
    await expect(client.changeSubscriptionPlan('sub_1', '../../plans')).rejects.toBeInstanceOf(
      PayMongoApiError,
    );
    await expect(client.payInvoice('in_1/../../x')).rejects.toBeInstanceOf(PayMongoApiError);
    await expect(client.triggerTestCycle('sub_1?x=1')).rejects.toBeInstanceOf(PayMongoApiError);
    await expect(
      client.attachPaymentIntent({
        paymentIntentId: 'pi_1',
        paymentMethodId: 'a b',
        returnUrl: 'https://x.test/',
      }),
    ).rejects.toBeInstanceOf(PayMongoApiError);
    await expect(
      client.createSubscription({ customerId: 'cus_1', planId: '../plans' }),
    ).rejects.toBeInstanceOf(PayMongoApiError);
    expect(calls).toHaveLength(0);
  });

  it('refuses an answer that carried no id, rather than returning an empty one', async () => {
    const { client } = rig(() => respond(200, { data: { attributes: {} } }));
    await expect(client.createPlan(PLAN_INPUT)).rejects.toMatchObject({ status: 502 });
    const noData = rig(() => respond(200, {}));
    await expect(noData.client.createSubscription({ customerId: 'c', planId: 'p' })).rejects.toMatchObject(
      { status: 502 },
    );
  });

  it('never puts the secret key in an error, whichever call failed', async () => {
    const { client } = rig(() =>
      respond(402, { errors: [{ code: 'resource_unavailable', detail: 'subscriptions disabled' }] }),
    );
    // This is the error shape to expect in production until PayMongo enables the feature.
    await expect(client.createSubscription({ customerId: 'cus_1', planId: 'plan_1' })).rejects.toMatchObject(
      { status: 402, code: 'resource_unavailable', detail: 'subscriptions disabled' },
    );
    let message = '';
    try {
      await client.createPlan(PLAN_INPUT);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(SECRET);
  });
});
