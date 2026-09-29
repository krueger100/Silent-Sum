/**
 * Messaging screens against the real composition root.
 *
 * Two accounts share one `InMemoryCloudStore`, so the "other side" in these tests is a genuinely
 * different signed-in user writing to the same database -- not a stub standing in for one. The
 * vault is really unlocked too, because the messaging identity is derived from its master key.
 */
import { act } from '@testing-library/react-native';

import { createServices, type Services } from '@/app/services';
import { BILLING_PATHS, FREE_ENTITLEMENTS, entitlementsToJson } from '@/billing/entitlements';
import { InMemoryBillingService } from '@/billing/billingService';
import { KDF_PRESETS } from '@/crypto';
import { deriveVaultKeys } from '@/crypto/vaultKeys';
import { MASTER_KEY_LENGTH } from '@/crypto/types';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import {
  NoopAnalyticsService,
  NoopCrashReporter,
  type FirebaseServices,
} from '@/firebase/types';
import { InMemoryConversationAdmin } from '@/messaging/conversationAdmin';
import { InMemoryDirectory } from '@/messaging/directory';
import type { MessagingService } from '@/messaging/messagingService';
import { RecordingScreenProtection } from '@/privacy/types';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeClock } from '@/utils/clock';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';

export const PASSWORD = 'account-password';
export const ALICE = 'alice@example.test';
export const BOB = 'bob@example.test';

function masterKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 11) & 0xff;
  return bytes;
}

export interface Account {
  readonly services: Services;
  readonly cloud: InMemoryCloudBackend;
  readonly messaging: MessagingService;
  readonly uid: string;
}

export class MessagingWorld {
  readonly store = new InMemoryCloudStore();
  readonly clock = new FakeClock();
  readonly accounts = new Map<string, string>();

  /** Signs an account in, unlocks its vault, optionally gives it Pro, and publishes its key. */
  async join(
    email: string,
    seed: number,
    options: { pro?: boolean; unlocked?: boolean } = {},
  ): Promise<Account> {
    const cloud = new InMemoryCloudBackend(null, this.store);
    const user = await cloud.signUp(email, PASSWORD);
    this.accounts.set(email, user.uid);
    if (options.pro !== false) {
      this.store.documents.set(
        BILLING_PATHS.entitlements(user.uid),
        entitlementsToJson({ ...FREE_ENTITLEMENTS, pro: true, proSince: this.clock.now() }),
      );
    }

    const firebase: FirebaseServices = {
      available: true,
      crash: new NoopCrashReporter(),
      analytics: new NoopAnalyticsService(),
      cloud,
      billing: new InMemoryBillingService(cloud, this.clock),
      directory: new InMemoryDirectory(
        this.accounts,
        () => services.entitlements.isPro(),
        (peerUid) =>
          this.store.documents.has(`conversations/${[user.uid, peerUid].sort().join('__')}`),
      ),
      // Stands in for the `silentsumDeleteConversation` callable, enforcing the same membership
      // gate and purging through the backend so open listeners on both sides fire.
      conversationAdmin: new InMemoryConversationAdmin(
        () => user.uid,
        async (cid) => {
          for (const path of [...this.store.documents.keys()]) {
            if (path === `conversations/${cid}` || path.startsWith(`conversations/${cid}/`)) {
              await cloud.deleteDocument(path);
            }
          }
          for (const key of [...this.store.blobs.keys()]) {
            if (key.startsWith(`messages/${cid}/`)) await cloud.deleteBlob(key);
          }
        },
      ),
    };
    const services = createServices({
      fs: new InMemoryFileSystem(),
      clock: this.clock,
      secureStore: new InMemorySecureStore(),
      settingsStore: new InMemorySettingsStore(),
      screenProtection: new RecordingScreenProtection(),
      thumbnails: new FakeThumbnailGenerator(),
      kdfParams: KDF_PRESETS.forTests,
      firebase,
    });
    await services.entitlements.refresh();
    if (options.unlocked !== false) {
      // The composition root derives the messaging identity from this. Publishing it is what
      // opening the Messages screen does, so the harness does it here too.
      services.session.adopt(deriveVaultKeys(masterKey(seed)));
      await services.messaging.publishKey();
      await flush();
    }
    return { services, cloud, messaging: services.messaging, uid: user.uid };
  }
}

/**
 * Lets pending microtasks run AND lets React apply what they produced. Opening a conversation
 * fetches the peer key before it can decrypt, so those updates land after the first render and
 * only reach the tree inside `act`.
 */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
