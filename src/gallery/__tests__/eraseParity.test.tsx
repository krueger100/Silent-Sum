/**
 * The vault has two doors marked "erase", and they must leave the same room behind.
 *
 * One is the forgot-PIN dialog on the calculator, for a user who is locked out. The other is the
 * gallery's escape hatch, shown when the encrypted files on disk do not decrypt with this
 * session's keys. They are reached from opposite sides of the lock and they used to do different
 * things: the gallery's wiped the vault directory and the credentials, and left the decrypted
 * temporaries, the settings and the cloud session behind.
 *
 * Both now run `wipeLocalVault`, so this spec drives each door on its own device and compares the
 * state afterwards field by field. The interesting half of the comparison is what is NOT gone:
 * the same cloud backend is shared by both devices, snapshotted before either erase, and must come
 * out byte-identical after both.
 */
import React from 'react';
import { fireEvent, waitFor } from '@testing-library/react-native';

import { ERASE_PHRASE, ForgotPinDialog } from '@/auth/screens/ForgotPinDialog';
import type { Services } from '@/app/services';
import type { BackupService } from '@/backup/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { NoopAnalyticsService, NoopCrashReporter, type FirebaseServices } from '@/firebase/types';
import { GalleryScreen } from '@/gallery/GalleryScreen';
import { buildServices, renderInVault } from '@/gallery/__tests__/vaultHarness';
import { DEFAULT_SETTINGS, type AppSettings } from '@/settings/appSettings';
import { joinUri } from '@/storage/fileSystem';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { utf8Encode } from '@/utils/bytes';

const PIN = '2468';
const EMAIL = 'vault@example.test';
const PASSWORD = 'account-password';
const PASSPHRASE = 'correct horse battery staple';
/** Seeded into a photo and into two cached temporaries; must survive neither erase. */
const MARKER = 'PLAINTEXT-BYTES';

interface Device {
  readonly services: Services;
  readonly fs: InMemoryFileSystem;
}

function buildDevice(cloud: InMemoryCloudBackend): Device {
  const firebase: FirebaseServices = {
    available: true,
    crash: new NoopCrashReporter(),
    analytics: new NoopAnalyticsService(),
    cloud,
  };
  return buildServices(undefined, undefined, { firebase });
}

function requireBackup(device: Device): BackupService {
  const backup = device.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  return backup;
}

function toLatin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function filesContaining(device: Device, needle: string): string[] {
  return [...device.fs.allFiles.entries()]
    .filter(([, bytes]) => toLatin1(bytes).includes(needle))
    .map(([uri]) => uri);
}

/** Everything the server holds, in a form two snapshots can be compared with. */
function snapshotCloud(cloud: InMemoryCloudBackend): string {
  const documents = [...cloud.documents.entries()]
    .map(([path, data]) => `${path}=${JSON.stringify(data)}`)
    .sort();
  const blobs = [...cloud.blobs.entries()]
    .map(([path, bytes]) => `${path}=${toLatin1(bytes)}`)
    .sort();
  return JSON.stringify({ documents, blobs });
}

interface DeviceState {
  readonly files: readonly string[];
  readonly credentials: boolean;
  readonly unlocked: boolean;
  readonly repositoryOpen: boolean;
  readonly signedIn: boolean;
  readonly settings: AppSettings;
  readonly playbackOutstanding: readonly string[];
}

async function deviceState(device: Device): Promise<DeviceState> {
  const { services } = device;
  return {
    // Paths are relative to each device's own root, which is the same string in both harnesses;
    // an empty list either way is what makes them comparable at all.
    files: [...device.fs.allFiles.keys()].sort(),
    credentials: await services.auth.isConfigured(),
    unlocked: services.session.isUnlocked,
    repositoryOpen: services.vault.current !== null,
    signedIn: services.firebase.cloud?.currentUser !== null,
    settings: services.settings.current,
    playbackOutstanding: [...services.playbackScratch.outstanding],
  };
}

/** Decrypted leftovers of the kind a killed session strands: playback output and a capture. */
async function strandTemporaries(device: Device): Promise<void> {
  const playback = await device.services.playbackScratch.allocate();
  await device.fs.writeBytes(playback, utf8Encode(MARKER));

  const cameraDirectory = joinUri(device.fs.cacheDirectory, 'Camera');
  await device.fs.makeDirectory(cameraDirectory);
  await device.fs.writeBytes(joinUri(cameraDirectory, 'IMG_0001.jpg'), utf8Encode(MARKER));
}

function markedImage(): Uint8Array {
  const bytes = new Uint8Array(1024);
  bytes.set(utf8Encode(MARKER), 0);
  return bytes;
}

describe('the two erase paths', () => {
  it('leave the same device state and the same untouched cloud', async () => {
    const cloud = new InMemoryCloudBackend();

    // ---- Device A: a working, backed-up vault, erased through "Forgot PIN" -------------------
    const a = buildDevice(cloud);
    const keys = await a.services.auth.setupPin(PIN);
    a.services.session.adopt(keys);
    const repository = await a.services.vault.open(keys);
    await repository.addPhoto({ bytes: markedImage() }, { source: 'import' });
    await cloud.signUp(EMAIL, PASSWORD);
    const backup = requireBackup(a);
    await backup.enable(keys, PASSPHRASE);
    await backup.backupNow(repository, keys);
    await a.services.settings.update({ onboardingDone: true, backupEnabled: true });
    await strandTemporaries(a);

    // The comparison below is only worth anything if there is something in the cloud to preserve.
    expect(cloud.blobs.size).toBeGreaterThan(0);
    expect(cloud.documents.size).toBeGreaterThan(0);
    const cloudBefore = snapshotCloud(cloud);
    expect(filesContaining(a, MARKER).length).toBeGreaterThan(0);

    const dialog = await renderInVault(
      a.services,
      <ForgotPinDialog visible onDismiss={jest.fn()} onErased={jest.fn()} />,
    );
    await fireEvent.press(dialog.getByTestId('erase_explain_dialog-confirm'));
    await fireEvent.changeText(dialog.getByTestId('typed-confirm-input'), ERASE_PHRASE);
    await fireEvent.press(dialog.getByTestId('erase_confirm_dialog-confirm'));
    await waitFor(() => {
      expect(dialog.getByTestId('erase_outcome_dialog')).toBeTruthy();
    });
    const afterForgotPin = await deviceState(a);
    await dialog.unmount();

    // ---- Device B: the same account, a vault that will not open, erased from the gallery ------
    const b = buildDevice(cloud);
    await cloud.signIn(EMAIL, PASSWORD);
    const bKeys = await b.services.auth.setupPin(PIN);
    b.services.session.adopt(bKeys);
    // Files that exist but do not decrypt with this session's keys: the unreadable state.
    await b.fs.writeBytes(b.services.paths.index, utf8Encode('not a vault index'));
    await expect(b.services.vault.open(bKeys)).rejects.toThrow();
    await b.services.settings.update({ onboardingDone: true, backupEnabled: true });
    await strandTemporaries(b);
    expect(filesContaining(b, MARKER).length).toBeGreaterThan(0);

    const gallery = await renderInVault(b.services, <GalleryScreen />);
    await fireEvent.press(gallery.getByTestId('gallery-erase-vault'));
    await fireEvent.changeText(gallery.getByTestId('typed-confirm-input'), 'ERASE');
    await fireEvent.press(gallery.getByTestId('gallery-erase-confirm-confirm'));
    await waitFor(async () => {
      expect(await b.services.auth.isConfigured()).toBe(false);
    });
    const afterGallery = await deviceState(b);

    // ---- The same room, whichever door -------------------------------------------------------
    expect(afterGallery).toEqual(afterForgotPin);

    // Spelled out as well as compared, so a regression that changes both at once still fails.
    expect(afterGallery).toEqual({
      files: [],
      credentials: false,
      unlocked: false,
      repositoryOpen: false,
      signedIn: false,
      settings: DEFAULT_SETTINGS,
      playbackOutstanding: [],
    });
    expect(filesContaining(a, MARKER)).toEqual([]);
    expect(filesContaining(b, MARKER)).toEqual([]);

    // ---- And neither door reached the cloud ---------------------------------------------------
    expect(snapshotCloud(cloud)).toBe(cloudBefore);
    expect(cloud.passwordFor(EMAIL)).toBe(PASSWORD);
  });
});
