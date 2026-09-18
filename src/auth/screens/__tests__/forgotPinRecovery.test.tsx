/**
 * The whole "I forgot my PIN" journey, end to end:
 *
 *   Forgot PIN -> confirm -> local wipe -> Firebase sign-out
 *              -> reset the account password -> sign in -> passphrase -> restore -> new PIN
 *
 * The two halves are tested together on purpose, because the property that matters spans them: the
 * step that destroys everything on the device is only survivable because it is forbidden from
 * touching anything in the cloud. So the cloud is snapshotted before the wipe and compared byte
 * for byte afterwards, and the restore is then driven against that same untouched backend.
 *
 * The plaintext marker threaded through the fixtures is the other half of it. It starts inside a
 * photo and inside a stranded decrypted playback file, and after the wipe it must not appear
 * anywhere in the file system at all -- not in the vault, not in a cache, not in a temporary.
 */
import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ERASE_PHRASE, ForgotPinDialog } from '@/auth/screens/ForgotPinDialog';
import { buildHarness, renderWithServices, type Harness } from '@/auth/screens/__tests__/harness';
import { wipeLocalVault } from '@/auth/vaultWipe';
import { RestoreFlowScreen } from '@/backup/screens/RestoreFlowScreen';
import { BACKUP_PATHS, type BackupService } from '@/backup/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { NoopAnalyticsService, NoopCrashReporter, type FirebaseServices } from '@/firebase/types';
import { utf8Encode } from '@/utils/bytes';

const EMAIL = 'vault@example.test';
const OLD_PASSWORD = 'first-account-password';
const NEW_PASSWORD = 'reset-account-password';
const PASSPHRASE = 'correct horse battery staple';
const OLD_PIN = '2468';
const NEW_PIN = '9753';
/** Distinctive enough that finding it anywhere after the wipe is unambiguous. */
const MARKER = 'PLAINTEXT-PHOTO-BYTES';

function cloudHarness(cloud: InMemoryCloudBackend): Harness {
  const firebase: FirebaseServices = {
    available: true,
    crash: new NoopCrashReporter(),
    analytics: new NoopAnalyticsService(),
    cloud,
  };
  return buildHarness({ firebase });
}

function requireBackup(harness: Harness): BackupService {
  const backup = harness.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  return backup;
}

/** Byte-exact comparison without assuming the bytes are valid UTF-8. */
function toLatin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function filesContaining(harness: Harness, needle: string): string[] {
  return [...harness.fs.allFiles.entries()]
    .filter(([, bytes]) => toLatin1(bytes).includes(needle))
    .map(([uri]) => uri);
}

function vaultFileCount(harness: Harness): number {
  const root = harness.services.paths.root;
  return [...harness.fs.allFiles.keys()].filter((uri) => uri.startsWith(root)).length;
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

/**
 * A device in the state the recovery flow assumes: a vault with one photo, a cloud backup of it,
 * and a decrypted video left behind in the playback cache by a session that was killed.
 *
 * Returns the account uid, which is the only way to address the backup once the user is signed out.
 */
async function seedDevice(harness: Harness, cloud: InMemoryCloudBackend): Promise<string> {
  const keys = await harness.services.auth.setupPin(OLD_PIN);
  harness.services.session.adopt(keys);
  const repository = await harness.services.vault.open(keys);
  const image = new Uint8Array(1024);
  image.set(utf8Encode(MARKER), 0);
  await repository.addPhoto({ bytes: image }, { source: 'import' });

  const user = await cloud.signUp(EMAIL, OLD_PASSWORD);
  const backup = requireBackup(harness);
  await backup.enable(keys, PASSPHRASE);
  await backup.backupNow(repository, keys);
  await harness.services.settings.update({ onboardingDone: true, backupEnabled: true });

  const stranded = await harness.services.playbackScratch.allocate();
  await harness.fs.writeBytes(stranded, utf8Encode(MARKER));

  return user.uid;
}

async function eraseThroughDialog(): Promise<void> {
  await fireEvent.press(screen.getByTestId('forgot_pin_dialog-confirm'));
  await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), ERASE_PHRASE);
  await fireEvent.press(screen.getByTestId('erase_vault_dialog-confirm'));
  await waitFor(() => {
    expect(screen.getByTestId('erase_outcome_dialog')).toBeTruthy();
  });
}

describe('forgot PIN recovery', () => {
  it('wipes the device, signs out, and leaves the cloud backup byte-identical', async () => {
    const cloud = new InMemoryCloudBackend();
    const harness = cloudHarness(cloud);
    const uid = await seedDevice(harness, cloud);

    const cloudBefore = snapshotCloud(cloud);
    expect(filesContaining(harness, MARKER).length).toBeGreaterThan(0);
    expect(harness.services.playbackScratch.outstanding).toHaveLength(1);

    const onErased = jest.fn();
    const onRestore = jest.fn();
    await renderWithServices(
      harness.services,
      <ForgotPinDialog visible onDismiss={jest.fn()} onErased={onErased} onRestore={onRestore} />,
    );

    // The explanation names the consequence before the typed phrase is ever shown.
    expect(screen.getByTestId('forgot_pin_dialog')).toHaveTextContent(/no backdoor/);
    expect(screen.getByTestId('forgot_pin_dialog')).toHaveTextContent(/NOT deleted/);

    await eraseThroughDialog();

    // --- local wipe -------------------------------------------------------------------------
    expect(await harness.services.auth.isConfigured()).toBe(false);
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(harness.services.vault.current).toBeNull();
    expect(vaultFileCount(harness)).toBe(0);
    expect(harness.services.settings.current.onboardingDone).toBe(false);
    expect(harness.services.settings.current.backupEnabled).toBe(false);

    // --- no plaintext left, anywhere ----------------------------------------------------------
    expect(filesContaining(harness, MARKER)).toEqual([]);
    expect(harness.services.playbackScratch.outstanding).toEqual([]);

    // --- Firebase signed out, account intact --------------------------------------------------
    expect(cloud.currentUser).toBeNull();
    expect(cloud.passwordFor(EMAIL)).toBe(OLD_PASSWORD);

    // --- cloud backup preserved ---------------------------------------------------------------
    expect(snapshotCloud(cloud)).toBe(cloudBefore);
    expect(cloud.documents.has(BACKUP_PATHS.envelope(uid))).toBe(true);
    expect([...cloud.blobs.keys()].some((path) => path.startsWith(`users/${uid}/photos/`))).toBe(
      true,
    );

    // --- and the user is pointed at the way back ----------------------------------------------
    expect(screen.getByTestId('erase_outcome_dialog')).toHaveTextContent(/recovery passphrase/);
    await fireEvent.press(screen.getByTestId('erase_outcome_dialog-confirm'));
    expect(onErased).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('warns that nothing can be recovered when there is no cloud backup', async () => {
    const harness = buildHarness();
    const keys = await harness.services.auth.setupPin(OLD_PIN);
    harness.services.session.adopt(keys);
    const repository = await harness.services.vault.open(keys);
    await repository.addPhoto({ bytes: new Uint8Array(512).fill(7) }, { source: 'import' });
    await harness.services.settings.update({ onboardingDone: true });

    const onRestore = jest.fn();
    await renderWithServices(
      harness.services,
      <ForgotPinDialog visible onDismiss={jest.fn()} onErased={jest.fn()} onRestore={onRestore} />,
    );

    expect(screen.getByTestId('forgot_pin_dialog')).toHaveTextContent(/erasing it is final/);
    await eraseThroughDialog();

    expect(screen.getByTestId('erase_outcome_dialog')).toHaveTextContent(/cannot be recovered/);
    expect(screen.queryByText('Restore from cloud backup')).toBeNull();
    // Nothing to restore means nothing to offer, and no way to reach the flow from here.
    await fireEvent.press(screen.getByTestId('erase_outcome_dialog-confirm'));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('restores after an account password reset and re-wraps the key under a new PIN', async () => {
    const cloud = new InMemoryCloudBackend();
    const device = cloudHarness(cloud);
    const uid = await seedDevice(device, cloud);

    const result = await wipeLocalVault(device.services);
    expect(result).toEqual({ hadCloudBackup: true, signedOut: true, credentialsErased: true });
    expect(cloud.currentUser).toBeNull();

    // The user follows the reset link. The account password changes; nothing else does.
    const envelopeBefore = JSON.stringify(cloud.documents.get(BACKUP_PATHS.envelope(uid)));
    const cloudBefore = snapshotCloud(cloud);
    await cloud.sendPasswordReset(EMAIL);
    cloud.completePasswordReset(EMAIL, NEW_PASSWORD);
    expect(cloud.passwordResets).toEqual([EMAIL]);
    expect(JSON.stringify(cloud.documents.get(BACKUP_PATHS.envelope(uid)))).toBe(envelopeBefore);
    expect(snapshotCloud(cloud)).toBe(cloudBefore);
    expect(await device.services.auth.isConfigured()).toBe(false);

    await renderWithServices(device.services, <RestoreFlowScreen onDone={jest.fn()} />);

    // 1. Sign in with the NEW password. The old one no longer works.
    await fireEvent.changeText(screen.getByTestId('restore_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('restore_password'), OLD_PASSWORD);
    await fireEvent.press(screen.getByTestId('restore_sign_in'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_error')).toHaveTextContent(/Wrong email or password/);
    });

    await fireEvent.changeText(screen.getByTestId('restore_password'), NEW_PASSWORD);
    await fireEvent.press(screen.getByTestId('restore_sign_in'));
    // 2. The backup is detected, so a passphrase is worth asking for.
    await waitFor(() => {
      expect(screen.getByTestId('restore_passphrase')).toBeTruthy();
    });

    // 3. A wrong passphrase stops here: no PIN is requested and nothing is written.
    await fireEvent.changeText(screen.getByTestId('restore_passphrase'), 'nowhere near the words');
    await fireEvent.press(screen.getByTestId('restore_passphrase_next'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_error')).toHaveTextContent(/Wrong recovery passphrase/);
    });
    expect(screen.queryByTestId('restore_pin')).toBeNull();
    expect(await device.services.auth.isConfigured()).toBe(false);

    // 4. The right one is verified against the envelope before a PIN is chosen.
    await fireEvent.changeText(screen.getByTestId('restore_passphrase'), PASSPHRASE);
    await fireEvent.press(screen.getByTestId('restore_passphrase_next'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_pin')).toBeTruthy();
    });

    // 5. A brand-new local PIN, which is what the recovered master key is re-wrapped under.
    await fireEvent.changeText(screen.getByTestId('restore_pin'), NEW_PIN);
    await fireEvent.changeText(screen.getByTestId('restore_pin_confirm'), NEW_PIN);
    await fireEvent.press(screen.getByTestId('restore_submit'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_summary')).toHaveTextContent(/Restored 1 photo/);
    });
    expect(device.services.vault.current?.photos).toHaveLength(1);

    // The new PIN opens the vault; the forgotten one does not.
    device.services.session.lock();
    const withNew = await device.services.auth.unlock(NEW_PIN);
    expect(withNew.kind).toBe('success');
    if (withNew.kind !== 'success') throw new Error('expected the new PIN to unlock');

    const repository = await device.services.vault.open(withNew.keys);
    const entry = repository.photos.at(0);
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      // The photo really is the one that was backed up, not a placeholder.
      expect(toLatin1(await repository.readFullImage(entry.id))).toContain(MARKER);
    }
    await device.services.vault.close();

    const withOld = await device.services.auth.unlock(OLD_PIN);
    expect(withOld.kind).toBe('wrongPin');
    withNew.keys.dispose();
  });
});
