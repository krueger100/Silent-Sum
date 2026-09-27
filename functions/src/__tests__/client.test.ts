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
  headers: Record<string, string>;
  body: unknown;
}

function respond(status: number, body: unknown): PayMongoHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function rig(responder: (call: Recorded) => PayMongoHttpResponse): {
  client: PayMongoClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: PayMongoFetch = async (url, init) => {
    const call: Recorded = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    return responder(call);
  };
  return { client: new PayMongoClient(SECRET, { fetchImpl }), calls };
}

const CHECKOUT_INPUT = {
  lineItem: {
    name: 'SilentSum Pro',
    description: 'Pay once. Keep Pro forever.',
    amountCentavos: 29900,
    currency: 'PHP',
  },
  paymentMethodTypes: ['gcash', 'card'],
  successUrl: 'https://example.test/return?outcome=success',
  cancelUrl: 'https://example.test/return?outcome=cancel',
  description: 'SilentSum Pro',
  referenceNumber: 'ref-1',
  metadata: { uid: 'u1', product: 'pro', ref: 'ref-1' },
};

describe('PayMongoClient', () => {
  it('creates a checkout session with basic auth and the documented body', async () => {
    const { client, calls } = rig(() =>
      respond(200, {
        data: {
          id: 'cs_1',
          type: 'checkout_session',
          attributes: { checkout_url: 'https://checkout.paymongo.com/cs_1', status: 'active' },
        },
      }),
    );

    const session = await client.createCheckoutSession(CHECKOUT_INPUT);

    expect(session.id).toBe('cs_1');
    expect(session.checkoutUrl).toBe('https://checkout.paymongo.com/cs_1');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://api.paymongo.com/v1/checkout_sessions');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(call?.body).toEqual({
      data: {
        attributes: {
          line_items: [
            {
              name: 'SilentSum Pro',
              description: 'Pay once. Keep Pro forever.',
              amount: 29900,
              currency: 'PHP',
              quantity: 1,
            },
          ],
          payment_method_types: ['gcash', 'card'],
          success_url: 'https://example.test/return?outcome=success',
          cancel_url: 'https://example.test/return?outcome=cancel',
          description: 'SilentSum Pro',
          reference_number: 'ref-1',
          metadata: { uid: 'u1', product: 'pro', ref: 'ref-1' },
          send_email_receipt: false,
          show_line_items: true,
          show_description: true,
        },
      },
    });
  });

  it('refuses a session answer without a hosted https page', async () => {
    const { client } = rig(() =>
      respond(200, { data: { id: 'cs_1', attributes: { checkout_url: 'http://plain.example' } } }),
    );
    await expect(client.createCheckoutSession(CHECKOUT_INPUT)).rejects.toBeInstanceOf(
      PayMongoApiError,
    );
  });

  it('retrieves a session as its bare resource', async () => {
    const resource = {
      id: 'cs_1',
      type: 'checkout_session',
      attributes: { status: 'active', payments: [] },
    };
    const { client, calls } = rig(() => respond(200, { data: resource }));

    expect(await client.retrieveCheckoutSession('cs_1')).toEqual(resource);
    expect(calls[0]).toMatchObject({
      url: 'https://api.paymongo.com/v1/checkout_sessions/cs_1',
      method: 'GET',
    });
    expect(calls[0]?.body).toBeUndefined();
  });

  it('refuses to build a URL from an id that is not a PayMongo id', async () => {
    const { client, calls } = rig(() => respond(200, {}));
    await expect(client.retrieveCheckoutSession('../webhooks')).rejects.toBeInstanceOf(
      PayMongoApiError,
    );
    expect(calls).toHaveLength(0);
  });

  it('cancels a subscription with a reason', async () => {
    const { client, calls } = rig(() =>
      respond(200, { data: { id: 'sub_1', attributes: { status: 'cancelled' } } }),
    );
    await client.cancelSubscription('sub_1', 'unused');
    expect(calls[0]).toMatchObject({
      url: 'https://api.paymongo.com/v1/subscriptions/sub_1/cancel',
      method: 'POST',
      body: { data: { attributes: { cancellation_reason: 'unused' } } },
    });
  });

  it('turns an API error into PayMongoApiError with the status and detail, never the key', async () => {
    const { client } = rig(() =>
      respond(400, {
        errors: [{ code: 'parameter_invalid', detail: 'amount must be at least 100' }],
      }),
    );
    let caught: unknown;
    try {
      await client.createCheckoutSession(CHECKOUT_INPUT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PayMongoApiError);
    const error = caught as PayMongoApiError;
    expect(error.status).toBe(400);
    expect(error.code).toBe('parameter_invalid');
    expect(error.detail).toBe('amount must be at least 100');
    expect(error.message).not.toContain(SECRET);
  });

  it('copes with an error body that is not JSON', async () => {
    const { client } = rig(() => respond(502, '<html>bad gateway</html>'));
    await expect(client.retrieveCheckoutSession('cs_1')).rejects.toMatchObject({
      status: 502,
      code: null,
    });
  });

  it('reports a transport failure as a 0-status PayMongoApiError', async () => {
    const client = new PayMongoClient(SECRET, {
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await expect(client.retrieveCheckoutSession('cs_1')).rejects.toMatchObject({ status: 0 });
  });
});
