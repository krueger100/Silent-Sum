/**
 * What each wipe scope actually destroys, and -- for "both" -- the order it destroys it in.
 *
 * The ordering is the part worth a test of its own. Wiping the device signs Firebase out, and a
 * signed-out app cannot delete anything from the account, so a "both" that ran the device first
 * would report success while quietly leaving the cloud copy standing. Asserting that the cloud is
 * empty AND that the delete reported success is what pins the order down.
 */
import { createServices, type Services } from '@/app/services';
import { performScopedWipe } from '@/auth/vaultWipe';
import type { BackupService } from '@/backup/types';
import { KDF_PRESETS } from '@/crypto';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import {
  CloudError,
  NoopCrashReporter,
  type AnalyticsEventName,
  type AnalyticsService,
  type FirebaseServices,
} from '@/firebase/types';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeClock } from '@/utils/clock';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';

const PIN = '2468';
const WIPE_PIN = '55531';
const EMAIL = 'vault@example.test';
const PASSWORD = 'account-password';
const PASSPHRASE = 'correct horse battery staple';

/** Records every event name, so "nothing was logged" can be asserted instead of assumed. */
class RecordingAnalytics implements AnalyticsService {
  readonly events: AnalyticsEventName[] = [];

  async setEnabled(): Promise<void> {}

  async logEvent(name: AnalyticsEventName): Promise<void> {
    this.events.push(name);
  }
}

interface Device {
  readonly services: Services;
  readonly fs: InMemoryFileSystem;
  readonly cloud: InMemoryCloudBackend;
  readonly analytics: RecordingAnalytics;
}

function buildDevice(): Device {
  const fs = new InMemoryFileSystem();
  const cloud = new InMemoryCloudBackend();
  const analytics = new RecordingAnalytics();
  const firebase: FirebaseServices = {
    available: true,
    crash: new NoopCrashReporter(),
    analytics,
    cloud,
  };
  const services = createServices({
    fs,
    firebase,
    secureStore: new InMemorySecureStore(),
    settingsStore: new InMemorySettingsStore(),
    clock: new FakeClock(),
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
  });
  return { services, fs, cloud, analytics };
}

function requireBackup(device: Device): BackupService {
  const backup = device.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  return backup;
}

/** A vault with one photo, backed up, signed in, and a wipe PIN armed. */
async function seed(device: Device): Promise<void> {
  const keys = await device.services.auth.setupPin(PIN);
  device.services.session.adopt(keys);
  const repository = await device.services.vault.open(keys);
  await repository.addPhoto({ bytes: new Uint8Array(512).fill(9) }, { source: 'import' });

  await device.cloud.signUp(EMAIL, PASSWORD);
  const backup = requireBackup(device);
  await backup.enable(keys, PASSPHRASE);
  await backup.backupNow(repository, keys);

  await device.services.auth.setWipePin(WIPE_PIN, 'both');
  await device.services.settings.update({ onboardingDone: true, backupEnabled: true });
}

function vaultFileCount(device: Device): number {
  const root = device.services.paths.root;
  return [...device.fs.allFiles.keys()].filter((uri) => uri.startsWith(root)).length;
}

describe('performScopedWipe', () => {
  it('scope "device": destroys the vault here and leaves the cloud copy alone', async () => {
    const device = buildDevice();
    await seed(device);
    const blobsBefore = device.cloud.blobs.size;
    const documentsBefore = device.cloud.documents.size;

    const result = await performScopedWipe(device.services, 'device');

    expect(result).toEqual({ scope: 'device', deviceWiped: true, backupDeleted: false });
    expect(await device.services.auth.isConfigured()).toBe(false);
    expect(vaultFileCount(device)).toBe(0);
    expect(device.services.session.isUnlocked).toBe(false);
    // Untouched, so this user can still restore with their recovery passphrase.
    expect(device.cloud.blobs.size).toBe(blobsBefore);
    expect(device.cloud.documents.size).toBe(documentsBefore);
    expect(device.cloud.passwordFor(EMAIL)).toBe(PASSWORD);
  });

  it('scope "device": leaves no trace on the calculator afterwards', async () => {
    const device = buildDevice();
    await seed(device);

    await performScopedWipe(device.services, 'device');

    // The settings survive. Resetting them would clear `onboardingDone`, and the first-run welcome
    // sheet reappearing is exactly the announcement this path must not make.
    expect(device.services.settings.current.onboardingDone).toBe(true);
    expect(device.services.settings.current.backupEnabled).toBe(false);
  });

  it('scope "backup": deletes the cloud copy and leaves this device openable', async () => {
    const device = buildDevice();
    await seed(device);

    const result = await performScopedWipe(device.services, 'backup');

    expect(result).toEqual({ scope: 'backup', deviceWiped: false, backupDeleted: true });
    expect(device.cloud.blobs.size).toBe(0);
    expect(device.cloud.documents.size).toBe(0);
    expect(device.cloud.passwordFor(EMAIL)).toBe(PASSWORD);

    // The photos are still here and the PIN still opens them.
    expect(await device.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(device)).toBeGreaterThan(0);
    const unlocked = await device.services.auth.unlock(PIN);
    expect(unlocked.kind).toBe('success');
    if (unlocked.kind === 'success') {
      const repository = await device.services.vault.open(unlocked.keys);
      expect(repository.photos).toHaveLength(1);
    }

    // The device stops believing it has a fallback, and the trap stays armed for a future backup.
    expect(device.services.settings.current.backupEnabled).toBe(false);
    expect(await device.services.auth.wipePin()).not.toBeNull();
  });

  it('scope "both": deletes the cloud copy FIRST, then the device', async () => {
    const device = buildDevice();
    await seed(device);

    const result = await performScopedWipe(device.services, 'both');

    // `backupDeleted` could only be true if the delete ran while still signed in, which is only
    // possible before the local wipe signs Firebase out.
    expect(result).toEqual({ scope: 'both', deviceWiped: true, backupDeleted: true });
    expect(device.cloud.blobs.size).toBe(0);
    expect(device.cloud.documents.size).toBe(0);
    expect(device.cloud.currentUser).toBeNull();

    expect(await device.services.auth.isConfigured()).toBe(false);
    expect(await device.services.auth.wipePin()).toBeNull();
    expect(vaultFileCount(device)).toBe(0);
    expect(device.fs.allFiles.size).toBe(0);

    // The account survives: it holds nothing now, and deleting it would be a visible event.
    expect(device.cloud.passwordFor(EMAIL)).toBe(PASSWORD);
  });

  it('still wipes the device when the cloud cannot be reached', async () => {
    const device = buildDevice();
    await seed(device);
    await device.cloud.signOut();

    const result = await performScopedWipe(device.services, 'both');

    // Nothing could be deleted from the account, and the result says so rather than pretending.
    expect(result).toEqual({ scope: 'both', deviceWiped: true, backupDeleted: false });
    expect(device.cloud.blobs.size).toBeGreaterThan(0);
    expect(await device.services.auth.isConfigured()).toBe(false);
    expect(vaultFileCount(device)).toBe(0);
  });
});

describe('what a scoped wipe must never do', () => {
  it('deletes nothing at all when the session cannot reach the server', async () => {
    const device = buildDevice();
    await seed(device);
    const uid = device.cloud.currentUser?.uid ?? '';
    const blobsBefore = device.cloud.blobs.size;

    // A cached user with a dead token: Firebase keeps `currentUser`, the server refuses.
    jest
      .spyOn(device.cloud, 'listBlobs')
      .mockRejectedValue(new CloudError('unauthenticated'));

    const result = await performScopedWipe(device.services, 'both');

    // The outcome being ruled out is a HALF-deleted backup: some blobs gone, envelope standing.
    expect(result.backupDeleted).toBe(false);
    expect(device.cloud.blobs.size).toBe(blobsBefore);
    expect(device.cloud.documents.has(`users/${uid}/vault/envelope`)).toBe(true);

    // The urgent half still runs: the copy on this phone is what the person is standing over.
    expect(result.deviceWiped).toBe(true);
    expect(await device.services.auth.isConfigured()).toBe(false);
  });

  it('reports a failed cloud delete instead of claiming it worked', async () => {
    const device = buildDevice();
    await seed(device);
    jest
      .spyOn(requireBackup(device), 'disable')
      .mockRejectedValue(new CloudError('permission-denied'));

    const result = await performScopedWipe(device.services, 'both');

    expect(result).toEqual({ scope: 'both', deviceWiped: true, backupDeleted: false });
  });

  it('never deletes the Firebase account, in any scope', async () => {
    for (const scope of ['device', 'backup', 'both'] as const) {
      const device = buildDevice();
      await seed(device);
      const deleteAccount = jest.spyOn(device.cloud, 'deleteAccount');

      await performScopedWipe(device.services, scope);

      expect(deleteAccount).not.toHaveBeenCalled();
      expect(device.cloud.passwordFor(EMAIL)).toBe(PASSWORD);
    }
  });

  it('logs nothing anywhere, in any scope', async () => {
    for (const scope of ['device', 'backup', 'both'] as const) {
      const device = buildDevice();
      await seed(device);

      await performScopedWipe(device.services, scope);

      // An analytics event would be a durable record that the feature exists and was used.
      expect(device.analytics.events).toEqual([]);
    }
  });

  it('erases the armed wipe PIN only after both halves have run', async () => {
    const device = buildDevice();
    await seed(device);
    const order: string[] = [];

    const backup = requireBackup(device);
    const realDisable = backup.disable.bind(backup);
    jest.spyOn(backup, 'disable').mockImplementation(async () => {
      order.push('cloud:start');
      await realDisable();
      order.push('cloud:done');
    });

    // `eraseCredentials` is what takes the wipe PIN record with it.
    const auth = device.services.auth;
    const realErase = auth.eraseCredentials.bind(auth);
    jest.spyOn(auth, 'eraseCredentials').mockImplementation(async () => {
      order.push('wipe-pin-erased');
      await realErase();
    });

    await performScopedWipe(device.services, 'both');

    // Cloud first, device second, and the record that drives all of it destroyed last of all.
    expect(order).toEqual(['cloud:start', 'cloud:done', 'wipe-pin-erased']);
    expect(await device.services.auth.wipePin()).toBeNull();
  });
});
