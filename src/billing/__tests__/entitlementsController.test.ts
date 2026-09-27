import { InMemoryBillingService } from '@/billing/billingService';
import {
  BILLING_PATHS,
  FREE_ENTITLEMENTS,
  MAX_ITEM_BYTES,
  entitlementsToJson,
} from '@/billing/entitlements';
import { EntitlementsController } from '@/billing/entitlementsController';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { CloudError } from '@/firebase/types';
import {
  ALL_SECURE_STORE_KEYS,
  InMemorySecureStore,
  SECURE_STORE_KEYS,
} from '@/secure-storage/secureStore';
import { FakeClock } from '@/utils/clock';

const DAY = 86_400_000;
const EMAIL = 'buyer@example.test';
const PASSWORD = 'account-password';

interface Rig {
  cloud: InMemoryCloudBackend;
  billing: InMemoryBillingService;
  secureStore: InMemorySecureStore;
  clock: FakeClock;
  controller: EntitlementsController;
}

function build(options: { enforced?: boolean; secureStore?: InMemorySecureStore } = {}): Rig {
  const cloud = new InMemoryCloudBackend();
  const clock = new FakeClock();
  const secureStore = options.secureStore ?? new InMemorySecureStore();
  const billing = new InMemoryBillingService(cloud, clock);
  const controller = new EntitlementsController({
    secureStore,
    clock,
    cloud,
    enforced: options.enforced ?? true,
  });
  return { cloud, billing, secureStore, clock, controller };
}

function cachedUid(secureStore: InMemorySecureStore): string | null {
  const raw = secureStore.snapshot[SECURE_STORE_KEYS.entitlements];
  if (raw === undefined) return null;
  const parsed = JSON.parse(raw) as { uid?: unknown };
  return typeof parsed.uid === 'string' ? parsed.uid : null;
}

describe('EntitlementsController', () => {
  it('is erased with the vault', () => {
    expect(ALL_SECURE_STORE_KEYS).toContain(SECURE_STORE_KEYS.entitlements);
  });

  it('starts free, unsynced and with the enforcement the build was given', async () => {
    const { controller } = build({ enforced: false });
    await controller.load();
    expect(controller.store.getState()).toEqual({
      entitlements: FREE_ENTITLEMENTS,
      uid: null,
      synced: false,
      enforced: false,
    });
    expect(controller.isPro()).toBe(false);
    expect(controller.isCloudActive()).toBe(false);
    expect(controller.cloudState()).toEqual({ kind: 'inactive' });
  });

  it('mirrors the live document into the store and the cache once a user is signed in', async () => {
    const { cloud, billing, secureStore, controller } = build();
    const user = await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();

    expect(controller.store.getState()).toMatchObject({ uid: user.uid, synced: true });
    expect(controller.isPro()).toBe(false);

    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    await controller.flush();

    expect(controller.isPro()).toBe(true);
    expect(controller.store.getState().synced).toBe(true);
    expect(cachedUid(secureStore)).toBe(user.uid);
    expect(secureStore.snapshot[SECURE_STORE_KEYS.entitlements]).toContain('"pro":true');
    stop();
  });

  it('restores the cached entitlements before any network, so Pro works offline', async () => {
    const secureStore = new InMemorySecureStore({
      [SECURE_STORE_KEYS.entitlements]: JSON.stringify({
        v: 1,
        uid: 'uid_cached',
        entitlements: entitlementsToJson({ ...FREE_ENTITLEMENTS, pro: true, proSince: 1 }),
        cachedAt: 1,
      }),
    });
    const { controller } = build({ secureStore });
    await controller.load();
    expect(controller.isPro()).toBe(true);
    expect(controller.store.getState()).toMatchObject({ uid: 'uid_cached', synced: false });
  });

  it('ignores a cache it cannot read', async () => {
    const secureStore = new InMemorySecureStore({
      [SECURE_STORE_KEYS.entitlements]: '{not json',
    });
    const { controller } = build({ secureStore });
    await controller.load();
    expect(controller.store.getState()).toMatchObject({
      entitlements: FREE_ENTITLEMENTS,
      uid: null,
    });
  });

  it('replaces the cache when a different account signs in', async () => {
    const secureStore = new InMemorySecureStore({
      [SECURE_STORE_KEYS.entitlements]: JSON.stringify({
        v: 1,
        uid: 'uid_previous_owner',
        entitlements: entitlementsToJson({ ...FREE_ENTITLEMENTS, pro: true, proSince: 1 }),
        cachedAt: 1,
      }),
    });
    const { cloud, controller } = build({ secureStore });
    await controller.load();
    expect(controller.isPro()).toBe(true);

    const user = await cloud.signUp(EMAIL, PASSWORD);
    const stop = controller.start();
    await controller.flush();

    expect(controller.isPro()).toBe(false);
    expect(controller.store.getState()).toMatchObject({ uid: user.uid, synced: true });
    expect(cachedUid(secureStore)).toBe(user.uid);
    stop();
  });

  it('keeps Pro after the account signs out, and stops listening', async () => {
    const { cloud, billing, controller } = build();
    const user = await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();
    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    await controller.flush();
    expect(controller.isPro()).toBe(true);

    await cloud.signOut();
    expect(controller.isPro()).toBe(true);
    expect(controller.store.getState()).toMatchObject({ uid: user.uid, synced: false });

    // A change made while signed out never reaches the store: nothing is listening.
    cloud.adminPutDocument(
      BILLING_PATHS.entitlements(user.uid),
      entitlementsToJson(FREE_ENTITLEMENTS),
    );
    expect(controller.isPro()).toBe(true);
    stop();
  });

  it('stops following the document once stopped', async () => {
    const { cloud, billing, controller } = build();
    await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();
    stop();
    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    await controller.flush();
    expect(controller.isPro()).toBe(false);
  });

  it('reads the document on demand without a watcher', async () => {
    const { cloud, billing, controller } = build();
    await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    expect(controller.isPro()).toBe(false);

    const fresh = await controller.refresh();

    expect(fresh.pro).toBe(true);
    expect(controller.isPro()).toBe(true);
    expect(controller.store.getState().synced).toBe(true);
  });

  it('returns what it has when nobody is signed in or the read fails', async () => {
    const { cloud, controller } = build();
    await controller.load();
    expect(await controller.refresh()).toEqual(FREE_ENTITLEMENTS);

    await cloud.signUp(EMAIL, PASSWORD);
    jest.spyOn(cloud, 'getDocument').mockRejectedValueOnce(new CloudError('unavailable'));
    expect(await controller.refresh()).toEqual(FREE_ENTITLEMENTS);
    expect(controller.store.getState().synced).toBe(false);
  });

  it('leaves the state untouched when the listener reports an error', async () => {
    class RefusingCloud extends InMemoryCloudBackend {
      override watchDocument(
        _path: string,
        _onChange: (doc: Record<string, unknown> | null) => void,
        onError?: (error: CloudError) => void,
      ): () => void {
        onError?.(new CloudError('permission-denied'));
        return () => undefined;
      }
    }
    const cloud = new RefusingCloud();
    const controller = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock: new FakeClock(),
      cloud,
      enforced: true,
    });
    const user = await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();
    expect(controller.store.getState()).toMatchObject({
      entitlements: FREE_ENTITLEMENTS,
      uid: user.uid,
      synced: false,
    });
    stop();
  });

  it('forgets everything on reset', async () => {
    const { cloud, billing, secureStore, controller } = build();
    await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();
    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    await controller.flush();
    stop();

    await controller.reset();

    expect(controller.store.getState()).toMatchObject({
      entitlements: FREE_ENTITLEMENTS,
      uid: null,
      synced: false,
    });
    expect(secureStore.snapshot[SECURE_STORE_KEYS.entitlements]).toBeUndefined();
  });

  it('gates nothing when the build cannot sell anything', async () => {
    const { controller } = build({ enforced: false });
    await controller.load();
    expect(controller.gate(999, MAX_ITEM_BYTES + 1)).toEqual({ allowed: true });
  });

  it('allows video on a free account, and counts it as one item', async () => {
    const { cloud, controller } = build({ enforced: true });
    await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();

    expect(controller.gate(0, 5_000_000)).toEqual({ allowed: true });
    expect(controller.gate(49, 5_000_000)).toEqual({ allowed: true });
    expect(controller.gate(50, 5_000_000)).toEqual({ allowed: false, reason: 'itemLimit' });
    stop();
  });

  it('refuses an oversized item however the account has paid', async () => {
    const { cloud, billing, controller } = build({ enforced: true });
    await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();
    expect(controller.gate(0, MAX_ITEM_BYTES + 1)).toEqual({ allowed: false, reason: 'fileSize' });

    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    await controller.flush();
    expect(controller.isCloudActive()).toBe(true);
    // The cap is about the device, not the plan, so a Cloud term does not lift it.
    expect(controller.gate(0, MAX_ITEM_BYTES + 1)).toEqual({ allowed: false, reason: 'fileSize' });
    stop();
  });

  it('gates the free tier when it can, and lifts the gate once Cloud arrives', async () => {
    const { cloud, billing, controller } = build({ enforced: true });
    await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();
    expect(controller.gate(50, 1)).toEqual({ allowed: false, reason: 'itemLimit' });
    expect(controller.gate(49, 1)).toEqual({ allowed: true });

    // Pro is the messaging plan: buying it must NOT lift the vault gates.
    billing.completePayment((await billing.createCheckout('pro')).checkoutId);
    await controller.flush();
    expect(controller.isPro()).toBe(true);
    expect(controller.gate(50, 1)).toEqual({ allowed: false, reason: 'itemLimit' });

    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    await controller.flush();
    expect(controller.gate(999, 1)).toEqual({ allowed: true });
    stop();
  });

  it('derives the cloud state from the clock, so a term lapses on time', async () => {
    const { cloud, billing, clock, controller } = build();
    await cloud.signUp(EMAIL, PASSWORD);
    await controller.load();
    const stop = controller.start();
    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    await controller.flush();
    expect(controller.isCloudActive()).toBe(true);
    expect(controller.cloudState()).toMatchObject({ kind: 'active', daysLeft: 30 });

    clock.advance(31 * DAY);
    expect(controller.isCloudActive()).toBe(false);
    expect(controller.cloudState()).toMatchObject({ kind: 'expired' });
    // Pro was never bought here, and Cloud lapsing says nothing about it either way.
    expect(controller.isPro()).toBe(false);
    stop();
  });

  it('works without any cloud backend at all', async () => {
    const controller = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock: new FakeClock(),
      cloud: null,
      enforced: false,
    });
    await controller.load();
    const stop = controller.start();
    expect(await controller.refresh()).toEqual(FREE_ENTITLEMENTS);
    stop();
  });
});
