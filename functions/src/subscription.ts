/**
 * Starting and re-pricing a native PayMongo subscription for Cloud.
 *
 * This is the half that was missing. `webhook.ts` has always understood subscription events and
 * `cancel.ts` has always known how to cancel one, but nothing ever CREATED one -- so
 * `cloud.source` was `'term'` on every account, every subscription branch was unreachable, and
 * the screen's "renews automatically" state could never be true. The calls below are the ones
 * PayMongo's reference documents, in the order its subscriptions guide gives them.
 *
 * WHAT IS CHARGED, AND BY WHOM. The amount lives in the PLAN, and a plan is created here from
 * `bands.ts` against a storage figure measured here (`storageMeter.ts`). Nothing in a client
 * request influences the price: the only input is a uid, taken from the verified auth token.
 *
 * WHY MAYA AND NOT CARDS. PayMongo supports both for subscriptions, but a card subscription
 * needs the card vaulted, and vaulting means `card_number`, `exp_month`, `exp_year` and `cvc`
 * passing through this process -- PCI DSS scope for SilentSum's servers. A Maya payment method
 * is created from its `type` alone. See `SubscriptionWallet` in `paymongo/client.ts`.
 *
 * THE ONE-CYCLE LAG. PayMongo applies a plan change from the next billing cycle, so a vault that
 * grows into a higher band is charged the old band once more and the new one thereafter. That is
 * a known revenue lag, bounded by the hard ceiling on additions (`CLOUD_CEILING_BYTES`): the
 * worst case is one month of a 512 GB vault billed at 64 GB, about $6.
 */
import { bandFor, planKey, planName, type CloudBand } from './bands';
import type { BillingConfig } from './config';
import { BillingFailure, fromPayMongoError } from './errors';
import type { PayMongoClient } from './paymongo/client';
import { readPaymentIntent, readSubscription, type SubscriptionView } from './paymongo/events';
import type { StorageMeter } from './storageMeter';
import type { BillingStore } from './store';

/** The subscription statuses that mean "this account already has one; do not make another". */
const LIVE_STATUSES: readonly string[] = ['incomplete', 'active', 'past_due', 'unpaid'];

/**
 * PayMongo requires a first and last name on a customer. SilentSum does not know either, and
 * asking would collect an identifier the product exists not to hold, so a fixed pair is sent.
 * The e-mail is the account's own, which PayMongo needs to reach the customer about a failed
 * charge and which the account already proved it controls by signing in.
 */
const CUSTOMER_FIRST_NAME = 'SilentSum';
const CUSTOMER_LAST_NAME = 'Subscriber';

export type SubscriptionPayMongo = Pick<
  PayMongoClient,
  | 'createPlan'
  | 'createCustomer'
  | 'createSubscription'
  | 'createWalletMethod'
  | 'attachPaymentIntent'
  | 'changeSubscriptionPlan'
  | 'retrieveSubscription'
>;

export interface SubscriptionDeps {
  readonly store: BillingStore;
  readonly paymongo: SubscriptionPayMongo;
  readonly meter: StorageMeter;
  readonly config: BillingConfig;
  readonly now: () => number;
  readonly returnUrl: (outcome: 'success' | 'cancel') => string;
  /** The account's e-mail from Firebase Auth; null when the account has none. */
  readonly accountEmail: (uid: string) => Promise<string | null>;
}

export interface SubscriptionStart {
  readonly subscriptionId: string;
  /** The page the customer authorises on. The app opens it; nothing is charged before that. */
  readonly authorizeUrl: string;
  readonly priceCentavos: number;
  readonly bandLabel: string;
  readonly storedBytes: number;
}

/**
 * One Cloud subscription, from nothing to a page the customer can authorise on.
 *
 * The order matters. The plan and the customer are created (or reused) before the subscription,
 * because the subscription body needs both ids; the local reference is written the instant the
 * subscription exists, because PayMongo begins emitting events for it immediately; and the
 * payment method is attached last, because that is the step that asks a human for money.
 */
export async function startCloudSubscription(
  deps: SubscriptionDeps,
  input: { readonly uid: string },
): Promise<SubscriptionStart> {
  const current = await deps.store.getEntitlements(input.uid);
  const existing = current?.cloud ?? null;
  if (
    existing !== null &&
    existing.source === 'subscription' &&
    existing.subscriptionId !== null &&
    !existing.cancelAtPeriodEnd &&
    existing.status !== 'none'
  ) {
    throw new BillingFailure('failed-precondition', 'Cloud already renews on this account.', {
      reason: 'already-subscribed',
    });
  }

  const storedBytes = await deps.meter.measure(input.uid);
  if (storedBytes === null) {
    // No bucket configured means no measurement, and an unmeasured vault cannot be priced.
    // Guessing a band here would be guessing at somebody's bill.
    throw new BillingFailure('failed-precondition', 'Cloud subscriptions are not enabled here.', {
      reason: 'storage-unmeasured',
    });
  }
  const band = bandFor(storedBytes);

  const email = await deps.accountEmail(input.uid);
  if (email === null || email === '') {
    throw new BillingFailure('failed-precondition', 'Add an e-mail to your account first.', {
      reason: 'no-email',
    });
  }

  let planId: string;
  let customerId: string;
  let subscription: SubscriptionView;
  try {
    planId = await ensurePlan(deps, band);
    customerId = await ensureCustomer(deps, input.uid, email);
    const resource = await deps.paymongo.createSubscription({ customerId, planId });
    const parsed = readSubscription(resource);
    if (parsed === null) {
      throw new BillingFailure('internal', 'The payment provider refused the request.');
    }
    subscription = parsed;
  } catch (error) {
    throw fromPayMongoError(error);
  }

  // Before the attach, and before anything is charged: an event that arrives in the next second
  // has to be able to find the account it belongs to.
  await deps.store.putRef({
    kind: 'subscription',
    id: subscription.id,
    uid: input.uid,
    createdAt: deps.now(),
  });

  const paymentIntentId = subscription.latestInvoice?.paymentIntentId ?? null;
  if (paymentIntentId === null) {
    throw new BillingFailure('internal', 'The payment provider refused the request.', {
      reason: 'no-first-invoice',
    });
  }

  let authorizeUrl: string;
  try {
    const methodId = await deps.paymongo.createWalletMethod('paymaya');
    const attached = await deps.paymongo.attachPaymentIntent({
      paymentIntentId,
      paymentMethodId: methodId,
      returnUrl: deps.returnUrl('success'),
    });
    const intent = readPaymentIntent(attached);
    if (intent === null || intent.redirectUrl === null) {
      throw new BillingFailure('internal', 'The payment provider refused the request.', {
        reason: 'no-authorization-page',
      });
    }
    authorizeUrl = intent.redirectUrl;
  } catch (error) {
    throw fromPayMongoError(error);
  }

  return {
    subscriptionId: subscription.id,
    authorizeUrl,
    priceCentavos: band.priceCentavos,
    bandLabel: band.label,
    storedBytes,
  };
}

export type RerateOutcome = 'unchanged' | 'moved' | 'unmeasured' | 'not-subscribed';

/**
 * Put a live subscription on the band its vault now belongs in.
 *
 * Called when a period is paid for, which is the moment the next period's price is decided. The
 * plan is only swapped when the band actually differs, so the ordinary case is one measurement
 * and one read; and a measurement that cannot be taken leaves the price alone rather than
 * falling back to a band nobody chose.
 */
export async function rerateCloudSubscription(
  deps: SubscriptionDeps,
  input: { readonly uid: string; readonly subscriptionId: string },
): Promise<RerateOutcome> {
  const storedBytes = await deps.meter.measure(input.uid);
  if (storedBytes === null) return 'unmeasured';
  const band = bandFor(storedBytes);

  const subscription = readSubscription(
    await deps.paymongo.retrieveSubscription(input.subscriptionId),
  );
  if (subscription === null) return 'not-subscribed';
  if (subscription.status !== null && !LIVE_STATUSES.includes(subscription.status)) {
    // Cancelled, or never completed: there is no next cycle to price.
    return 'not-subscribed';
  }

  const planId = await ensurePlan(deps, band);
  if (subscription.planId === planId) return 'unchanged';
  await deps.paymongo.changeSubscriptionPlan(input.subscriptionId, planId);
  return 'moved';
}

/** The band's plan, created once per price per mode and remembered. */
async function ensurePlan(deps: SubscriptionDeps, band: CloudBand): Promise<string> {
  const key = planKey(band, deps.config.currency, deps.config.livemode);
  const cached = await deps.store.getPlanId(key);
  if (cached !== null) return cached;
  const planId = await deps.paymongo.createPlan({
    name: planName(band),
    description: deps.config.taglines.cloud,
    amountCentavos: band.priceCentavos,
    currency: deps.config.currency,
    interval: 'monthly',
    intervalCount: 1,
    metadata: { band: band.label },
  });
  await deps.store.putPlanId(key, planId, deps.now());
  return planId;
}

/**
 * The account's PayMongo customer, created once and reused for every later subscription.
 *
 * Reuse is not an optimisation. A second customer for the same account would hold a second
 * vaulted wallet and a second billing history, and `email` is the only thing tying them
 * together -- so an account that cancels and resubscribes must come back as the same customer.
 *
 * Both directions are recorded: uid -> customer id so this lookup works, and customer id -> uid
 * as an ordinary `BillingRef` so a webhook naming only a customer can still find the account.
 */
async function ensureCustomer(
  deps: SubscriptionDeps,
  uid: string,
  email: string,
): Promise<string> {
  const known = await deps.store.getCustomerId(uid);
  if (known !== null) return known;
  const customerId = await deps.paymongo.createCustomer({
    firstName: CUSTOMER_FIRST_NAME,
    lastName: CUSTOMER_LAST_NAME,
    email,
    metadata: { uid },
  });
  await deps.store.putCustomerId(uid, customerId, deps.now());
  await deps.store.putRef({ kind: 'customer', id: customerId, uid, createdAt: deps.now() });
  return customerId;
}
