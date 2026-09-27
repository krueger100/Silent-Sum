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
import { CLOUD_TERM_DAYS, type ProductId } from '@/billing/products';
import type { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import type { Clock } from '@/utils/clock';

export type BillingErrorCode =
  /** No signed-in backup account: entitlements have nothing to be filed under. */
  | 'unauthenticated'
  /** Signed in, but the server would not accept this build as genuine (App Check). */
  | 'app-check'
  /** No network, or the backend is unreachable. */
  | 'unavailable'
  /** Pro is already on this account. */
  | 'already-owned'
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

export interface BillingService {
  /** Throws `BillingError`; never returns a page for a product the account already has. */
  createCheckout(product: ProductId): Promise<CheckoutStart>;
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

/**
 * Backend and payment provider in one, for tests and for exercising the screens without a
 * Firebase project. It writes the same document, with the same transitions, that
 * `functions/src/entitlements.ts` performs on the server.
 */
export class InMemoryBillingService implements BillingService {
  readonly checkouts = new Map<string, SimulatedCheckout>();

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
