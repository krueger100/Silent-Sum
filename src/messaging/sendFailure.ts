/**
 * Why a send failed, and whether tapping again could change that.
 *
 * The outgoing tray used to keep one boolean -- `failed` -- and discard the error. Every failure
 * therefore produced the same bubble, "Tap to retry", including the ones no retry can ever fix:
 * not Pro, a rules refusal, a source file that no longer exists. Tapping re-ran the identical
 * operation, which failed in the same tick, so React folded `failed: false` and `failed: true`
 * into one render and the bubble came back unchanged. From the outside that is a dead button, and
 * that is what it was reported as.
 *
 * So a failure is described once, here, and carries its own answer to "would it help?".
 *
 * The rule for `retryable` is deliberately pessimistic: only a transport failure earns a retry.
 * Every `MessagingError` the send path raises is a decision the server or the device has already
 * made -- the vault is locked, the account is not Pro, the peer published no key, the item is over
 * a cap -- and none of them changes because the same bytes are offered a second time.
 */
import { CloudError } from '@/firebase/types';
import { describeMessageProblem, type MessageProblem } from '@/messaging/messaging';
import {
  MessagingError,
  describeMessagingError,
  type MessagingErrorCode,
} from '@/messaging/messagingService';
import { FileNotFoundError } from '@/storage/fileSystem';
import { ImageDecodeError } from '@/vault/types';

export interface SendFailure {
  /** What the user is told. Never a path, a code or an exception message. */
  readonly message: string;
  /** False when nothing about tapping again could change the outcome. */
  readonly retryable: boolean;
}

/**
 * `vault-refused` carries a `GateReason` rather than a `MessageProblem`, and the two overlap as
 * strings, so the ones that belong to the vault's caps are excluded by name.
 */
function isMessageProblem(problem: unknown): problem is MessageProblem {
  return typeof problem === 'string' && problem !== 'itemLimit' && problem !== 'fileSize';
}

/**
 * Exhaustive on purpose: a new code has to come here and say whether a retry could help, rather
 * than inheriting an answer that happens to be wrong for it.
 */
function codeIsRetryable(code: MessagingErrorCode): boolean {
  switch (code) {
    // The one failure here that a later tap can genuinely fix: the request never reached the
    // server, so nothing was decided and nothing is stale. Everything below was an answer.
    case 'offline':
      return true;
    case 'unauthenticated':
    case 'attestation':
    case 'locked':
    case 'pro-required':
    case 'rate-limited':
    case 'invalid-email':
    case 'no-such-user':
    case 'self':
    case 'peer-has-no-key':
    // Tapping again re-derives the same identity from the same vault and reaches the same
    // conclusion. Only recovering the vault changes this one.
    case 'foreign-vault':
    // Recovering the CURRENT key changes this. Offering the same send again does not.
    case 'historical-identity':
    case 'rejected':
    case 'not-mine':
    case 'vault-refused':
    case 'expired':
    case 'unavailable':
      return false;
  }
}

export function describeSendFailure(error: unknown): SendFailure {
  if (error instanceof MessagingError) {
    const message =
      error.code === 'rejected' && isMessageProblem(error.problem)
        ? describeMessageProblem(error.problem)
        : describeMessagingError(error.code);
    return { message, retryable: codeIsRetryable(error.code) };
  }

  // The plaintext the send was reading is gone. Nothing here can get it back: a vault video's
  // scratch file is released as soon as the first attempt settles, and a picked file lives in a
  // cache the system may clear. The remedy is to choose the item again, so say that.
  if (error instanceof FileNotFoundError) {
    return {
      message: 'That item is no longer on this device. Choose it again.',
      retryable: false,
    };
  }

  // The platform could not decode it. Offering a retry would re-run the same decoder over the
  // same bytes, so the only useful answer is to pick something else.
  if (error instanceof ImageDecodeError) {
    return { message: 'That image could not be read. Choose another one.', retryable: false };
  }

  if (error instanceof CloudError) {
    if (error.code === 'permission-denied') {
      return {
        message:
          'The server refused this upload. Check that Pro is still active on this account, then ' +
          'choose the item again.',
        retryable: false,
      };
    }
    if (error.code === 'unauthenticated') {
      return { message: describeMessagingError('unauthenticated'), retryable: false };
    }
  }

  // Anything left is a dropped connection, a timeout, or a fault nobody has classified. A retry
  // is the right offer for all three.
  return { message: 'That could not be sent. Tap to try again.', retryable: true };
}
