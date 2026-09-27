/**
 * The composition root decides whether the free tier is enforced. The rule: only where Pro can
 * be bought (a billing service) AND its document can be read (a cloud backend). Anything else
 * must leave every feature open, because a gate whose key cannot be bought is not a tier.
 */
import { createServices } from '@/app/services';
import { InMemoryBillingService } from '@/billing/billingService';
import { FREE_TIER, MAX_ITEM_BYTES } from '@/billing/entitlements';
import { KDF_PRESETS } from '@/crypto/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import {
  FIREBASE_UNAVAILABLE,
  NoopAnalyticsService,
  NoopCrashReporter,
  type FirebaseServices,
} from '@/firebase/types';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeClock } from '@/utils/clock';

function base() {
  return {
    fs: new InMemoryFileSystem(),
    secureStore: new InMemorySecureStore(),
    settingsStore: new InMemorySettingsStore(),
    clock: new FakeClock(),
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
  };
}

function withCloud(
  cloud: InMemoryCloudBackend,
  billing: FirebaseServices['billing'],
): FirebaseServices {
  return {
    available: true,
    crash: new NoopCrashReporter(),
    analytics: new NoopAnalyticsService(),
    cloud,
    billing,
  };
}

describe('createServices billing wiring', () => {
  it('sells nothing and enforces nothing without Firebase', () => {
    const services = createServices({ ...base(), firebase: FIREBASE_UNAVAILABLE });
    expect(services.billing).toBeNull();
    expect(services.entitlements.enforced).toBe(false);
    expect(services.entitlements.gate(1000, MAX_ITEM_BYTES + 1)).toEqual({ allowed: true });
  });

  it('takes the billing service Firebase offers and enforces the free tier', () => {
    const cloud = new InMemoryCloudBackend();
    const clock = new FakeClock();
    const billing = new InMemoryBillingService(cloud, clock);
    const services = createServices({ ...base(), clock, firebase: withCloud(cloud, billing) });
    expect(services.billing).toBe(billing);
    expect(services.entitlements.enforced).toBe(true);
    // Video is free now, so a fresh vault takes one; what the enforced build still gates is the
    // 51st item and an oversized one.
    expect(services.entitlements.gate(0, 5_000_000)).toEqual({ allowed: true });
    expect(services.entitlements.gate(FREE_TIER.maxItems, 1)).toEqual({
      allowed: false,
      reason: 'itemLimit',
    });
  });

  it('lets a test switch billing off explicitly, gates included', () => {
    const cloud = new InMemoryCloudBackend();
    const clock = new FakeClock();
    const services = createServices({
      ...base(),
      clock,
      firebase: withCloud(cloud, new InMemoryBillingService(cloud, clock)),
      billing: null,
    });
    expect(services.billing).toBeNull();
    expect(services.entitlements.enforced).toBe(false);
  });

  it('never enforces a tier it could sell but not read back', () => {
    const cloud = new InMemoryCloudBackend();
    const clock = new FakeClock();
    const billing = new InMemoryBillingService(cloud, clock);
    const services = createServices({
      ...base(),
      clock,
      firebase: { ...FIREBASE_UNAVAILABLE, available: true, cloud: null },
      billing,
    });
    expect(services.billing).toBe(billing);
    expect(services.entitlements.enforced).toBe(false);
  });
});
