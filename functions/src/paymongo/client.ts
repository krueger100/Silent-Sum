/**
 * The three PayMongo calls this backend makes, over plain `fetch`.
 *
 * Authentication is HTTP Basic with the secret key as the user name and an empty password. The
 * key arrives through a Firebase secret and is never logged, never put in an error and never
 * sent anywhere but `api.paymongo.com`. Resource ids are interpolated into paths only after a
 * character check, so a value that came from a client can never rewrite the URL.
 */
export interface PayMongoHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type PayMongoFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
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

  async cancelSubscription(id: string, reason: string): Promise<void> {
    this.assertId(id);
    await this.request('POST', `/subscriptions/${id}/cancel`, {
      data: { attributes: { cancellation_reason: reason } },
    });
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new PayMongoApiError(400, null, 'not a PayMongo resource id');
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
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
