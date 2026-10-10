/**
 * Getting an account's messaging back, in the order that costs the user least.
 *
 * Two keys can open an account's messaging and they are usually the same one: the master key in
 * the backup envelope, and the master key in the messaging escrow. They diverge exactly when this
 * vault is not the one that set the account's messaging up -- after a rebind, a reinstall onto a
 * fresh vault, or a second account opened on a device that already had one.
 *
 * So this tries the cheap answer first. A caller that has just restored a backup is already
 * holding the vault master key; on an account that was never rebound that key IS the messaging
 * key, and handing it over costs nothing. Only when it is refused is a second Argon2id spent on
 * the escrow -- which is the derivation the user would otherwise have had to ask for by hand,
 * from a banner, after noticing that none of their messages would open.
 *
 * Every path ends at `useRecoveredMasterKey`, which derives the identity and compares it to what
 * the account published before accepting anything. Nothing here can bypass that check, and
 * nothing here writes to `messagingKeys`.
 */
import type { BackupService } from '@/backup/types';
import type { MessagingService, RecoveredIdentityResult } from '@/messaging/messagingService';
import { zeroBytes, type Bytes } from '@/utils/bytes';

export interface IdentityRecoveryOptions {
  /**
   * A master key the caller already has, typically straight out of a restore.
   *
   * Tried first and never zeroed here -- it belongs to the caller, which is already zeroing it.
   */
  readonly vaultMasterKey?: Bytes;
  /**
   * The messaging key, already recovered, for a caller that no longer has the passphrase.
   *
   * The fresh-device flow clears the passphrase the moment it has unwrapped the envelope, which
   * is the right thing to do with it -- so that screen derives this at the same moment, while the
   * passphrase is legitimately in hand, and hands the key over here instead. Used in place of
   * `recoverMessagingKey`, and like `vaultMasterKey` it belongs to the caller.
   */
  readonly messagingMasterKey?: Bytes;
}

/**
 * Restores this device's ability to read the account's conversations.
 *
 * `'ok'` means the identity is in place and the threads will re-read themselves. `'mismatch'`
 * means neither key is the account's: a third vault set its messaging up and only that one can
 * read it. `'unavailable'` means there is nothing to recover -- nobody signed in, no cloud in this
 * build, or an account that has published no key at all. `'unreachable'` means the question was
 * asked and the server did not answer, which is the retryable one.
 */
export async function restoreMessagingIdentity(
  backup: BackupService,
  messaging: MessagingService,
  passphrase: string,
  options?: IdentityRecoveryOptions,
): Promise<RecoveredIdentityResult> {
  const alreadyHeld = options?.vaultMasterKey;
  if (alreadyHeld !== undefined) {
    const outcome = await messaging.useRecoveredMasterKey(alreadyHeld);
    // Only a refusal is worth paying for the escrow. Neither 'unavailable' nor 'unreachable'
    // got as far as comparing anything, and the escrow path would ask the same question of the same
    // server and get the same answer, one Argon2id later.
    if (outcome !== 'mismatch') return outcome;
    // And a refusal is only worth paying for when the escrow holds something ELSE. With no escrow
    // -- an account from before it existed, or a project whose rules do not allow it yet --
    // `recoverMessagingKey` IS `recoverMasterKey`, so the second Argon2id would hand back the key
    // that was just refused and get the same answer. That is a slow spinner bought for nothing.
    if (options?.messagingMasterKey === undefined && (await backup.messagingKeyIsMine(alreadyHeld))) {
      return 'mismatch';
    }
  }

  const alreadyRecovered = options?.messagingMasterKey;
  if (alreadyRecovered !== undefined) {
    return messaging.useRecoveredMasterKey(alreadyRecovered);
  }

  let recovered: Bytes | null = null;
  try {
    recovered = await backup.recoverMessagingKey(passphrase);
    return await messaging.useRecoveredMasterKey(recovered);
  } finally {
    if (recovered !== null) zeroBytes(recovered);
  }
}
