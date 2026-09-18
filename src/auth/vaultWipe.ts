/**
 * Destroying a vault on purpose.
 *
 * Three callers, one implementation: the forgot-PIN dialog, the gallery's escape hatch for a vault
 * that no longer decrypts, and the wipe PIN. The first two ask; the third is typed under duress
 * and may not so much as blink. {@link wipeLocalVault} is what all of them run, and
 * {@link performScopedWipe} is the wipe PIN's choice of how far it reaches.
 *
 * What it touches and what it deliberately does not touch are both part of the security model:
 *
 * **Erased, locally and completely.** The encrypted payloads and thumbnails, the index, the
 * wrapped master key and the PIN record in the platform secure store, the attempt throttle, every
 * preference, the live session -- and every decrypted temporary the app can produce. That last one
 * matters more than it looks: a vault whose blobs are gone but whose `cache/playback` still holds
 * a decrypted video would have destroyed the ciphertext and kept the plaintext.
 *
 * **Never touched.** The cloud account and everything in it. The user is signed out, which ends
 * this device's session; the account itself, the encrypted blobs and the backup envelope are left
 * exactly as they were. That is the whole reason this is survivable: a user with a backup and
 * their recovery passphrase can sign in again and restore, and nothing here is allowed to take
 * that away from them. Deleting the account or calling {@link BackupService.disable} from this
 * path would turn "I forgot my PIN" into permanent, unrecoverable loss.
 *
 * Nothing throws. Every step is independently guarded, because a failure half way through must
 * still let the remaining steps run -- erasing the credentials matters even if the file wipe
 * failed, since without them the blobs are undecryptable noise. The one failure the caller is told
 * about is the credential erase, which is the only step whose failure leaves the vault openable.
 */
import type { Services } from '@/app/services';
import type { WipeScope } from '@/auth/types';
import { BACKUP_PATHS } from '@/backup/types';

export interface LocalWipeOptions {
  /**
   * Keep the preferences instead of resetting them, turning off only the backup record.
   *
   * The wipe PIN needs this. Resetting the settings clears `onboardingDone`, which brings the
   * first-run welcome sheet back to the calculator -- and a sheet appearing seconds after someone
   * typed a number would announce that something had just been destroyed, which is the one thing
   * that path must never do.
   */
  readonly keepSettings?: boolean;
}

export interface LocalWipeResult {
  /**
   * Whether this device recorded a cloud backup, read BEFORE the settings were reset. It is the
   * only signal available at wipe time: confirming it against the server would need an account
   * password the user may not have to hand, and the wipe must not depend on the network.
   */
  readonly hadCloudBackup: boolean;
  /** Whether a signed-in cloud session was ended. The account is never deleted. */
  readonly signedOut: boolean;
  /**
   * False when the wrapped master key could not be removed from the secure store. The caller must
   * say so rather than report a clean wipe: a vault whose credentials survive is still openable.
   */
  readonly credentialsErased: boolean;
}

/**
 * Erases every trace of the vault from this device and signs out of the cloud, in that order.
 *
 * The order is deliberate. Signing out first would make the account unavailable for the rest of
 * the run for no benefit; signing out last means the local data is already gone by the time the
 * network is involved at all, so an offline device gets the same wipe as an online one.
 */
export async function wipeLocalVault(
  services: Services,
  options: LocalWipeOptions = {},
): Promise<LocalWipeResult> {
  const hadCloudBackup = services.settings.current.backupEnabled;

  // 1. Stop anything from writing. Locking closes the repository through the controller; closing
  //    it again directly is idempotent and makes the ordering explicit rather than incidental.
  services.session.lock();
  await quietly(() => services.vault.close());

  // 2. Decrypted temporaries, before the ciphertext: playback files, camera captures on their way
  //    into the vault, picker copies, restore scratch. The cache directory is app-private and
  //    holds nothing worth keeping, so wiping all of it is both safe and future-proof -- a new
  //    temporary path added later is covered without anyone remembering to add it here.
  await quietly(() => services.playbackScratch.purge());
  await quietly(() => services.secureDelete.directoryContents(services.fs.cacheDirectory));

  // 3. The vault itself: payloads, thumbnails and the index, overwritten before being unlinked.
  await quietly(() => services.secureDelete.directoryContents(services.paths.root));
  await quietly(() => services.fs.deleteDirectory(services.paths.root));

  // 4. The wrapped master key and the throttle state. Without these the blobs cannot be opened by
  //    anything, which is why this step is reported on separately.
  const credentialsErased = await quietly(() => services.auth.eraseCredentials());

  // 5. Every preference, including the record that a cloud backup existed -- or, when the caller
  //    must leave no visible trace, only that record.
  await quietly(() =>
    options.keepSettings === true
      ? services.settings.update({ backupEnabled: false, lastBackupAt: null })
      : services.settings.reset(),
  );

  // 6. End the cloud session. Sign out only -- never deleteAccount(), never disable().
  const signedOut = await signOutQuietly(services);

  return { hadCloudBackup, signedOut, credentialsErased };
}

export interface ScopedWipeResult {
  readonly scope: WipeScope;
  readonly deviceWiped: boolean;
  /** False when there was no backend, no signed-in account, or the delete failed. */
  readonly backupDeleted: boolean;
}

/**
 * What the wipe PIN runs: the destruction the user chose when they armed it.
 *
 * The ordering across the two scopes is the part that matters. When both are in scope the CLOUD
 * goes first, because wiping the device signs Firebase out, and a signed-out app cannot delete
 * anything from the account -- doing it the other way round would quietly leave the backup
 * standing while reporting success.
 *
 * Nothing here throws and nothing here reports to the user. The caller is a calculator that has
 * already drawn the answer to a sum.
 */
export async function performScopedWipe(
  services: Services,
  scope: WipeScope,
): Promise<ScopedWipeResult> {
  const backupDeleted = scope === 'device' ? false : await deleteCloudBackup(services);

  if (scope === 'backup') {
    // The vault itself survives, so the only local change is that this device must stop believing
    // it has a backup to fall back on. The wipe PIN stays armed: the user may enable backup again,
    // and disarming it silently would leave them thinking they were still protected.
    await quietly(() =>
      services.settings.update({ backupEnabled: false, lastBackupAt: null }),
    );
    return { scope, deviceWiped: false, backupDeleted };
  }

  await wipeLocalVault(services, { keepSettings: true });
  return { scope, deviceWiped: true, backupDeleted };
}

/**
 * Deletes the cloud copy: every blob, the index, the manifest and the envelope holding the wrapped
 * master key. The Firebase ACCOUNT is not touched -- it holds nothing else, and deleting it would
 * be a visible, externally verifiable event at exactly the wrong moment.
 *
 * A cached `currentUser` is not the same thing as a usable session. Firebase Auth keeps the user
 * object while its token is stale or revoked, and Firestore will answer reads out of its offline
 * cache without ever reaching the server, so "we appear to be signed in" proves nothing. The
 * session is therefore proved first, with a Cloud Storage listing -- authenticated, uncached, and
 * the very operation `disable()` opens with. Nothing is deleted unless it succeeds.
 *
 * The outcome being ruled out is a HALF-deleted backup: some blobs gone, the envelope still
 * standing. That destroys the user's data without achieving what the wipe was for. A token that
 * expires between two of `disable()`'s own calls could still leave the cloud copy part-deleted;
 * that window cannot be closed from the client, and `docs/security.md` says so.
 */
async function deleteCloudBackup(services: Services): Promise<boolean> {
  const backup = services.backup;
  const cloud = services.firebase.cloud;
  const user = cloud?.currentUser ?? null;
  if (backup === null || cloud === null || user === null) return false;

  try {
    await cloud.listBlobs(BACKUP_PATHS.photosPrefix(user.uid));
  } catch {
    // Unauthenticated, offline, or refused. Delete nothing rather than delete some of it.
    return false;
  }
  return quietly(() => backup.disable());
}

/** Runs a teardown step and reports whether it succeeded. Never rejects. */
async function quietly(step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends the cloud session if there is one.
 *
 * A failure here is not worth surfacing: the local wipe has already happened, and an unreachable
 * network is the most likely cause. The next sign-in overwrites the session anyway.
 */
async function signOutQuietly(services: Services): Promise<boolean> {
  const cloud = services.firebase.cloud;
  if (cloud === null || cloud.currentUser === null) return false;
  return quietly(() => cloud.signOut());
}
