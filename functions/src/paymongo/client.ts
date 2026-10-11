/**
 * The PayMongo calls this backend makes, over plain `fetch`.
 *
 * Authentication is HTTP Basic with the secret key as the user name and an empty password. The
 * key arrives through a Firebase secret and is never logged, never put in an error and never
 * sent anywhere but `api.paymongo.com`. Resource ids are interpolated into paths only after a
 * character check, so a value that came from a client can never rewrite the URL.
 *
 * Every path and body below was taken from PayMongo's own reference, not inferred:
 *   POST  /checkout_sessions                      one-off hosted page
 *   GET   /checkout_sessions/{id}
 *   POST  /customers                              `first_name`, `last_name`, `email`,
 *                                                 `default_device`; `phone` is OPTIONAL
 *   POST  /subscriptions/plans                    one plan per price band
 *   POST  /subscriptions                          `customer_id` + `plan_id`, nothing else
 *   GET   /subscriptions/{id}
 *   PUT   /subscriptions/{id}/plan                move between bands
 *   PUT   /subscriptions/{id}/payment_method      replace the method future cycles charge
 *   POST  /subscriptions/{id}/cancel              `cancellation_reason` from a fixed list
 *   POST  /subscriptions/invoices/{id}/pay        retry one open invoice
 *   POST  /subscriptions/{id}/test_cycle          TEST KEYS ONLY: force the next cycle
 *   POST  /payment_methods                        wallets only here -- see `createWalletMethod`
 *   POST  /payment_intents/{id}/attach            the first invoice's payment
 */
export interface PayMongoHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type PayMongoFetch = (
  url: string,
  init: { method: 'GET' | 'POST' | 'PUT'; headers: Record<string, string>; body?: string },
) => Promise<PayMongoHttpResponse>;

export class PayMongoApiError extends Error {
  constructor(
    /** HTTP status, or 0 when PayMongo could not be reached at all. */
    readonly status: number,
    /** PayMongo's own error code (`parameter_invalid`, `resource_not_found`, ...) when it gave one. */
    readonly code: string | null,
    readonly detail: string,
  ) {
    super(`PayMongo ${String(status)}${code === null ? '' : ` ${code}`}: ${detail}`);
    this.name = 'PayMongoApiError';
  }
}

export interface CreateCheckoutSessionInput {
  readonly lineItem: {
    readonly name: string;
    readonly description: string;
    readonly amountCentavos: number;
    readonly currency: string;
  };
  readonly paymentMethodTypes: readonly string[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly description: string;
  readonly referenceNumber: string;
  readonly metadata: Record<string, string>;
}

export interface CreatedCheckoutSession {
  readonly id: string;
  readonly checkoutUrl: string;
  readonly resource: Record<string, unknown>;
}

/** `POST /subscriptions/plans`. `plan_type` is left at PayMongo's default, `scheduled`. */
export interface CreatePlanInput {
  readonly name: string;
  readonly description: string;
  /** Centavos. PayMongo's minimum is 100. */
  readonly amountCentavos: number;
  readonly currency: string;
  readonly interval: 'weekly' | 'monthly' | 'yearly';
  /** 1 to 10. */
  readonly intervalCount: number;
  readonly metadata?: Record<string, string>;
}

/**
 * `POST /customers`.
 *
 * `phone` is deliberately absent. PayMongo marks it optional, and SilentSum does not know it:
 * the account is an e-mail and a password, and asking a vault app's user for a mobile number to
 * buy storage would collect an identifier the product exists to avoid. `default_device` is
 * therefore always `email`.
 */
export interface CreateCustomerInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly metadata?: Record<string, string>;
}

/**
 * The payment methods a subscription may be charged on, as far as THIS backend is concerned.
 *
 * PayMongo supports cards and Maya for subscriptions. Cards are missing on purpose: creating a
 * card payment method means `details.card_number`, `exp_month`, `exp_year` and `cvc` crossing
 * this process, which would drag SilentSum's servers into PCI DSS scope for the sake of one
 * product. Maya needs nothing but its `type`, so the wallet path carries no card data at all --
 * and because the union has one member, there is no code path that could start.
 */
export type SubscriptionWallet = 'paymaya';

export const PAYMONGO_BASE_URL = 'https://api.paymongo.com/v1';

const ID_PATTERN = /^[A-Za-z0-9_]{1,128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** PayMongo answers errors as `{ errors: [{ code, detail }] }`. */
function firstError(parsed: unknown): { code: string | null; detail: string | null } {
  const errors = record(parsed)?.errors;
  if (!Array.isArray(errors)) return { code: null, detail: null };
  const first = record(errors[0]);
  return { code: text(first?.code), detail: text(first?.detail) };
}

export class PayMongoClient {
  private readonly http: PayMongoFetch;
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(
    secretKey: string,
    options: { readonly fetchImpl?: PayMongoFetch; readonly baseUrl?: string } = {},
  ) {
    this.http = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? PAYMONGO_BASE_URL).replace(/\/+$/, '');
    this.authorization = `Basic ${Buffer.from(`${secretKey}:`, 'utf8').toString('base64')}`;
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreatedCheckoutSession> {
    const data = await this.request('POST', '/checkout_sessions', {
      data: {
        attributes: {
          line_items: [
            {
              name: input.lineItem.name,
              description: input.lineItem.description,
              amount: input.lineItem.amountCentavos,
              currency: input.lineItem.currency,
              quantity: 1,
            },
          ],
          payment_method_types: [...input.paymentMethodTypes],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          description: input.description,
          reference_number: input.referenceNumber,
          metadata: { ...input.metadata },
          // No receipt mail: the product name in an inbox is the one place it does not belong.
          send_email_receipt: false,
          show_line_items: true,
          show_description: true,
        },
      },
    });
    const resource = record(data);
    const id = text(resource?.id);
    const checkoutUrl = text(record(resource?.attributes)?.checkout_url);
    if (
      resource === null ||
      id === null ||
      checkoutUrl === null ||
      !/^https:\/\//i.test(checkoutUrl)
    ) {
      throw new PayMongoApiError(502, null, 'checkout session answer carried no hosted page');
    }
    return { id, checkoutUrl, resource };
  }

  /** The bare resource (`data`), for `readCheckoutSession`. */
  async retrieveCheckoutSession(id: string): Promise<Record<string, unknown>> {
    this.assertId(id);
    const resource = record(await this.request('GET', `/checkout_sessions/${id}`));
    if (resource === null)
      throw new PayMongoApiError(502, null, 'checkout session answer was malformed');
    return resource;
  }

  /** The plan a band's subscriptions are created against. Returns its id. */
  async createPlan(input: CreatePlanInput): Promise<string> {
    const data = await this.request('POST', '/subscriptions/plans', {
      data: {
        attributes: {
          plan_type: 'scheduled',
          name: input.name,
          description: input.description,
          amount: input.amountCentavos,
          currency: input.currency,
          interval: input.interval,
          interval_count: input.intervalCount,
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        },
      },
    });
    return this.idOf(data, 'plan');
  }

  async createCustomer(input: CreateCustomerInput): Promise<string> {
    const data = await this.request('POST', '/customers', {
      data: {
        attributes: {
          first_name: input.firstName,
          last_name: input.lastName,
          email: input.email,
          default_device: 'email',
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        },
      },
    });
    return this.idOf(data, 'customer');
  }

  /**
   * The subscription itself. The body really is only these two fields: the price comes from the
   * plan and the schedule from PayMongo, which is the whole point of using it over a timer here.
   *
   * The bare resource comes back rather than a parsed view, because the first invoice and its
   * payment intent are nested in it and `events.ts` is where this shape is read and tested.
   */
  async createSubscription(input: {
    readonly customerId: string;
    readonly planId: string;
  }): Promise<Record<string, unknown>> {
    this.assertId(input.customerId);
    this.assertId(input.planId);
    const resource = record(
      await this.request('POST', '/subscriptions', {
        data: { attributes: { customer_id: input.customerId, plan_id: input.planId } },
      }),
    );
    if (resource === null) throw new PayMongoApiError(502, null, 'subscription answer was malformed');
    return resource;
  }

  async retrieveSubscription(id: string): Promise<Record<string, unknown>> {
    this.assertId(id);
    const resource = record(await this.request('GET', `/subscriptions/${id}`));
    if (resource === null) throw new PayMongoApiError(502, null, 'subscription answer was malformed');
    return resource;
  }

  /** Move a live subscription to another band's plan. PayMongo applies it from the next cycle. */
  async changeSubscriptionPlan(id: string, planId: string): Promise<void> {
    this.assertId(id);
    this.assertId(planId);
    await this.request('PUT', `/subscriptions/${id}/plan`, {
      data: { attributes: { plan_id: planId } },
    });
  }

  /** Replace what future cycles are charged on. The answer carries the re-authentication step. */
  async changeSubscriptionPaymentMethod(
    id: string,
    input: { readonly paymentMethodId: string; readonly redirectUrl: string },
  ): Promise<Record<string, unknown>> {
    this.assertId(id);
    this.assertId(input.paymentMethodId);
    const resource = record(
      await this.request('PUT', `/subscriptions/${id}/payment_method`, {
        data: {
          attributes: {
            payment_method_id: input.paymentMethodId,
            redirect_url: input.redirectUrl,
          },
        },
      }),
    );
    if (resource === null) throw new PayMongoApiError(502, null, 'subscription answer was malformed');
    return resource;
  }

  async cancelSubscription(id: string, reason: string): Promise<void> {
    this.assertId(id);
    await this.request('POST', `/subscriptions/${id}/cancel`, {
      data: { attributes: { cancellation_reason: reason } },
    });
  }

  /** Retry one open invoice. No body: PayMongo charges the subscription's own method. */
  async payInvoice(invoiceId: string): Promise<void> {
    this.assertId(invoiceId);
    await this.request('POST', `/subscriptions/invoices/${invoiceId}/pay`);
  }

  /**
   * Force the next billing cycle. TEST KEYS ONLY -- PayMongo's reference says so, and a live key
   * is refused by the API, not by us. This is what makes "does a month actually renew" a thing
   * that can be observed rather than waited for.
   */
  async triggerTestCycle(id: string): Promise<void> {
    this.assertId(id);
    await this.request('POST', `/subscriptions/${id}/test_cycle`);
  }

  /**
   * A wallet payment method. `type` is the only field sent, which is the entire reason the
   * subscription path is restricted to wallets: there is no `details` object here, so no card
   * number can pass through this process even by mistake.
   */
  async createWalletMethod(type: SubscriptionWallet): Promise<string> {
    const data = await this.request('POST', '/payment_methods', {
      data: { attributes: { type } },
    });
    return this.idOf(data, 'payment method');
  }

  /**
   * Attaching a method to the first invoice's payment intent: the "normal payment flow" the
   * subscriptions guide points at. The redirect in the answer is where the customer authorises,
   * and a successful authorisation is also what vaults the wallet for later cycles.
   */
  async attachPaymentIntent(input: {
    readonly paymentIntentId: string;
    readonly paymentMethodId: string;
    readonly returnUrl: string;
  }): Promise<Record<string, unknown>> {
    this.assertId(input.paymentIntentId);
    this.assertId(input.paymentMethodId);
    const resource = record(
      await this.request('POST', `/payment_intents/${input.paymentIntentId}/attach`, {
        data: {
          attributes: {
            payment_method: input.paymentMethodId,
            return_url: input.returnUrl,
          },
        },
      }),
    );
    if (resource === null)
      throw new PayMongoApiError(502, null, 'payment intent answer was malformed');
    return resource;
  }

  private idOf(data: unknown, what: string): string {
    const id = text(record(data)?.id);
    if (id === null) throw new PayMongoApiError(502, null, `${what} answer carried no id`);
    return id;
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new PayMongoApiError(400, null, 'not a PayMongo resource id');
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: PayMongoHttpResponse;
    try {
      response = await this.http(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PayMongoApiError(0, null, 'PayMongo could not be reached');
    }
    let raw = '';
    try {
      raw = await response.text();
    } catch {
      // An unreadable body is treated as empty.
    }
    const parsed = parseJson(raw);
    if (!response.ok) {
      const error = firstError(parsed);
      throw new PayMongoApiError(
        response.status,
        error.code,
        error.detail ?? `HTTP ${String(response.status)}`,
      );
    }
    return record(parsed)?.data;
  }
}
