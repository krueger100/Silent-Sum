/**
 * The live support conversation, over the same `CloudBackend` the backup uses.
 *
 * Gating, in one place: reading the history is ALWAYS allowed, so an account whose Cloud term has
 * lapsed can still read what support said. Sending a new message needs an active Cloud term, and
 * only in a build that can actually sell one (`EntitlementsController.enforced`). Nothing here
 * touches the vault, the PIN or any key, so a lapsed term changes the chat and nothing else.
 */
import type { EntitlementsController } from '@/billing/entitlementsController';
import type { SecureRandom } from '@/crypto/types';
import type { CloudBackend } from '@/firebase/types';
import {
  EMPTY_THREAD,
  MESSAGE_PAGE_SIZE,
  SUPPORT_CHAT_PATHS,
  checkMessage,
  parseMessage,
  parseThread,
  unreadCount,
  type MessageProblem,
  type SupportMessage,
  type SupportThread,
} from '@/support/chat/supportChat';
import type { Clock } from '@/utils/clock';

export type SupportChatErrorCode =
  | 'unauthenticated'
  | 'cloud-required'
  | 'rejected'
  | 'unavailable';

export class SupportChatError extends Error {
  constructor(
    readonly code: SupportChatErrorCode,
    /** Set only for `rejected`: what was wrong with the text. */
    readonly problem?: MessageProblem,
  ) {
    super(`SupportChatError(${code})`);
    this.name = 'SupportChatError';
  }
}

export interface SupportChatState {
  readonly messages: readonly SupportMessage[];
  readonly thread: SupportThread;
  readonly unread: number;
  /** False when the account is signed out, or its Cloud term has lapsed in a build that sells. */
  readonly canSend: boolean;
  readonly signedIn: boolean;
  /** True once the first snapshot has arrived. */
  readonly loaded: boolean;
}

export const EMPTY_CHAT_STATE: SupportChatState = {
  messages: [],
  thread: EMPTY_THREAD,
  unread: 0,
  canSend: false,
  signedIn: false,
  loaded: false,
};

export interface SupportChatDeps {
  readonly cloud: CloudBackend | null;
  readonly entitlements: EntitlementsController;
  readonly clock: Clock;
  readonly random: SecureRandom;
}

export class SupportChatService {
  private messages: readonly SupportMessage[] = [];

  private thread: SupportThread = EMPTY_THREAD;

  private loaded = false;

  constructor(private readonly deps: SupportChatDeps) {}

  /** Null when this build has no cloud at all; the screen then says so instead of failing. */
  get available(): boolean {
    return this.deps.cloud !== null;
  }

  private get uid(): string | null {
    return this.deps.cloud?.currentUser?.uid ?? null;
  }

  /** Sending needs an active term only where terms are sold; elsewhere everything is unlocked. */
  canSend(): boolean {
    if (this.uid === null) return false;
    if (!this.deps.entitlements.enforced) return true;
    return this.deps.entitlements.isCloudActive();
  }

  private state(): SupportChatState {
    return {
      messages: this.messages,
      thread: this.thread,
      unread: unreadCount(this.messages, this.thread),
      canSend: this.canSend(),
      signedIn: this.uid !== null,
      loaded: this.loaded,
    };
  }

  /**
   * Subscribes to the thread document and its messages. Emits once straight away with what is
   * known, then on every change. Returns the unsubscribe.
   */
  watch(
    onChange: (state: SupportChatState) => void,
    onError?: (error: SupportChatError) => void,
  ): () => void {
    const { cloud } = this.deps;
    const uid = this.uid;
    if (cloud === null || uid === null) {
      this.loaded = true;
      onChange(this.state());
      return () => undefined;
    }
    const emit = (): void => {
      onChange(this.state());
    };
    const fail = (): void => {
      onError?.(new SupportChatError('unavailable'));
    };
    emit();
    const stopThread = cloud.watchDocument(
      SUPPORT_CHAT_PATHS.thread(uid),
      (doc) => {
        this.thread = parseThread(doc);
        emit();
      },
      fail,
    );
    const stopMessages = cloud.watchCollection(
      SUPPORT_CHAT_PATHS.messages(uid),
      { orderBy: 'createdAt', direction: 'asc', limit: MESSAGE_PAGE_SIZE },
      (entries) => {
        const parsed: SupportMessage[] = [];
        for (const entry of entries) {
          const message = parseMessage(entry.id, entry.data);
          if (message !== null) parsed.push(message);
        }
        this.messages = parsed;
        this.loaded = true;
        emit();
      },
      fail,
    );
    return () => {
      stopThread();
      stopMessages();
    };
  }

  /**
   * Writes one message as the user. Refuses before writing anything: no account, no Cloud term,
   * or text that must never leave the device.
   */
  async send(body: string): Promise<SupportMessage> {
    const { cloud, clock, random } = this.deps;
    if (cloud === null) throw new SupportChatError('unavailable');
    const uid = this.uid;
    if (uid === null) throw new SupportChatError('unauthenticated');
    if (!this.canSend()) throw new SupportChatError('cloud-required');
    const checked = checkMessage(body);
    if (!checked.ok) throw new SupportChatError('rejected', checked.problem);
    const id = `m_${random.hexId(12)}`;
    const createdAt = clock.now();
    await cloud.putDocument(SUPPORT_CHAT_PATHS.message(uid, id), {
      v: 1,
      sender: 'user',
      body: checked.body,
      createdAt,
    });
    return { id, sender: 'user', body: checked.body, createdAt };
  }

  /**
   * Marks everything up to now as seen. Never gated: a lapsed account may still clear its badge.
   * Failure is swallowed -- an unread badge that lingers is not worth an error dialog.
   */
  async markRead(): Promise<void> {
    const { cloud, clock } = this.deps;
    const uid = this.uid;
    if (cloud === null || uid === null) return;
    try {
      await cloud.putDocument(SUPPORT_CHAT_PATHS.thread(uid), {
        v: 1,
        uid,
        userLastReadAt: clock.now(),
      });
    } catch {
      // Leaving the badge up is the correct failure here.
    }
  }
}
