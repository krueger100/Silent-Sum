/**
 * How the app buys things: the contract, its errors, and a simulator for tests.
 *
 * The app never talks to PayMongo. It asks the backend (a Cloud Function) for a hosted checkout
 * page, opens that page in the browser, and then WATCHES its own entitlement document for the
 * change the backend makes once PayMongo's webhook confirms the payment. There is no "the client
 * says it paid" call anywhere: `syncCheckout` asks the backend to look at PayMongo's record of
 * the session, which is the same authoritative source the webhook uses.
 *
 * `InMemoryBillingService` stands in for the backend AND for PayMongo in tests: `createCheckout`
 * hands back a fake page, and `completePayment` does what the real webhook does -- it writes the
 * entitlement document with an admin write that bypasses the owner rules, exactly as the Admin
 * SDK does on the server.
 */
import {
  BILLING_PATHS,
  entitlementsToJson,
  parseEntitlements,
  type Entitlements,
} from '@/billing/entitlements';
import { CLOUD_BANDS, bandFor } from '@/billing/entitlements';
import { CLOUD_TERM_DAYS, type ProductId } from '@/billing/products';
import type { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import type { Clock } from '@/utils/clock';

/**
 * Days of access past a subscription period end, mirroring `SUBSCRIPTION_GRACE_DAYS` in
 * `functions/src/entitlements.ts`.
 *
 * Only the simulator needs it: the real value never crosses the wire, because the server writes
 * `accessUntil` and the app only ever reads it. It is here so a screen driven by the double
 * shows the same dates it will show against the real backend.
 */
const SUBSCRIPTION_GRACE_DAYS = 3;

export type BillingErrorCode =
  /** No signed-in backup account: entitlements have nothing to be filed under. */
  | 'unauthenticated'
  /** Signed in, but the server would not accept this build as genuine (App Check). */
  | 'app-check'
  /** No network, or the backend is unreachable. */
  | 'unavailable'
  /** Pro is already on this account. */
  | 'already-owned'
  /** Cloud already renews on this account; there is nothing to subscribe to. */
  | 'already-subscribed'
  /**
   * This deployment cannot take a subscription -- PayMongo has not enabled Subscriptions on the
   * merchant account, or the backend has no bucket to measure. The one-off term still works, so
   * callers treat this as "use the other path", not as a dead end.
   */
  | 'unsupported'
  /** PayMongo requires an e-mail on a customer and the account has none. */
  | 'no-email'
  | 'invalid-argument'
  | 'permission-denied'
  | 'internal'
  | 'unknown';

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message?: string,
  ) {
    super(message ? `BillingError(${code}: ${message})` : `BillingError(${code})`);
    this.name = 'BillingError';
  }
}

export interface CheckoutStart {
  /** The PayMongo checkout session id, for `syncCheckout`. */
  readonly checkoutId: string;
  /** The hosted page to open in the browser. */
  readonly checkoutUrl: string;
}

export type CheckoutOutcome = 'paid' | 'pending' | 'expired' | 'failed' | 'unknown';

/**
 * A started PayMongo subscription, waiting on the customer to authorise its first charge.
 *
 * `priceCentavos` and `bandLabel` come from the SERVER's measurement of what the vault holds.
 * They are reported back so the screen can say what is about to be charged and for which band,
 * rather than repeating the headline price of the cheapest one.
 */
export interface SubscriptionStart {
  readonly subscriptionId: string;
  /** The https page where the first charge is authorised. Nothing is charged before that. */
  readonly authorizeUrl: string;
  readonly priceCentavos: number;
  readonly bandLabel: string;
}

export interface BillingService {
  /** Throws `BillingError`; never returns a page for a product the account already has. */
  createCheckout(product: ProductId): Promise<CheckoutStart>;
  /**
   * Starts a monthly Cloud subscription: the thing that makes Cloud renew on its own.
   *
   * Throws `BillingError('unsupported')` where the backend cannot take one, which is the signal
   * to fall back to a one-off term through `createCheckout`. Nothing is charged until the
   * customer authorises on the page in the answer.
   */
  startCloudSubscription(): Promise<SubscriptionStart>;
  /** Asks the backend to reconcile a session with PayMongo, for when the webhook is late. */
  syncCheckout(checkoutId: string): Promise<CheckoutOutcome>;
  /** Stops Cloud from renewing. Access lasts to the end of the paid period. */
  cancelCloud(): Promise<void>;
}

const DAY_MS = 86_400_000;

interface SimulatedCheckout {
  readonly uid: string;
  readonly product: ProductId;
  outcome: CheckoutOutcome;
}

interface SimulatedSubscription {
  readonly uid: string;
  readonly priceCentavos: number;
  readonly bandLabel: string;
  authorized: boolean;
}

/**
 * Backend and payment provider in one, for tests and for exercising the screens without a
 * Firebase project. It writes the same document, with the same transitions, that
 * `functions/src/entitlements.ts` performs on the server.
 */
export class InMemoryBillingService implements BillingService {
  readonly checkouts = new Map<string, SimulatedCheckout>();

  readonly subscriptions = new Map<string, SimulatedSubscription>();

  /**
   * What the server would measure, and whether it can take a subscription at all.
   *
   * Both are settable because both decide something the screens have to render: the band, and
   * whether the subscription path exists or the one-off term is all there is. This is also the
   * ONLY place a subscription is ever simulated -- a real account's billing documents are never
   * written to make a button change state.
   */
  storedBytes = 0;

  subscriptionsSupported = true;

  private counter = 0;

  constructor(
    private readonly cloud: InMemoryCloudBackend,
    private readonly clock: Clock,
  ) {}

  async createCheckout(product: ProductId): Promise<CheckoutStart> {
    const uid = this.requireUid();
    if (product === 'pro' && this.read(uid).pro) throw new BillingError('already-owned');
    this.counter += 1;
    const checkoutId = `cs_test_${String(this.counter).padStart(4, '0')}`;
    this.checkouts.set(checkoutId, { uid, product, outcome: 'pending' });
    return { checkoutId, checkoutUrl: `https://checkout.paymongo.test/${checkoutId}` };
  }

  async startCloudSubscription(): Promise<SubscriptionStart> {
    const uid = this.requireUid();
    if (!this.subscriptionsSupported) throw new BillingError('unsupported');
    const current = this.read(uid);
    if (
      current.cloud.source === 'subscription' &&
      current.cloud.status !== 'none' &&
      !current.cloud.cancelAtPeriodEnd
    ) {
      throw new BillingError('already-subscribed');
    }
    const band = bandFor(this.storedBytes) ?? CLOUD_BANDS[CLOUD_BANDS.length - 1];
    if (band === undefined) throw new BillingError('internal');
    this.counter += 1;
    const subscriptionId = `sub_test_${String(this.counter).padStart(4, '0')}`;
    this.subscriptions.set(subscriptionId, {
      uid,
      priceCentavos: band.priceCentavos,
      bandLabel: band.label,
      authorized: false,
    });
    return {
      subscriptionId,
      authorizeUrl: `https://auth.paymongo.test/${subscriptionId}`,
      priceCentavos: band.priceCentavos,
      bandLabel: band.label,
    };
  }

  /**
   * What authorising the first charge and the `subscription.invoice.paid` webhook amount to.
   *
   * Mirrors `applySubscriptionEvent` on the server for the `invoice.paid` case, including the
   * three grace days past the period end, so a screen driven by this double behaves the way it
   * will behave against the real backend.
   */
  completeSubscription(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription === undefined) throw new Error(`no such subscription: ${subscriptionId}`);
    subscription.authorized = true;
    const now = this.clock.now();
    const current = this.read(subscription.uid);
    const periodEnd = now + CLOUD_TERM_DAYS * DAY_MS;
    this.write(subscription.uid, {
      ...current,
      cloud: {
        status: 'active',
        accessUntil: periodEnd + SUBSCRIPTION_GRACE_DAYS * DAY_MS,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        source: 'subscription',
        subscriptionId,
      },
      updatedAt: now,
    });
  }

  async syncCheckout(checkoutId: string): Promise<CheckoutOutcome> {
    const uid = this.requireUid();
    const checkout = this.checkouts.get(checkoutId);
    return checkout === undefined || checkout.uid !== uid ? 'unknown' : checkout.outcome;
  }

  async cancelCloud(): Promise<void> {
    const uid = this.requireUid();
    const current = this.read(uid);
    this.write(uid, {
      ...current,
      cloud: { ...current.cloud, status: 'cancelled', cancelAtPeriodEnd: true },
      updatedAt: this.clock.now(),
    });
  }

  /** What PayMongo paying and the webhook firing amount to: the entitlement document changes. */
  completePayment(checkoutId: string): void {
    const checkout = this.checkouts.get(checkoutId);
    if (checkout === undefined) throw new Error(`no such checkout: ${checkoutId}`);
    checkout.outcome = 'paid';
    const now = this.clock.now();
    const current = this.read(checkout.uid);
    if (checkout.product === 'pro') {
      this.write(checkout.uid, {
        ...current,
        pro: true,
        proSince: current.pro ? current.proSince : now,
        updatedAt: now,
      });
      return;
    }
    const start = Math.max(now, current.cloud.accessUntil ?? now);
    const end = start + CLOUD_TERM_DAYS * DAY_MS;
    this.write(checkout.uid, {
      ...current,
      cloud: {
        ...current.cloud,
        status: 'active',
        accessUntil: end,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: false,
        source: 'term',
      },
      updatedAt: now,
    });
  }

  failPayment(checkoutId: string): void {
    const checkout = this.checkouts.get(checkoutId);
    if (checkout === undefined) throw new Error(`no such checkout: ${checkoutId}`);
    checkout.outcome = 'failed';
  }

  private read(uid: string): Entitlements {
    return parseEntitlements(this.cloud.documents.get(BILLING_PATHS.entitlements(uid)) ?? null);
  }

  private write(uid: string, entitlements: Entitlements): void {
    this.cloud.adminPutDocument(BILLING_PATHS.entitlements(uid), entitlementsToJson(entitlements));
  }

  private requireUid(): string {
    const user = this.cloud.currentUser;
    if (user === null) throw new BillingError('unauthenticated');
    return user.uid;
  }
}
