import { BILLING_PATHS, cloudActive, parseEntitlements } from '@/billing/entitlements';
import { BillingError, InMemoryBillingService } from '@/billing/billingService';
import { CLOUD_TERM_DAYS } from '@/billing/products';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { FakeClock } from '@/utils/clock';

const DAY = 86_400_000;
const EMAIL = 'buyer@example.test';
const PASSWORD = 'account-password';

async function signedIn(): Promise<{
  cloud: InMemoryCloudBackend;
  clock: FakeClock;
  billing: InMemoryBillingService;
  uid: string;
}> {
  const cloud = new InMemoryCloudBackend();
  const clock = new FakeClock();
  const billing = new InMemoryBillingService(cloud, clock);
  const user = await cloud.signUp(EMAIL, PASSWORD);
  return { cloud, clock, billing, uid: user.uid };
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof BillingError ? error.code : `not-a-billing-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('InMemoryBillingService', () => {
  it('refuses to start a checkout while signed out', async () => {
    const cloud = new InMemoryCloudBackend();
    const billing = new InMemoryBillingService(cloud, new FakeClock());
    expect(await codeOf(() => billing.createCheckout('pro'))).toBe('unauthenticated');
  });

  it('hands back a hosted checkout and grants Pro once the payment completes', async () => {
    const { cloud, clock, billing, uid } = await signedIn();
    const start = await billing.createCheckout('pro');
    expect(start.checkoutUrl).toMatch(/^https:\/\//);
    expect(await billing.syncCheckout(start.checkoutId)).toBe('pending');
    expect(await cloud.getDocument(BILLING_PATHS.entitlements(uid))).toBeNull();

    billing.completePayment(start.checkoutId);

    const doc = parseEntitlements(await cloud.getDocument(BILLING_PATHS.entitlements(uid)));
    expect(doc.pro).toBe(true);
    expect(doc.proSince).toBe(clock.now());
    expect(cloudActive(doc, clock.now())).toBe(false);
    expect(await billing.syncCheckout(start.checkoutId)).toBe('paid');
  });

  it('refuses to sell Pro twice', async () => {
    const { billing } = await signedIn();
    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    expect(await codeOf(() => billing.createCheckout('pro'))).toBe('already-owned');
  });

  it('extends Cloud by one term per payment, from the later of now and the current end', async () => {
    const { cloud, clock, billing, uid } = await signedIn();
    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    let doc = parseEntitlements(await cloud.getDocument(BILLING_PATHS.entitlements(uid)));
    expect(doc.cloud.status).toBe('active');
    expect(doc.cloud.accessUntil).toBe(clock.now() + CLOUD_TERM_DAYS * DAY);
    expect(doc.pro).toBe(false);

    clock.advance(5 * DAY);
    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    doc = parseEntitlements(await cloud.getDocument(BILLING_PATHS.entitlements(uid)));
    expect(doc.cloud.accessUntil).toBe(clock.now() - 5 * DAY + 2 * CLOUD_TERM_DAYS * DAY);
    expect(doc.cloud.cancelAtPeriodEnd).toBe(false);
  });

  it('reports a failed payment and grants nothing', async () => {
    const { cloud, billing, uid } = await signedIn();
    const start = await billing.createCheckout('pro');
    billing.failPayment(start.checkoutId);
    expect(await billing.syncCheckout(start.checkoutId)).toBe('failed');
    expect(await cloud.getDocument(BILLING_PATHS.entitlements(uid))).toBeNull();
  });

  it('cancelling keeps access to the end of the paid period', async () => {
    const { cloud, clock, billing, uid } = await signedIn();
    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    await billing.cancelCloud();
    const doc = parseEntitlements(await cloud.getDocument(BILLING_PATHS.entitlements(uid)));
    expect(doc.cloud.status).toBe('cancelled');
    expect(doc.cloud.cancelAtPeriodEnd).toBe(true);
    expect(doc.cloud.accessUntil).toBe(clock.now() + CLOUD_TERM_DAYS * DAY);
    expect(cloudActive(doc, clock.now())).toBe(true);
  });

  it('notifies a watcher of the document the moment a payment lands', async () => {
    const { cloud, billing, uid } = await signedIn();
    const seen: boolean[] = [];
    cloud.watchDocument(BILLING_PATHS.entitlements(uid), (doc) => {
      seen.push(parseEntitlements(doc).pro);
    });
    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    expect(seen).toEqual([false, true]);
  });
});
