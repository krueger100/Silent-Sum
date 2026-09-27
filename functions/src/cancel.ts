/**
 * Cancelling Cloud. For a paid term there is nothing to cancel at PayMongo -- nothing is charged
 * automatically -- so the document simply records that the user does not intend to renew, and
 * the access already paid for runs to its end. For a native PayMongo subscription the provider
 * is told first, and the document follows only once PayMongo has agreed.
 */
import { applySubscriptionEvent, cancelCloudAtPeriodEnd } from './entitlements';
import { BillingFailure, fromPayMongoError } from './errors';
import type { PayMongoClient } from './paymongo/client';
import type { BillingStore } from './store';

export interface CancelDeps {
  readonly store: BillingStore;
  /** Null when this deployment has no PayMongo subscriptions to cancel. */
  readonly paymongo: Pick<PayMongoClient, 'cancelSubscription'> | null;
  readonly now: () => number;
}

export async function cancelCloud(
  deps: CancelDeps,
  input: { readonly uid: string },
): Promise<{ readonly ok: true; readonly accessUntil: number | null }> {
  const current = await deps.store.getEntitlements(input.uid);
  const subscriptionId = current?.cloud.subscriptionId ?? null;

  if (
    current !== null &&
    current.cloud.source === 'subscription' &&
    subscriptionId !== null &&
    current.cloud.status !== 'cancelled'
  ) {
    if (deps.paymongo === null) {
      throw new BillingFailure('failed-precondition', 'Subscriptions are not enabled here.');
    }
    try {
      await deps.paymongo.cancelSubscription(subscriptionId, 'unused');
    } catch (error) {
      throw fromPayMongoError(error);
    }
    const next = await deps.store.updateEntitlements(input.uid, (e) =>
      applySubscriptionEvent(e, {
        kind: 'updated',
        status: 'cancelled',
        subscriptionId,
        now: deps.now(),
      }),
    );
    return { ok: true, accessUntil: next.cloud.accessUntil };
  }

  const next = await deps.store.updateEntitlements(input.uid, (e) =>
    cancelCloudAtPeriodEnd(e, deps.now()),
  );
  return { ok: true, accessUntil: next.cloud.accessUntil };
}
