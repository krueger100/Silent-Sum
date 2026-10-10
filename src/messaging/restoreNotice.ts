/**
 * What a restore says about the messages it did or did not bring back.
 *
 * Separate from the restore itself because two screens report it -- the fresh-device flow and the
 * one that restores into an already-open vault -- and a user who reads one sentence on one screen
 * and a different sentence on the other has been told the app is unsure.
 *
 * Null for the ordinary success, where the photos line already says everything and "and your
 * messages too" is noise. The failures are the ones worth words, because each has a different
 * answer and only one of them is the user's to act on.
 */
import type { RecoveredIdentityResult } from '@/messaging/messagingService';

export function describeMessagingRestore(outcome: RecoveredIdentityResult): string | null {
  switch (outcome) {
    case 'ok':
      return null;
    case 'historical':
      // Deliberately describes the key rather than promising an outcome: what opens is whatever
      // was sealed under it, which the thread list is about to show for itself.
      return (
        'This vault holds an older messaging key for this account. Conversations sealed under ' +
        'that key will open; sending needs the current key, which is on another device.'
      );
    case 'mismatch':
      // Says nothing about the photos. It used to end "Everything else was restored.", which the
      // device showed sitting directly after "There was nothing in the backup to restore." -- two
      // sentences contradicting each other in one line. What happened to the photos is already
      // the photo sentences' job, and this one has no business guessing at it.
      return (
        'Your messages could not be unlocked: this account\u2019s messaging was set up by a ' +
        'different vault, and only that vault\u2019s recovery passphrase can read them.'
      );
    case 'unavailable':
      // Not a failure to report as one: this account simply has no messaging to restore, and
      // sending the user to check their connection for it is a wild goose chase.
      return (
        'This account has not set messaging up yet, so there were no messages to restore. ' +
        'Open Messages when you want to start.'
      );
    case 'unreachable':
      return (
        'Your messages could not be unlocked yet \u2014 this account\u2019s messaging key could ' +
        'not be checked. Open Messages once you are back online to try again.'
      );
  }
}
