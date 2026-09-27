/**
 * Turning a paid checkout session into an entitlement. The one path, shared by the webhook and
 * by the app's "I have paid" reconciliation, so both are held to the same checks:
 *
 *  1. The session must be one this backend created (`silentsum_billing_refs`), and the uid and
 *     product come from THAT record. The body's metadata may only agree with it, never replace it.
 *  2. The paid amount must equal the server price for the product, in the server currency.
 *  3. The payment is applied through `store.applyPayment`, which is keyed by PayMongo's payment
 *     id and therefore applies each payment once, whatever brought it here.
 */
import { priceFor, type BillingConfig } from './config';
import { extendCloudTerm, grantPro } from './entitlements';
import type { CheckoutSessionView } from './paymongo/events';
import type { BillingStore } from './store';

export interface ApplyDeps {
  readonly store: BillingStore;
  readonly config: BillingConfig;
  readonly now: () => number;
}

export interface ApplyReport {
  /** Payments that changed the entitlements in this call. */
  readonly applied: number;
  /** One `<paymentId>:<result>` per payment in the session, for the event record and the log. */
  readonly results: readonly string[];
}

export async function applyPaidCheckout(
  deps: ApplyDeps,
  input: {
    readonly session: CheckoutSessionView;
    readonly eventId: string | null;
    readonly source: 'webhook' | 'sync';
  },
): Promise<ApplyReport> {
  const { session } = input;
  const results: string[] = [];
  let applied = 0;

  const ref = await deps.store.getRef(session.id);
  if (ref === null || ref.kind !== 'checkout') {
    for (const payment of session.payments) results.push(`${payment.id}:rejected-ref`);
    return { applied, results };
  }
  const claimedUid = session.metadata.uid;
  const claimedProduct = session.metadata.product;
  if (
    (claimedUid !== undefined && claimedUid !== ref.uid) ||
    (claimedProduct !== undefined && claimedProduct !== ref.product)
  ) {
    for (const payment of session.payments) results.push(`${payment.id}:rejected-metadata`);
    return { applied, results };
  }

  const price = priceFor(deps.config, ref.product);
  for (const payment of session.payments) {
    if (payment.status !== 'paid') {
      results.push(`${payment.id}:skipped-${payment.status ?? 'unknown'}`);
      continue;
    }
    if (
      payment.amount !== price ||
      (payment.currency ?? '').toUpperCase() !== deps.config.currency
    ) {
      results.push(`${payment.id}:rejected-amount`);
      continue;
    }

    const now = deps.now();
    // The ledger label is decided from a read; the transaction below still decides what is
    // applied. A label that is a moment stale is informational, an entitlement never is.
    const before = await deps.store.getEntitlements(ref.uid);
    const outcome =
      ref.product === 'cloud'
        ? 'cloud_extended'
        : before?.pro === true
          ? 'pro_already'
          : 'pro_granted';

    const result = await deps.store.applyPayment({
      uid: ref.uid,
      record: {
        paymentId: payment.id,
        uid: ref.uid,
        product: ref.product,
        amountCentavos: payment.amount,
        currency: deps.config.currency,
        checkoutSessionId: session.id,
        eventId: input.eventId,
        source: input.source,
        paidAt: now,
        appliedAt: now,
        outcome,
      },
      mutate: (current) => {
        if (ref.product === 'pro') {
          const granted = grantPro(current, { paymentId: payment.id, now });
          return granted.changed ? granted.next : null;
        }
        return extendCloudTerm(current, { now, termDays: deps.config.cloudTermDays });
      },
    });

    if (result === 'applied') applied += 1;
    results.push(`${payment.id}:${result}`);
    await deps.store.updateRef(ref.id, { status: 'paid', paidAt: now, paymentId: payment.id });
  }

  return { applied, results };
}
