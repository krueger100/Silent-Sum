/**
 * PayMongo's webhook, without Express: the HTTP function in `index.ts` hands in the raw body and
 * the signature header and sends back whatever this returns.
 *
 * Order of checks, and why each comes where it does:
 *  1. Parse. A body that is not an event is answered 400 and never recorded.
 *  2. Verify the signature over the RAW bytes, against the signature for the event's own mode.
 *     Anything that fails is 400 and never recorded: an unsigned body must leave no trace.
 *  3. Drop events from the other mode (test events at a live deployment and vice versa) with a
 *     200, so PayMongo does not keep retrying something that will never be wanted.
 *  4. Record the event id. A redelivery is answered 200 and does nothing.
 *  5. Apply. A processing failure is answered 500 so PayMongo retries; the event is marked
 *     `error`, which is what lets that retry run again.
 */
import { applyPaidCheckout } from './apply';
import type { BillingConfig } from './config';
import { applySubscriptionEvent, type SubscriptionEventKind } from './entitlements';
import {
  parseWebhookEvent,
  readCheckoutSession,
  readInvoice,
  readSubscription,
  type WebhookEvent,
} from './paymongo/events';
import { verifyWebhookSignature } from './paymongo/signature';
import type { BillingStore } from './store';

export interface WebhookDeps {
  readonly store: BillingStore;
  readonly config: BillingConfig;
  readonly webhookSecret: string;
  readonly now: () => number;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface WebhookRequest {
  readonly rawBody: Buffer | string;
  readonly signatureHeader: string | undefined;
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const ok = (outcome: string): WebhookResponse => ({
  status: 200,
  body: { received: true, outcome },
});
const bad = (error: string): WebhookResponse => ({ status: 400, body: { error } });

export async function handleWebhook(
  deps: WebhookDeps,
  req: WebhookRequest,
): Promise<WebhookResponse> {
  const log = deps.log ?? (() => undefined);
  const raw = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return bad('malformed');
  }
  const event = parseWebhookEvent(json);
  if (event === null) return bad('malformed');

  const verdict = verifyWebhookSignature({
    header: req.signatureHeader,
    rawBody: req.rawBody,
    secret: deps.webhookSecret,
    livemode: event.livemode,
    nowSeconds: Math.floor(deps.now() / 1000),
  });
  if (verdict !== 'ok') {
    log('webhook rejected', { verdict, eventId: event.id, type: event.type });
    return bad('invalid-signature');
  }

  if (event.livemode !== deps.config.livemode) {
    log('webhook ignored: other mode', { eventId: event.id, livemode: event.livemode });
    return ok('ignored-mode');
  }

  const begun = await deps.store.beginEvent({
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    receivedAt: deps.now(),
  });
  if (begun === 'duplicate') return ok('duplicate');

  let outcome: string;
  try {
    outcome = await dispatch(deps, event, log);
  } catch (error) {
    log('webhook processing failed', { eventId: event.id, type: event.type, error: String(error) });
    await deps.store.finishEvent(event.id, 'error', deps.now()).catch(() => undefined);
    return { status: 500, body: { error: 'processing-failed' } };
  }
  await deps.store.finishEvent(event.id, outcome, deps.now());
  log('webhook processed', { eventId: event.id, type: event.type, outcome });
  return ok(outcome);
}

async function dispatch(
  deps: WebhookDeps,
  event: WebhookEvent,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<string> {
  switch (event.type) {
    case 'checkout_session.payment.paid': {
      const session = readCheckoutSession(event.resource);
      if (session === null) return 'ignored-malformed';
      const report = await applyPaidCheckout(
        { store: deps.store, config: deps.config, now: deps.now },
        { session, eventId: event.id, source: 'webhook' },
      );
      log('checkout applied', {
        eventId: event.id,
        sessionId: session.id,
        results: report.results,
      });
      return `applied:${String(report.applied)}`;
    }
    case 'payment.failed':
      // Informational. The app learns of it through "I have paid", which asks PayMongo directly.
      return 'noted-failure';
    case 'payment.paid':
      // The checkout event carries the same payment with the session it belongs to; this one is
      // not needed, and applying it too would only ever hit the ledger's duplicate check.
      return 'ignored';
    case 'subscription.invoice.paid':
    case 'subscription.invoice.payment_failed': {
      const invoice = readInvoice(event.resource);
      if (invoice === null || invoice.subscriptionId === null) return 'ignored-malformed';
      const kind: SubscriptionEventKind =
        event.type === 'subscription.invoice.paid' ? 'invoice.paid' : 'invoice.payment_failed';
      return applySubscription(deps, invoice.subscriptionId, kind, {
        periodEndMs: invoice.nextBillingMs,
        status: invoice.subscriptionStatus,
      });
    }
    case 'subscription.past_due':
    case 'subscription.unpaid':
    case 'subscription.updated': {
      const subscription = readSubscription(event.resource);
      if (subscription === null) return 'ignored-malformed';
      const kind = event.type.slice('subscription.'.length) as 'past_due' | 'unpaid' | 'updated';
      return applySubscription(deps, subscription.id, kind, {
        periodEndMs: subscription.nextBillingMs,
        status: subscription.status,
      });
    }
    default:
      return 'ignored';
  }
}

async function applySubscription(
  deps: WebhookDeps,
  subscriptionId: string,
  kind: SubscriptionEventKind,
  detail: { readonly periodEndMs: number | null; readonly status: string | null },
): Promise<string> {
  const ref = await deps.store.getRef(subscriptionId);
  if (ref === null || ref.kind !== 'subscription') return 'ignored-unknown-subscription';
  await deps.store.updateEntitlements(ref.uid, (current) =>
    applySubscriptionEvent(current, {
      kind,
      subscriptionId,
      status: detail.status,
      periodEndMs: detail.periodEndMs,
      now: deps.now(),
    }),
  );
  return `subscription:${kind}`;
}
