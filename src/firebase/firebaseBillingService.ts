/**
 * `BillingService` over the SilentSum Cloud Functions.
 *
 * Three callables, all of which require a signed-in backup account, because that account is the
 * only identity entitlements can be filed under. The PayMongo secret never comes near this file:
 * the functions hold it, create the hosted checkout, and answer with a URL.
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
} from '@/billing/billingService';
import type { ProductId } from '@/billing/products';
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import type { CloudUser } from '@/firebase/types';

/** The deployed function names. Keep in step with `functions/src/index.ts`. */
export const BILLING_FUNCTIONS = {
  createCheckout: 'silentsumCreateCheckout',
  syncCheckout: 'silentsumSyncCheckout',
  cancelCloud: 'silentsumCancelCloud',
} as const;

const OUTCOMES: readonly CheckoutOutcome[] = ['paid', 'pending', 'expired', 'failed', 'unknown'];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function toBillingError(error: unknown, signedIn: boolean): BillingError {
  if (error instanceof BillingError) return error;
  if (!(error instanceof CallableError)) return new BillingError('unknown');
  switch (error.code) {
    case 'unauthenticated':
      return new BillingError(signedIn ? 'app-check' : 'unauthenticated', error.message);
    case 'failed-precondition':
      return new BillingError('already-owned', error.message);
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
