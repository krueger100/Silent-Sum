/**
 * Reading PayMongo's JSON:API-shaped payloads without trusting any of it.
 *
 * Every resource is `{ id, type, attributes: {...} }`. A webhook event wraps one in
 * `{ data: { id: "evt_…", attributes: { type, livemode, created_at, data: <resource> } } }`,
 * and an API response wraps one in `{ data: <resource> }`. The readers below accept the
 * resource itself, return null for anything that is not one, and never throw: a malformed
 * body is acknowledged and ignored, never allowed to crash the handler into a retry loop.
 */
export interface WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly createdAt: number | null;
  readonly resource: Record<string, unknown>;
}

export interface PaymentView {
  readonly id: string;
  readonly status: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly metadata: Record<string, string>;
}

export interface CheckoutSessionView {
  readonly id: string;
  readonly status: string | null;
  readonly referenceNumber: string | null;
  readonly metadata: Record<string, string>;
  readonly paymentIntentStatus: string | null;
  readonly payments: readonly PaymentView[];
}

/** The invoice nested inside a subscription: `latest_invoice`, which is not a full invoice. */
export interface LatestInvoiceView {
  readonly id: string | null;
  readonly status: string | null;
  readonly paymentIntentId: string | null;
  readonly paymentIntentStatus: string | null;
}

export interface SubscriptionView {
  readonly id: string;
  readonly status: string | null;
  readonly customerId: string | null;
  /** `next_billing_schedule` (a `YYYY-MM-DD` date) as UTC midnight, epoch ms. */
  readonly nextBillingMs: number | null;
  /**
   * `plan.id`. The subscription resource has no top-level `plan_id`, only a nested `plan`
   * object -- which is why the band a subscription is on is read from here.
   */
  readonly planId: string | null;
  readonly latestInvoice: LatestInvoiceView | null;
  readonly defaultPaymentMethodId: string | null;
  /** `setup_intent.next_action_url`: where a NEW payment method is re-authenticated. */
  readonly setupNextActionUrl: string | null;
}

export interface PaymentIntentView {
  readonly id: string;
  readonly status: string | null;
  /** `next_action.redirect.url` -- present while the status is `awaiting_next_action`. */
  readonly redirectUrl: string | null;
}

export interface InvoiceView {
  readonly id: string;
  readonly status: string | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly subscriptionStatus: string | null;
  readonly nextBillingMs: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Only string values, which is all PayMongo stores; the reserved `PYM_` keys are dropped. */
function stringMap(value: unknown): Record<string, string> {
  const source = record(value);
  const out: Record<string, string> = {};
  if (source === null) return out;
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === 'string' && !key.startsWith('PYM_')) out[key] = entry;
  }
  return out;
}

/** A `YYYY-MM-DD` date as UTC midnight; anything else is null. */
function dateMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** A resource's id and attributes, or null when it is not a resource. */
function resource(value: unknown): { id: string; attributes: Record<string, unknown> } | null {
  const r = record(value);
  if (r === null) return null;
  const id = text(r.id);
  const attributes = record(r.attributes);
  if (id === null || attributes === null) return null;
  return { id, attributes };
}

export function parseWebhookEvent(json: unknown): WebhookEvent | null {
  const envelope = record(json);
  const data = envelope === null ? null : record(envelope.data);
  if (data === null) return null;
  const id = text(data.id);
  const attributes = record(data.attributes);
  if (id === null || attributes === null) return null;
  const type = text(attributes.type);
  const payload = record(attributes.data);
  if (type === null || payload === null) return null;
  const createdAt = integer(attributes.created_at);
  return {
    id,
    type,
    // Absent means live: the safer reading, since a live deployment then demands `li`.
    livemode: attributes.livemode !== false,
    createdAt: createdAt === null ? null : createdAt * 1000,
    resource: payload,
  };
}

export function readPayment(value: unknown): PaymentView | null {
  const r = resource(value);
  if (r === null) return null;
  return {
    id: r.id,
    status: text(r.attributes.status),
    amount: integer(r.attributes.amount),
    currency: text(r.attributes.currency),
    metadata: stringMap(r.attributes.metadata),
  };
}

export function readCheckoutSession(value: unknown): CheckoutSessionView | null {
  const r = resource(value);
  if (r === null) return null;
  const rawPayments = Array.isArray(r.attributes.payments) ? r.attributes.payments : [];
  const payments: PaymentView[] = [];
  for (const entry of rawPayments) {
    const payment = readPayment(entry);
    if (payment !== null) payments.push(payment);
  }
  const intent = resource(r.attributes.payment_intent);
  return {
    id: r.id,
    status: text(r.attributes.status),
    referenceNumber: text(r.attributes.reference_number),
    metadata: stringMap(r.attributes.metadata),
    paymentIntentStatus: intent === null ? null : text(intent.attributes.status),
    payments,
  };
}

export function readSubscription(value: unknown): SubscriptionView | null {
  const r = resource(value);
  if (r === null) return null;
  const invoice = record(r.attributes.latest_invoice);
  const intent = invoice === null ? null : record(invoice.payment_intent);
  const setup = record(r.attributes.setup_intent);
  return {
    id: r.id,
    status: text(r.attributes.status),
    customerId: text(r.attributes.customer_id),
    nextBillingMs: dateMs(r.attributes.next_billing_schedule),
    planId: text(record(r.attributes.plan)?.id),
    latestInvoice:
      invoice === null
        ? null
        : {
            id: text(invoice.id),
            status: text(invoice.status),
            paymentIntentId: text(intent?.id),
            paymentIntentStatus: text(intent?.status),
          },
    defaultPaymentMethodId: text(r.attributes.default_customer_payment_method_id),
    setupNextActionUrl: text(setup?.next_action_url),
  };
}

/**
 * A payment intent, for the one thing the subscription flow needs from it: where to send the
 * customer. Only an https redirect is reported -- a plain-http or relative `next_action` would
 * be PayMongo behaving unlike its documentation, and opening it would be worse than failing.
 */
export function readPaymentIntent(value: unknown): PaymentIntentView | null {
  const r = resource(value);
  if (r === null) return null;
  const action = record(r.attributes.next_action);
  const url = text(record(action?.redirect)?.url);
  return {
    id: r.id,
    status: text(r.attributes.status),
    redirectUrl: url !== null && /^https:\/\//i.test(url) ? url : null,
  };
}

export function readInvoice(value: unknown): InvoiceView | null {
  const r = resource(value);
  if (r === null) return null;
  const nested = record(r.attributes.subscription);
  const subscriptionId = text(nested?.id) ?? text(r.attributes.subscription_id);
  return {
    id: r.id,
    status: text(r.attributes.status),
    customerId: text(r.attributes.customer_id),
    subscriptionId,
    subscriptionStatus: nested === null ? null : text(nested.status),
    nextBillingMs: nested === null ? null : dateMs(nested.next_billing_schedule),
  };
}
