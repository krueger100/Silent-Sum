/**
 * User-facing copy for cloud and backup failures.
 *
 * Raw SDK messages are never shown: they can carry e-mail addresses, uids and storage paths, and a
 * screenshot of an error dialog is exactly the kind of thing that ends up in a chat thread. Only
 * the code is inspected, and anything unrecognised becomes a generic sentence.
 */
import {
  AccountDataRemainsError,
  BackupNotEnabledError,
  ForeignBackupError,
  ForeignVaultError,
  InvalidPassphraseError,
  VaultIdMismatchError,
  WrongPassphraseError,
} from '@/backup/types';
import { CloudError } from '@/firebase/types';
import { InvalidPinError, VaultAlreadyExistsError } from '@/auth/types';

/** The codes this app branches on, plus the Firebase Auth codes the SDK reports verbatim. */
const MESSAGES: Readonly<Record<string, string>> = {
  'wrong-password': 'Wrong email or password.',
  'invalid-credential': 'Wrong email or password.',
  'user-not-found': 'Wrong email or password.',
  'invalid-login-credentials': 'Wrong email or password.',
  'user-disabled': 'That account has been disabled.',
  'email-already-in-use': 'An account with that email already exists. Sign in instead.',
  'weak-password': 'Choose a longer password for the account.',
  'invalid-email': 'That email address is not valid.',
  'missing-password': 'Enter the account password.',
  'missing-email': 'Enter the account email address.',
  'internal-error': 'The backup service could not complete that. Check the email and password.',
  'operation-not-allowed': 'Email and password accounts are turned off for this project.',
  'admin-restricted-operation': 'This project does not allow creating accounts from the app.',
  'network-request-failed': 'No network connection. Cloud backup needs one; the vault does not.',
  'unavailable': 'The backup service is unreachable right now. Try again later.',
  'deadline-exceeded': 'The backup service took too long to answer. Try again.',
  'too-many-requests': 'Too many attempts. Wait a while and try again.',
  // Deleting an account is the one operation the provider will not accept on an old session. The
  // screen re-proves the password before it deletes anything, so reaching this means the session
  // went stale mid-operation; signing out and back in is the reliable way through.
  'requires-recent-login':
    'That sign-in is too old for this. Sign out, sign back in, and try again. You are still ' +
    'signed in and nothing was deleted.',
  unauthenticated: 'Sign in to your backup account first.',
  'permission-denied': 'The server refused that request. You can only reach your own backup.',
  'object-not-found': 'That backup file is no longer in the cloud.',
  cancelled: 'That request was cancelled.',
  unknown: 'The backup service reported a problem. Try again.',
};

/**
 * A friendly sentence for anything the backup screens can throw. Never returns `undefined`, so a
 * caller can always show something.
 */
export function describeCloudError(error: unknown): string {
  if (error instanceof CloudError) {
    return MESSAGES[error.code.toLowerCase()] ?? 'The backup service reported a problem. Try again.';
  }
  if (error instanceof WrongPassphraseError) {
    return 'Wrong recovery passphrase. Nothing on the device was changed.';
  }
  if (error instanceof BackupNotEnabledError) {
    return 'This account has no backup yet. Enable backup first.';
  }
  // Says the account still exists, because that is the reassuring half: nothing is stranded yet,
  // and the account is what can still reach the leftovers.
  if (error instanceof AccountDataRemainsError) {
    return (
      `Some of this account's data could not be deleted (${String(error.remaining)} left), so the ` +
      'account was kept rather than leaving those files stranded. Check your connection and try ' +
      'again.'
    );
  }
  // Not a fault, and the sentence says what to press. Any vault erased and set up again reaches
  // this, and "Something went wrong" made a normal situation look like a broken app.
  if (error instanceof ForeignBackupError) {
    return (
      'This account\'s backup was made by a different vault, so this device cannot add to it. ' +
      'Use "Restore from backup" below to bring those photos in -- nothing here is changed or ' +
      'deleted. Nothing was uploaded.'
    );
  }
  // The same situation `ForeignBackupError` describes, caught earlier and stated more plainly:
  // the account's backup says outright which vault it belongs to, and it is not this one.
  if (error instanceof VaultIdMismatchError) {
    return (
      'This account\'s backup belongs to a different vault, so this device cannot add to it. ' +
      'Use "Restore from backup" to bring those photos in -- nothing here is changed or deleted. ' +
      'Nothing was uploaded.'
    );
  }
  // A question rather than a failure: the photos on this device belong to another account's
  // backup, and the user has not yet said they want a copy in this one.
  if (error instanceof ForeignVaultError) {
    return (
      'The photos on this device are backed up to a different account. Nothing was uploaded. ' +
      'Confirm the upload if you want a copy of them in this account as well.'
    );
  }
  // Our own validation message; it describes the rule, never the passphrase.
  if (error instanceof InvalidPassphraseError) return error.message;
  if (error instanceof InvalidPinError) return error.message;
  if (error instanceof VaultAlreadyExistsError) {
    return 'A vault already exists on this device. Erase it before restoring a backup.';
  }
  return 'Something went wrong. Nothing was changed.';
}
