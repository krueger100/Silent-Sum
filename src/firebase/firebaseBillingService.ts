/**
 * `BillingService` over the SilentSum Cloud Functions.
 *
 * Four callables, all of which require a signed-in backup account, because that account is the
 * only identity entitlements can be filed under. The PayMongo secret never comes near this file:
 * the functions hold it, create the hosted checkout or the subscription, and answer with a URL.
 *
 * Every failure is translated into a `BillingError` code the screens have copy for. One
 * translation deserves a note: a callable refuses with `unauthenticated` both when there is no
 * user and when App Check rejects the build. The two need different sentences, and the client
 * can tell them apart -- it knows whether anyone is signed in -- so it does.
 */
import {
  BillingError,
  type BillingService,
  type CheckoutOutcome,
  type CheckoutStart,
  type SubscriptionStart,
} from '@/billing/billingService';
import type { ProductId } from '@/billing/products';
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import type { CloudUser } from '@/firebase/types';

/** The deployed function names. Keep in step with `functions/src/index.ts`. */
export const BILLING_FUNCTIONS = {
  createCheckout: 'silentsumCreateCheckout',
  startCloudSubscription: 'silentsumStartCloudSubscription',
  syncCheckout: 'silentsumSyncCheckout',
  cancelCloud: 'silentsumCancelCloud',
} as const;

const OUTCOMES: readonly CheckoutOutcome[] = ['paid', 'pending', 'expired', 'failed', 'unknown'];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The `reason` a `failed-precondition` carried, if it carried one.
 *
 * One callable error code covers several different situations, and the backend distinguishes
 * them in `details.reason` rather than in prose -- so this is how "Pro is already owned" is told
 * apart from "there is no e-mail on the account", which need completely different sentences.
 */
function reasonOf(details: unknown): string | null {
  const reason =
    typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>).reason
      : undefined;
  return typeof reason === 'string' && reason !== '' ? reason : null;
}

function fromPrecondition(error: CallableError): BillingError {
  switch (reasonOf(error.details)) {
    case 'already-subscribed':
      return new BillingError('already-subscribed', error.message);
    case 'no-email':
      return new BillingError('no-email', error.message);
    // Both mean this deployment cannot take a subscription today: PayMongo has not enabled the
    // feature, or there is no bucket to measure. The one-off term still works.
    case 'storage-unmeasured':
      return new BillingError('unsupported', error.message);
    default:
      return new BillingError('already-owned', error.message);
  }
}

function toBillingError(error: unknown, signedIn: boolean): BillingError {
  if (error instanceof BillingError) return error;
  if (!(error instanceof CallableError)) return new BillingError('unknown');
  switch (error.code) {
    case 'unauthenticated':
      return new BillingError(signedIn ? 'app-check' : 'unauthenticated', error.message);
    case 'failed-precondition':
      return fromPrecondition(error);
    case 'not-found':
      // The callable is not deployed: an older backend than this build expects.
      return new BillingError('unsupported', error.message);
    case 'invalid-argument':
      return new BillingError('invalid-argument', error.message);
    case 'permission-denied':
      return new BillingError('permission-denied', error.message);
    case 'unavailable':
    case 'deadline-exceeded':
      return new BillingError('unavailable', error.message);
    case 'internal':
      return new BillingError('internal', error.message);
    default:
      return new BillingError('unknown', error.message);
  }
}

export class FirebaseBillingService implements BillingService {
  constructor(
    private readonly invoker: CallableInvoker,
    private readonly currentUser: () => CloudUser | null,
  ) {}

  /** Where the calls go, for diagnostics; never shown to the user. */
  get endpoint(): string | null {
    const invoker = this.invoker as { baseUrl?: unknown };
    return typeof invoker.baseUrl === 'string' ? invoker.baseUrl : null;
  }

  async createCheckout(product: ProductId): Promise<CheckoutStart> {
    this.requireUser();
    const answer = asRecord(await this.invoke(BILLING_FUNCTIONS.createCheckout, { product }));
    const checkoutId = answer.checkoutId;
    const checkoutUrl = answer.checkoutUrl;
    if (
      typeof checkoutId !== 'string' ||
      checkoutId === '' ||
      typeof checkoutUrl !== 'string' ||
      !/^https:\/\//i.test(checkoutUrl)
    ) {
      // Only an https page from the backend is ever opened; anything else is a broken deploy.
      throw new BillingError('internal', 'the backend returned no hosted checkout');
    }
    return { checkoutId, checkoutUrl };
  }

  /**
   * One monthly Cloud subscription. The band and the price are the SERVER's, measured from what
   * the vault holds; nothing about them is sent, and the empty body is deliberate.
   *
   * PayMongo refusing because Subscriptions are not enabled on the merchant account reaches the
   * client as `internal` (the backend's `fromPayMongoError` maps a provider refusal to it), and
   * `internal` is reported as `unsupported` HERE rather than as a crash, because the caller's
   * right move is to fall back to a one-off term rather than to show an error.
   */
  async startCloudSubscription(): Promise<SubscriptionStart> {
    this.requireUser();
    let answer: Record<string, unknown>;
    try {
      answer = asRecord(await this.invoke(BILLING_FUNCTIONS.startCloudSubscription, {}));
    } catch (error) {
      if (error instanceof BillingError && error.code === 'internal') {
        throw new BillingError('unsupported', error.message);
      }
      throw error;
    }
    const subscriptionId = answer.subscriptionId;
    const authorizeUrl = answer.authorizeUrl;
    const priceCentavos = answer.priceCentavos;
    const bandLabel = answer.bandLabel;
    if (
      typeof subscriptionId !== 'string' ||
      subscriptionId === '' ||
      typeof authorizeUrl !== 'string' ||
      !/^https:\/\//i.test(authorizeUrl) ||
      typeof priceCentavos !== 'number' ||
      !Number.isFinite(priceCentavos) ||
      priceCentavos <= 0 ||
      typeof bandLabel !== 'string' ||
      bandLabel === ''
    ) {
      // Only an https page from the backend is ever opened, and a price of zero or NaN would be
      // shown to somebody as what they are about to pay.
      throw new BillingError('internal', 'the backend returned no authorisation page');
    }
    return { subscriptionId, authorizeUrl, priceCentavos, bandLabel };
  }

  async syncCheckout(checkoutId: string): Promise<CheckoutOutcome> {
    this.requireUser();
    const answer = asRecord(await this.invoke(BILLING_FUNCTIONS.syncCheckout, { checkoutId }));
    const outcome = answer.outcome;
    return typeof outcome === 'string' && (OUTCOMES as readonly string[]).includes(outcome)
      ? (outcome as CheckoutOutcome)
      : 'unknown';
  }

  async cancelCloud(): Promise<void> {
    this.requireUser();
    await this.invoke(BILLING_FUNCTIONS.cancelCloud, {});
  }

  private requireUser(): void {
    if (this.currentUser() === null) throw new BillingError('unauthenticated');
  }

  private async invoke(name: string, data: unknown): Promise<unknown> {
    try {
      return await this.invoker.call<unknown>(name, data);
    } catch (error) {
      throw toBillingError(error, this.currentUser() !== null);
    }
  }
}
