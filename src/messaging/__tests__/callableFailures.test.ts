/**
 * What a failed lookup actually says to the user.
 *
 * Every refusal the directory can give used to collapse into one sentence -- "Messaging is not
 * available in this build." -- which is true of a build with no Firebase in it and of nothing
 * else. Said to somebody whose App Check token was not registered, or whose callable answered
 * 404 because it was never deployed, it describes the binary rather than the fault, and sends
 * whoever reads it to look in the wrong place entirely. That is not hypothetical: it cost an
 * afternoon.
 *
 * These tests pin each refusal to its own sentence, and pin the one sentence that must never be
 * reused for a server failure.
 */
import { EntitlementsController } from '@/billing/entitlementsController';
import { SequentialRandom } from '@/crypto/random';
import { MASTER_KEY_LENGTH } from '@/crypto/types';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { deriveMessagingIdentity } from '@/messaging/identity';
import { DirectoryError, type Directory, type DirectoryErrorCode } from '@/messaging/directory';
import {
  MessagingError,
  MessagingService,
  describeMessagingError,
  type MessagingErrorCode,
} from '@/messaging/messagingService';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeClock } from '@/utils/clock';

const BUILD_SENTENCE = 'Messaging is not available in this build.';

function masterKey(): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (7 + i * 11) & 0xff;
  return bytes;
}

/** A service whose only interesting dependency is a directory that refuses. */
async function serviceRefusing(code: DirectoryErrorCode): Promise<MessagingService> {
  const store = new InMemoryCloudStore();
  const fs = new InMemoryFileSystem();
  const cloud = new InMemoryCloudBackend(fs, store);
  await cloud.signUp('me@example.test', 'account-password');
  const clock = new FakeClock();
  const directory: Directory = {
    findByEmail: () => Promise.reject(new DirectoryError(code)),
    emailForUid: () => Promise.resolve(null),
  };
  return new MessagingService({
    cloud,
    directory,
    entitlements: new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock,
      cloud,
      enforced: false,
    }),
    clock,
    random: new SequentialRandom(1),
    identity: () => deriveMessagingIdentity(masterKey()),
  });
}

async function codeOf(service: MessagingService): Promise<MessagingErrorCode | string> {
  try {
    await service.startConversation('someone@example.test');
  } catch (error) {
    return error instanceof MessagingError ? error.code : `not-a-messaging-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('a directory refusal reaching the user', () => {
  it.each([
    ['attestation', 'attestation'],
    ['unauthenticated', 'unauthenticated'],
    ['pro-required', 'pro-required'],
    ['rate-limited', 'rate-limited'],
    ['invalid-email', 'invalid-email'],
    ['offline', 'offline'],
    ['unavailable', 'unavailable'],
  ] as const)('carries %s through as %s', async (from, expected) => {
    expect(await codeOf(await serviceRefusing(from))).toBe(expected);
  });

  /**
   * The one that started this. An App Check failure is a registration problem with a concrete
   * remedy; describing it as a property of the build hides that completely.
   */
  it('never tells a user with an App Check problem that it is their build', async () => {
    const code = await codeOf(await serviceRefusing('attestation'));
    expect(code).toBe('attestation');
    const message = describeMessagingError('attestation');
    expect(message).not.toBe(BUILD_SENTENCE);
    expect(message).toMatch(/could not prove|genuine/i);
  });

  it('never tells a user whose server answered badly that it is their build', async () => {
    // `unavailable` is where a 404 from an undeployed function, a 500, and an unrecognised body
    // all land. None of them is about the binary on the phone.
    const message = describeMessagingError('unavailable');
    expect(message).not.toBe(BUILD_SENTENCE);
    expect(message).toMatch(/server/i);
  });

  it('separates a connection that never reached the server from one that answered', async () => {
    expect(describeMessagingError('offline')).not.toBe(describeMessagingError('unavailable'));
    expect(describeMessagingError('offline')).toMatch(/connection|reach/i);
  });

  /**
   * The sentence still exists and is still correct -- for the case it was written for, which the
   * screen renders for itself when the build genuinely has no Firebase. Nothing here should have
   * taken it away.
   */
  it('keeps the build sentence available for the case that really is the build', () => {
    const every: MessagingErrorCode[] = [
      'unauthenticated', 'attestation', 'locked', 'pro-required', 'offline', 'rate-limited',
      'invalid-email', 'no-such-user', 'self', 'peer-has-no-key', 'rejected', 'not-mine',
      'vault-refused', 'expired', 'unavailable',
    ];
    // No runtime failure claims to be the build any more.
    for (const code of every) expect(describeMessagingError(code)).not.toBe(BUILD_SENTENCE);
  });
});
