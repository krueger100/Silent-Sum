/**
 * A failed send has to answer two questions, and the second is the one the old code could not:
 * what went wrong, and would tapping again help?
 *
 * Offering "Tap to retry" for a failure no retry can fix is how a working button comes to look
 * dead -- the retry re-runs the identical operation, fails in the same tick, and leaves the bubble
 * saying exactly what it said before.
 */
import { CloudError } from '@/firebase/types';
import { MessagingError } from '@/messaging/messagingService';
import { describeSendFailure } from '@/messaging/sendFailure';
import { FileNotFoundError } from '@/storage/fileSystem';
import { ImageDecodeError } from '@/vault/types';

describe('describeSendFailure', () => {
  it('keeps the vocabulary the composer already uses for a refused message', () => {
    expect(describeSendFailure(new MessagingError('rejected', 'pin')).message).toMatch(
      /never send your pin/i,
    );
    expect(describeSendFailure(new MessagingError('pro-required')).message).toMatch(/pro/i);
  });

  it('tells someone what to do about a photo that cannot be made to fit', () => {
    // Reached only after the send has already tried re-encoding it smaller, so "choose a smaller
    // photo" is the one remaining action rather than the first thing the user is told.
    const photo = describeSendFailure(new MessagingError('rejected', 'photo-too-large'));
    expect(photo.message).toBe('This photo is too large to send. Please choose a smaller photo.');
    expect(photo.retryable).toBe(false);

    // A video has no re-encode path at all, so its wording points at a shorter one.
    const video = describeSendFailure(new MessagingError('rejected', 'video-too-large'));
    expect(video.message).toMatch(/video is too large/i);
    expect(video.retryable).toBe(false);
  });

  it('treats an undecodable image as permanent, not as a dropped connection', () => {
    const failure = describeSendFailure(new ImageDecodeError('no decoder'));
    expect(failure.message).toMatch(/could not be read/i);
    expect(failure.retryable).toBe(false);
  });

  it('offers no retry for anything a retry cannot change', () => {
    const hopeless = [
      new MessagingError('pro-required'),
      new MessagingError('locked'),
      new MessagingError('attestation'),
      new MessagingError('peer-has-no-key'),
      new MessagingError('rejected', 'too-long'),
      new MessagingError('rejected', 'photo-too-large'),
      new MessagingError('rejected', 'video-too-large'),
      new MessagingError('vault-refused'),
      new MessagingError('unavailable'),
      new MessagingError('unauthenticated'),
      // A rules refusal: not Pro any more, an oversized preview, a build the server will not
      // attest. Every attempt is refused the same way.
      new CloudError('permission-denied'),
      new FileNotFoundError('file:///gone.jpg'),
      new ImageDecodeError('unreadable'),
    ];
    for (const error of hopeless) {
      expect(describeSendFailure(error)).toEqual({
        message: expect.any(String),
        retryable: false,
      });
    }
  });

  it('offers a retry for a transport failure, which is the only kind worth one', () => {
    expect(describeSendFailure(new CloudError('unknown')).retryable).toBe(true);
    expect(describeSendFailure(new Error('network request failed')).retryable).toBe(true);
  });

  it('says the source is gone rather than blaming the network', () => {
    // A vault video is decrypted to a scratch file that is released as soon as the first attempt
    // settles, so a failed one has no source left. "Try again" there is a lie.
    expect(describeSendFailure(new FileNotFoundError('file:///scratch.mp4')).message).toMatch(
      /no longer/i,
    );
  });

  it('never puts a path in front of the user', () => {
    const shown = describeSendFailure(new FileNotFoundError('file:///vault/secret-123.mp4'));
    expect(shown.message).not.toContain('secret-123');
    expect(shown.message).not.toContain('file://');
  });
});
