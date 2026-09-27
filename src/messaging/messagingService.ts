/**
 * User-to-user messaging: the whole feature, minus the screens.
 *
 * Three things make it what it is.
 *
 * END TO END. Bodies are encrypted on this device with a key only the two participants can
 * compute, and the ciphertext is what Firestore stores. The server, the operators and anyone who
 * ever gets at the database see a base64 blob, a sender id and a timestamp. That also means
 * messaging needs an UNLOCKED vault: the identity is derived from the vault master key, so a
 * locked app can show that conversations exist but not what is in them.
 *
 * PRO IS SERVER-ENFORCED. `canSend` here exists so the composer can be disabled politely, and it
 * is not the gate. The real gate is in two places the client cannot reach: the security rules
 * refuse a message create unless the sender's server-written entitlement document says `pro`,
 * and the lookup callable refuses to resolve an address for anyone else. A patched client that
 * lies about Pro gets `permission-denied` from Firestore.
 *
 * CONVERSATIONS ARE SHARED, CONTACTS ARE NOT. `conversations/...` is the one place in the app
 * where two accounts write to the same document, and it holds no addresses -- only uids, counts
 * and ciphertext. The address you typed to find someone is kept in your own subtree, encrypted
 * with your own key, so the database never learns who knows whom by e-mail.
 */
import type { GateReason } from '@/billing/entitlements';
import type { EntitlementsController } from '@/billing/entitlementsController';
import type { SecureRandom } from '@/crypto/types';
import { increment, type CloudBackend } from '@/firebase/types';
import { DirectoryError, type Directory } from '@/messaging/directory';
import type { MessagingIdentity } from '@/messaging/identity';
import {
  CONVERSATION_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  MESSAGING_PATHS,
  byRecency,
  checkMessage,
  conversationIdFor,
  conversationRecord,
  mediaRecord,
  membersOf,
  messageRecord,
  parseConversation,
  parsePublishedKey,
  parseStoredMessage,
  peerOf,
  publishedKeyRecord,
  type Conversation,
  type DecryptedMessage,
  type MessageProblem,
  type StoredMessage,
} from '@/messaging/messaging';
import { openMessage, sealMessage } from '@/messaging/messageCipher';
import {
  capFor,
  openMedia,
  openThumb,
  sealMedia,
  sealThumb,
  packSealed,
  unpackSealed,
  THUMB_MAX_EDGE,
  type MediaBinding,
  type MediaKind,
} from '@/messaging/media';
import type { FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import type { PlaybackScratch } from '@/vault/playbackScratch';
import type { VaultRepository , ThumbnailGenerator, VideoThumbnailGenerator } from '@/vault/types';
import { base64Decode, base64Encode } from '@/utils/base64';
import type { Clock } from '@/utils/clock';
import { utf8Decode, utf8Encode, type Bytes } from '@/utils/bytes';
import { aeadDecrypt, aeadEncrypt, SODIUM_AEAD_NONCE_BYTES } from '@/crypto/sodium';

/**
 * The slice of the vault that keeping a received item needs. Narrowed deliberately: a messaging
 * method has no business holding the whole repository, and the narrower type is what lets a test
 * stand in something honest rather than a mock of thirteen methods it never calls.
 */
export type VaultSink = Pick<VaultRepository, 'photos' | 'addPhoto' | 'addVideo'>;

export type MessagingErrorCode =
  /** Nobody is signed in to a backup account. */
  | 'unauthenticated'
  /** The vault is locked, so there is no key to encrypt or decrypt with. */
  | 'locked'
  /** Not Pro. Starting and sending both need it; reading never does. */
  | 'pro-required'
  /** The address resolved to nobody. */
  | 'no-such-user'
  /** You cannot start a conversation with yourself. */
  | 'self'
  /** The other account has never opened messaging, so it has published no key. */
  | 'peer-has-no-key'
  /** The text was refused before anything was written. */
  | 'rejected'
  /**
   * The vault would not take this item: its 50-item free cap or its 100 MB per-item cap. Kept
   * separate from `rejected` because the remedy is different -- one is a limit with an upsell
   * behind it, the other is a message that should not be sent at all.
   */
  | 'vault-refused'
  /**
   * The media object is gone. After 30 days that is the ordinary end state of every media
   * message, not a fault -- distinct from `unavailable` so the screen can say "expired" rather
   * than "something went wrong", which would send a user looking for a problem to fix.
   */
  | 'expired'
  /** No cloud backend in this build, or the store refused. */
  | 'unavailable';

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    /** For `rejected`, what was wrong with the text; for `vault-refused`, which cap bit. */
    readonly problem?: MessageProblem | GateReason,
  ) {
    super(`MessagingError(${code})`);
    this.name = 'MessagingError';
  }
}

export function describeMessagingError(code: MessagingErrorCode): string {
  switch (code) {
    case 'unauthenticated':
      return 'Sign in to your backup account first.';
    case 'locked':
      return 'Unlock the vault to read and send messages.';
    case 'pro-required':
      return 'Messaging is a Pro feature.';
    case 'no-such-user':
      return 'Nobody here uses that address.';
    case 'self':
      return 'That is your own address.';
    case 'peer-has-no-key':
      return 'That person has not set up messaging yet. Ask them to open Messages once.';
    case 'rejected':
      return 'That message was not sent.';
    case 'vault-refused':
      return 'The vault would not take this item.';
    case 'expired':
      return 'This has expired. Media is kept for 30 days.';
    case 'unavailable':
      return 'Messaging is not available in this build.';
  }
}

/** One row of the conversation list. */
export interface ConversationView extends Conversation {
  /** What this account privately calls the other one -- the address it looked up. */
  readonly label: string | null;
}

export interface MessagingState {
  readonly conversations: readonly ConversationView[];
  readonly totalUnread: number;
  readonly signedIn: boolean;
  readonly unlocked: boolean;
  /** Pro, as this device last saw it. The server decides for real. */
  readonly canMessage: boolean;
  readonly loaded: boolean;
}

export const EMPTY_MESSAGING_STATE: MessagingState = {
  conversations: [],
  totalUnread: 0,
  signedIn: false,
  unlocked: false,
  canMessage: false,
  loaded: false,
};

/**
 * Why the composer is not available, when it is not.
 *
 * `preparing` is the one that is not a fault: the conversation key is derived from the peer's
 * published key, which is fetched, so there is a moment after opening a thread where sending is
 * not yet possible and nothing at all is wrong. Everything else is a real cause, and the screen
 * says which -- a composer that blames Pro for a locked vault sends the user to the wrong place.
 */
export type SendBlock = MessagingErrorCode | 'preparing';

export function describeSendBlock(block: SendBlock): string {
  switch (block) {
    case 'preparing':
      return 'Getting this conversation ready…';
    case 'pro-required':
      return 'Sending is part of SilentSum Pro. You can still read anything sent to you.';
    case 'locked':
      return 'Unlock the vault to send. Messages are encrypted with a key derived from it.';
    case 'peer-has-no-key':
      return 'They have not set up messaging yet, so there is nothing to encrypt to. Ask them to open Messages once.';
    case 'unavailable':
      return 'This conversation could not be set up on this device. Try again.';
    default:
      return describeMessagingError(block);
  }
}

export interface ConversationState {
  readonly id: string;
  readonly peerUid: string;
  readonly label: string | null;
  readonly messages: readonly DecryptedMessage[];
  readonly canSend: boolean;
  /** Why not, when `canSend` is false. Null exactly when it is true. */
  readonly sendBlocked: SendBlock | null;
  readonly loaded: boolean;
  /** Set when the conversation cannot be read or written at all. */
  readonly problem: MessagingErrorCode | null;
}

export interface MessagingDeps {
  readonly cloud: CloudBackend | null;
  readonly directory: Directory | null;
  readonly entitlements: EntitlementsController;
  readonly clock: Clock;
  readonly random: SecureRandom;
  /** The unlocked session's messaging identity, or null while the vault is locked. */
  readonly identity: () => MessagingIdentity | null;
  /**
   * Everything media needs. Absent in a build or a test with no media: `sendMedia` and the fetch
   * pair then refuse with `unavailable` rather than crashing, exactly as an absent cloud does.
   */
  readonly media?: MediaDeps;
}

/**
 * One item to send, from whichever of the three sources produced it.
 *
 * `bytes` is present when the caller already holds the plaintext -- the vault hands over
 * decrypted bytes rather than a file -- and absent when only a path exists, which is what the
 * camera and the picker produce. Either way the service sees one item and one kind, and does not
 * know or care where it came from.
 */
export interface MediaSource {
  readonly uri: string;
  readonly kind: MediaKind;
  readonly bytes?: Bytes;
}

export interface MediaDeps {
  readonly fs: FileSystem;
  readonly secureDelete: SecureDelete;
  readonly thumbnails: ThumbnailGenerator;
  readonly videoThumbnails: VideoThumbnailGenerator;
  /** Where plaintext media is written to be displayed; purged on background. */
  readonly scratch: PlaybackScratch;
}

const CONTACT_AAD = 'silentsum/contact/v1';

export class MessagingService {
  private conversations: readonly Conversation[] = [];

  private labels = new Map<string, string>();

  private loaded = false;

  /** Peer uid -> published public key bytes. Cleared whenever the identity goes away. */
  private readonly peerKeys = new Map<string, Bytes>();

  /** Peers whose address has already been asked for. One attempt each, per unlocked session. */
  private readonly namedPeers = new Set<string>();

  /**
   * Whether the contacts listener has delivered once. Until it has, an absent label means "not
   * loaded yet" rather than "unknown", and asking the directory about a peer this account already
   * named would spend the hourly budget on an answer it is holding.
   */
  private contactsLoaded = false;

  constructor(private readonly deps: MessagingDeps) {}

  /** False in a build with no cloud backend: the screen says so rather than failing. */
  get available(): boolean {
    return this.deps.cloud !== null && this.deps.directory !== null;
  }

  private get uid(): string | null {
    return this.deps.cloud?.currentUser?.uid ?? null;
  }

  private get unlocked(): boolean {
    const identity = this.deps.identity();
    return identity !== null && !identity.isDisposed;
  }

  /**
   * What the UI shows as "you can write here". Pro is taken from the mirrored entitlement
   * document; in a build that sells nothing, everything is open.
   */
  canMessage(): boolean {
    if (this.uid === null || !this.unlocked) return false;
    if (!this.deps.entitlements.enforced) return true;
    return this.deps.entitlements.isPro();
  }

  private requireIdentity(): MessagingIdentity {
    const identity = this.deps.identity();
    if (identity === null || identity.isDisposed) throw new MessagingError('locked');
    return identity;
  }

  private requireUid(): string {
    const uid = this.uid;
    if (uid === null) throw new MessagingError('unauthenticated');
    return uid;
  }

  private requireCloud(): CloudBackend {
    const { cloud } = this.deps;
    if (cloud === null) throw new MessagingError('unavailable');
    return cloud;
  }

  // -------------------------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------------------------

  /**
   * Publishes this account's public key, so others can start a conversation with it. Safe to call
   * on every unlock: it writes only when the stored key differs from the derived one.
   */
  async publishKey(): Promise<void> {
    const cloud = this.deps.cloud;
    const uid = this.uid;
    const identity = this.deps.identity();
    if (cloud === null || uid === null || identity === null || identity.isDisposed) return;
    const encoded = base64Encode(identity.publicKey);
    try {
      const existing = parsePublishedKey(uid, await cloud.getDocument(MESSAGING_PATHS.publicKey(uid)));
      if (existing?.publicKey === encoded) return;
      await cloud.putDocument(
        MESSAGING_PATHS.publicKey(uid),
        publishedKeyRecord(uid, encoded, this.deps.clock.now()),
      );
    } catch {
      // Publishing is best effort; the next unlock tries again. Nothing else depends on it
      // having happened by any particular moment.
    }
  }

  private async peerKey(peerUid: string): Promise<Bytes> {
    const cached = this.peerKeys.get(peerUid);
    if (cached !== undefined) return cached;
    const cloud = this.requireCloud();
    let doc: Record<string, unknown> | null;
    try {
      doc = await cloud.getDocument(MESSAGING_PATHS.publicKey(peerUid));
    } catch {
      throw new MessagingError('unavailable');
    }
    const published = parsePublishedKey(peerUid, doc);
    if (published === null) throw new MessagingError('peer-has-no-key');
    let bytes: Bytes;
    try {
      bytes = base64Decode(published.publicKey);
    } catch {
      throw new MessagingError('peer-has-no-key');
    }
    this.peerKeys.set(peerUid, bytes);
    return bytes;
  }

  /** Drops every cached peer key. Called when the vault locks or the account changes. */
  forgetKeys(): void {
    this.peerKeys.clear();
    this.labels = new Map();
    this.namedPeers.clear();
    this.contactsLoaded = false;
  }

  // -------------------------------------------------------------------------------------------
  // Contact labels (private to this account, encrypted with its own key)
  // -------------------------------------------------------------------------------------------

  private contactPath(peerUid: string): string {
    return `users/${this.requireUid()}/contacts/${peerUid}`;
  }

  private sealLabel(peerUid: string, label: string): Record<string, unknown> {
    const identity = this.requireIdentity();
    const nonce = this.deps.random.bytes(SODIUM_AEAD_NONCE_BYTES);
    const box = aeadEncrypt(
      utf8Encode(label),
      `${CONTACT_AAD}|${peerUid}`,
      nonce,
      identity.contactsKey,
    );
    return {
      v: 1,
      box: base64Encode(box),
      nonce: base64Encode(nonce),
      updatedAt: this.deps.clock.now(),
    };
  }

  private openLabel(peerUid: string, data: Record<string, unknown>): string | null {
    const identity = this.deps.identity();
    if (identity === null || identity.isDisposed) return null;
    const box = data.box;
    const nonce = data.nonce;
    if (typeof box !== 'string' || typeof nonce !== 'string') return null;
    try {
      return utf8Decode(
        aeadDecrypt(
          base64Decode(box),
          `${CONTACT_AAD}|${peerUid}`,
          base64Decode(nonce),
          identity.contactsKey,
        ),
      );
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The conversation list
  // -------------------------------------------------------------------------------------------

  private state(): MessagingState {
    const conversations = this.conversations
      .map((conversation) => ({
        ...conversation,
        label: this.labels.get(conversation.peerUid) ?? null,
      }))
      .sort(byRecency);
    return {
      conversations,
      totalUnread: conversations.reduce((sum, one) => sum + one.unread, 0),
      signedIn: this.uid !== null,
      unlocked: this.unlocked,
      canMessage: this.canMessage(),
      loaded: this.loaded,
    };
  }

  /**
   * Subscribes to every conversation this account is in, newest first. Emits immediately with
   * what is already known and again on every change. Reading the list never requires Pro or an
   * unlocked vault -- only the bodies do.
   */
  watch(
    onChange: (state: MessagingState) => void,
    onError?: (error: MessagingError) => void,
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
    emit();
    // Opening Messages is what publishes this account's public key -- the first thing about
    // messaging that leaves the device, and only because someone asked for the feature.
    void this.publishKey();
    const stopConversations = cloud.watchCollection(
      MESSAGING_PATHS.conversations(),
      { arrayContains: { field: 'members', value: uid }, limit: CONVERSATION_PAGE_SIZE },
      (entries) => {
        const parsed: Conversation[] = [];
        for (const entry of entries) {
          const conversation = parseConversation(entry.id, entry.data, uid);
          if (conversation !== null) parsed.push(conversation);
        }
        this.conversations = parsed;
        this.loaded = true;
        emit();
        this.nameUnknownPeers();
      },
      () => {
        onError?.(new MessagingError('unavailable'));
      },
    );
    const stopContacts = cloud.watchCollection(
      `users/${uid}/contacts`,
      { orderBy: 'updatedAt', direction: 'desc', limit: CONVERSATION_PAGE_SIZE },
      (entries) => {
        const labels = new Map<string, string>();
        for (const entry of entries) {
          const label = this.openLabel(entry.id, entry.data);
          if (label !== null) labels.set(entry.id, label);
        }
        this.labels = labels;
        this.contactsLoaded = true;
        emit();
        this.nameUnknownPeers();
      },
      () => undefined,
    );
    return () => {
      stopConversations();
      stopContacts();
    };
  }

  // -------------------------------------------------------------------------------------------
  // One conversation
  // -------------------------------------------------------------------------------------------

  /**
   * Subscribes to one conversation's messages, decrypting each as it arrives. A message that
   * does not open is delivered with a null body rather than dropped, so a tampered or
   * undecryptable row is visible instead of silently missing.
   */
  watchConversation(
    conversationId: string,
    onChange: (state: ConversationState) => void,
  ): () => void {
    const { cloud } = this.deps;
    const uid = this.uid;
    const peerUid = uid === null ? null : peerOf(conversationId, uid);
    const base: ConversationState = {
      id: conversationId,
      peerUid: peerUid ?? '',
      label: peerUid === null ? null : (this.labels.get(peerUid) ?? null),
      messages: [],
      canSend: false,
      sendBlocked: null,
      loaded: true,
      problem: null,
    };
    if (cloud === null) {
      onChange({ ...base, problem: 'unavailable', sendBlocked: 'unavailable' });
      return () => undefined;
    }
    if (uid === null) {
      onChange({ ...base, problem: 'unauthenticated', sendBlocked: 'unauthenticated' });
      return () => undefined;
    }
    if (peerUid === null) {
      onChange({ ...base, problem: 'unavailable', sendBlocked: 'unavailable' });
      return () => undefined;
    }

    let stored: readonly StoredMessage[] = [];
    let key: Bytes | null = null;
    let problem: MessagingErrorCode | null = null;
    let loaded = false;

    const emit = (): void => {
      const messages: DecryptedMessage[] = stored.map((message) => ({
        id: message.id,
        from: message.from,
        createdAt: message.createdAt,
        mine: message.from === uid,
        // A media message's `box` holds its caption envelope, which is empty today; the media
        // itself is fetched separately. Opening it is harmless either way and keeps one path.
        body:
          key === null
            ? null
            : openMessage(
                { box: message.box, nonce: message.nonce },
                key,
                { conversationId, from: message.from, createdAt: message.createdAt },
              ),
        kind: message.kind,
        object: message.object,
        thumbObject: message.thumbObject,
      }));
      const canSend = this.canMessage() && key !== null;
      onChange({
        id: conversationId,
        peerUid,
        label: this.labels.get(peerUid) ?? null,
        messages,
        canSend,
        // The concrete failure wins: it is the thing that actually happened. Only when there
        // was none is "no Pro" the answer, and only after that is it simply not ready yet.
        sendBlocked: canSend ? null : (problem ?? (this.canMessage() ? 'preparing' : 'pro-required')),
        loaded,
        problem,
      });
    };

    emit();
    void this.conversationKey(conversationId, peerUid)
      .then((derived) => {
        key = derived;
        emit();
      })
      .catch((error: unknown) => {
        problem = error instanceof MessagingError ? error.code : 'unavailable';
        emit();
      });

    const stop = cloud.watchCollection(
      MESSAGING_PATHS.messages(conversationId),
      { orderBy: 'createdAt', direction: 'asc', limit: MESSAGE_PAGE_SIZE },
      (entries) => {
        const parsed = [];
        for (const entry of entries) {
          const message = parseStoredMessage(entry.id, entry.data);
          if (message !== null) parsed.push(message);
        }
        stored = parsed;
        loaded = true;
        emit();
      },
      () => {
        problem = 'unavailable';
        emit();
      },
    );
    return stop;
  }

  private async conversationKey(conversationId: string, peerUid: string): Promise<Bytes> {
    const identity = this.requireIdentity();
    return identity.conversationKey(await this.peerKey(peerUid), conversationId);
  }

  // -------------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------------

  /**
   * Resolves an address and opens the conversation with that account, creating it the first
   * time. Returns the conversation id. The label is stored privately so the list can show who
   * this is; the shared document never learns the address.
   */
  async startConversation(email: string): Promise<string> {
    const cloud = this.requireCloud();
    const { directory } = this.deps;
    if (directory === null) throw new MessagingError('unavailable');
    const uid = this.requireUid();
    this.requireIdentity();
    if (!this.canMessage()) throw new MessagingError('pro-required');

    let peerUid: string | null;
    try {
      peerUid = await directory.findByEmail(email);
    } catch (error) {
      if (error instanceof DirectoryError && error.code === 'pro-required') {
        throw new MessagingError('pro-required');
      }
      if (error instanceof DirectoryError && error.code === 'unauthenticated') {
        throw new MessagingError('unauthenticated');
      }
      throw new MessagingError('unavailable');
    }
    if (peerUid === null) throw new MessagingError('no-such-user');
    if (peerUid === uid) throw new MessagingError('self');

    const conversationId = conversationIdFor(uid, peerUid);
    // Fails fast and writes nothing when the other side has never opened messaging.
    await this.peerKey(peerUid);
    // And make sure they can answer: no key of ours, no reply.
    await this.publishKey();

    const existing = await cloud.getDocument(MESSAGING_PATHS.conversation(conversationId));
    if (existing === null) {
      const members = membersOf(conversationId);
      if (members === null) throw new MessagingError('unavailable');
      await cloud.putDocument(
        MESSAGING_PATHS.conversation(conversationId),
        conversationRecord(members, uid, this.deps.clock.now()),
      );
    }
    await this.rememberContact(peerUid, email);
    return conversationId;
  }

  /** Files an address under a peer, encrypted with this account's own contacts key. */
  private async rememberContact(peerUid: string, email: string): Promise<void> {
    const cloud = this.requireCloud();
    await cloud.putDocument(this.contactPath(peerUid), this.sealLabel(peerUid, email.trim()));
  }

  /**
   * Puts a name on a conversation that somebody else started.
   *
   * Whoever starts a conversation typed the other person's address, so they have a contact for
   * them. The account on the receiving end has nothing but a uid: the shared document carries no
   * addresses, deliberately, and never will. So the address is asked of the directory, which
   * answers only about an account you are already in a conversation with, and then filed in this
   * account's own encrypted contacts exactly as the other direction does. The contacts listener
   * delivers it from there like any other label, which is why nothing here has to emit.
   *
   * Best effort, once per peer per session. It needs an unlocked vault because the contacts key
   * is what seals the result; locked, the row keeps showing the id, which is honest.
   */
  private nameUnknownPeers(): void {
    const { directory } = this.deps;
    if (directory === null || !this.unlocked || !this.contactsLoaded) return;
    for (const conversation of this.conversations) {
      const peerUid = conversation.peerUid;
      if (this.labels.has(peerUid) || this.namedPeers.has(peerUid)) continue;
      this.namedPeers.add(peerUid);
      void (async () => {
        try {
          const email = await directory.emailForUid(peerUid);
          if (email !== null && email !== '') await this.rememberContact(peerUid, email);
        } catch {
          // A name is a nicety, not a requirement. The row falls back to the account id.
        }
      })();
    }
  }

  /**
   * Encrypts and sends one message, then bumps the conversation so the other side's list sorts
   * and counts correctly. The counter is a server-side increment, so two people sending at once
   * cannot lose each other's count.
   */
  async send(conversationId: string, text: string): Promise<DecryptedMessage> {
    const cloud = this.requireCloud();
    const uid = this.requireUid();
    this.requireIdentity();
    if (!this.canMessage()) throw new MessagingError('pro-required');
    const peerUid = peerOf(conversationId, uid);
    if (peerUid === null) throw new MessagingError('unavailable');
    const checked = checkMessage(text);
    if (!checked.ok) throw new MessagingError('rejected', checked.problem);

    const key = await this.conversationKey(conversationId, peerUid);
    const createdAt = this.deps.clock.now();
    const id = `m_${this.deps.random.hexId(12)}`;
    const sealed = sealMessage(
      checked.body,
      key,
      { conversationId, from: uid, createdAt },
      this.deps.random,
    );
    await cloud.putDocument(
      MESSAGING_PATHS.message(conversationId, id),
      messageRecord(uid, sealed, createdAt),
    );
    try {
      await cloud.putDocument(
        MESSAGING_PATHS.conversation(conversationId),
        {
          lastMessageAt: createdAt,
          lastMessageFrom: uid,
          unread: { [peerUid]: increment(1) },
        },
        { merge: true },
      );
    } catch {
      // The message is already stored and will be delivered. A stale sort key or a badge that is
      // one short is not worth failing a send that succeeded.
    }
    return {
      id,
      from: uid,
      createdAt,
      mine: true,
      body: checked.body,
      kind: null,
      object: null,
      thumbObject: null,
    };
  }

  /**
   * Encrypts one photo or video plus its preview, uploads both, then writes the message that
   * points at them.
   *
   * The objects go up BEFORE the document, and that order is not an accident: a document whose
   * object is missing is a bubble that can never be repaired, while an object whose document was
   * never written is invisible to every reader and is removed by the 30-day lifecycle rule. Every
   * partial failure therefore leaves litter that expires on its own rather than a broken message.
   *
   * The thumbnail is uploaded, not embedded. Putting it in the message document would place it
   * beyond the reach of any bucket lifecycle rule and leave a recognisable preview of an expired
   * photo in Firestore for ever.
   *
   * Pro is required exactly as it is for text, and nothing here reads a Cloud term.
   */
  async sendMedia(conversationId: string, source: MediaSource): Promise<DecryptedMessage> {
    const cloud = this.requireCloud();
    const media = this.requireMedia();
    const uid = this.requireUid();
    this.requireIdentity();
    if (!this.canMessage()) throw new MessagingError('pro-required');
    const peerUid = peerOf(conversationId, uid);
    if (peerUid === null) throw new MessagingError('unavailable');

    const plain = await this.readSource(media, source);
    if (plain.length === 0) throw new MessagingError('rejected', 'empty');
    if (plain.length > capFor(source.kind)) throw new MessagingError('rejected', 'too-long');

    const key = await this.conversationKey(conversationId, peerUid);
    const createdAt = this.deps.clock.now();
    const id = `m_${this.deps.random.hexId(12)}`;
    const objectPath = MESSAGING_PATHS.mediaObject(conversationId, source.kind, id);
    const thumbPath = MESSAGING_PATHS.thumbObject(conversationId, id);
    const binding: MediaBinding = { conversationId, from: uid, createdAt, objectPath };

    // The preview is regenerated at the chat size even when the source already has one: the
    // vault's own thumbnails are 512px and over the 32 KB cap the Storage rules enforce.
    const thumbBytes = await this.thumbnailFor(media, source, plain);
    let thumbObject: string | null = null;
    if (thumbBytes !== null) {
      const sealedThumb = sealThumb(thumbBytes, key, binding, this.deps.random);
      await cloud.putBlob(thumbPath, packSealed(sealedThumb));
      thumbObject = thumbPath;
    }

    const sealed = sealMedia(plain, key, binding, this.deps.random);
    const packed = packSealed(sealed);
    await cloud.putBlob(objectPath, packed);

    // The envelope keeps the shape text uses, so one document schema serves both. Its plaintext
    // is empty today -- captions are not a feature -- but the nonce it carries is the media's.
    const envelope = sealMessage('', key, { conversationId, from: uid, createdAt }, this.deps.random);
    await cloud.putDocument(
      MESSAGING_PATHS.message(conversationId, id),
      mediaRecord(
        uid,
        source.kind,
        { box: envelope.box, nonce: envelope.nonce },
        { object: objectPath, bytes: packed.length, thumbObject },
        createdAt,
      ),
    );
    try {
      await cloud.putDocument(
        MESSAGING_PATHS.conversation(conversationId),
        { lastMessageAt: createdAt, lastMessageFrom: uid, unread: { [peerUid]: increment(1) } },
        { merge: true },
      );
    } catch {
      // As with text: the message is stored and will be delivered. A stale sort key is not worth
      // failing a send that succeeded.
    }
    return {
      id,
      from: uid,
      createdAt,
      mine: true,
      body: '',
      kind: source.kind,
      object: objectPath,
      thumbObject,
    };
  }

  /**
   * The full media, decrypted to a scratch file the caller must release.
   *
   * Throws `expired` when the object is gone, which after 30 days is the ordinary fate of every
   * media message -- the screen needs to tell that apart from a failure it could retry.
   */
  async fetchMedia(conversationId: string, message: DecryptedMessage): Promise<string> {
    const media = this.requireMedia();
    const plain = await this.fetchMediaBytes(conversationId, message);
    const uri = await media.scratch.allocate(message.kind === 'video' ? 'mp4' : 'jpg');
    await media.fs.writeBytes(uri, plain);
    return uri;
  }

  /**
   * The decrypted media, in memory, never touching disk.
   *
   * This is the form a photo should always be handled in. The vault's own viewer shows photos
   * from a `data:` URI for exactly this reason -- plaintext images are never written to storage,
   * even briefly -- and a chat photo is no less sensitive than a vault one. Video is the
   * exception, and only because a player needs a file it can seek; that is what `fetchMedia` and
   * `PlaybackScratch` are for, and the scratch file is purged when the app backgrounds.
   *
   * Throws `expired` when the object is gone, which after 30 days is the ordinary fate of every
   * media message rather than a fault.
   */
  async fetchMediaBytes(conversationId: string, message: DecryptedMessage): Promise<Bytes> {
    const cloud = this.requireCloud();
    const uid = this.requireUid();
    if (message.object === null || message.kind === null) {
      throw new MessagingError('unavailable');
    }
    const peerUid = peerOf(conversationId, uid);
    if (peerUid === null) throw new MessagingError('unavailable');
    const key = await this.conversationKey(conversationId, peerUid);
    const sealed = unpackSealed(await this.fetchBlob(cloud, message.object));
    if (sealed === null) throw new MessagingError('unavailable');
    const plain = openMedia(sealed, key, {
      conversationId,
      from: message.from,
      createdAt: message.createdAt,
      objectPath: message.object,
    });
    if (plain === null) throw new MessagingError('unavailable');
    return plain;
  }

  /**
   * The preview bytes, or null once the object has expired.
   *
   * Null rather than a throw because an expired preview is the ordinary end state of every
   * message older than 30 days: a thread scrolling through a year of history would otherwise be
   * throwing constantly for something that is not an error.
   */
  async fetchThumb(conversationId: string, message: DecryptedMessage): Promise<Bytes | null> {
    const cloud = this.deps.cloud;
    const uid = this.uid;
    if (cloud === null || uid === null) return null;
    if (message.thumbObject === null || message.object === null) return null;
    const peerUid = peerOf(conversationId, uid);
    if (peerUid === null) return null;
    let sealed: ReturnType<typeof unpackSealed>;
    try {
      sealed = unpackSealed(await cloud.getBlob(message.thumbObject));
    } catch {
      // Gone, which after 30 days is what it should be.
      return null;
    }
    if (sealed === null) return null;
    try {
      const key = await this.conversationKey(conversationId, peerUid);
      return openThumb(sealed, key, {
        conversationId,
        from: message.from,
        createdAt: message.createdAt,
        objectPath: message.object,
      });
    } catch {
      return null;
    }
  }

  /**
   * Keeps a received photo or video, as an ordinary vault item.
   *
   * The 30-day expiry makes this necessary rather than optional: without a way to keep something,
   * the expiry destroys it. What it must NOT do is bypass the vault's own limits -- a received
   * item counts against the 50-item free cap and the per-item size cap exactly as one from the
   * camera does, because those limits are about the vault, not about where a file came from.
   *
   * The repository is passed in rather than held: it belongs to the unlocked session, and a
   * service that kept a reference to it would outlive the lock that invalidated it.
   */
  async saveToVault(
    conversationId: string,
    message: DecryptedMessage,
    repository: VaultSink,
  ): Promise<void> {
    const media = this.requireMedia();
    if (message.kind !== 'photo' && message.kind !== 'video') {
      throw new MessagingError('unavailable');
    }

    // A photo never touches disk on the way in, the same discipline the vault's own viewer
    // keeps. Only video needs a file, because the vault's video path streams from one rather
    // than holding 100 MB in memory.
    if (message.kind === 'photo') {
      // Throws `expired` when the object has been swept, which the screen must not confuse with
      // a vault refusal: one is permanent, the other is a limit with a way past it.
      const bytes = await this.fetchMediaBytes(conversationId, message);
      const gate = this.deps.entitlements.gate(repository.photos.length, bytes.length);
      if (!gate.allowed) throw new MessagingError('vault-refused', gate.reason);
      await repository.addPhoto({ bytes }, { source: 'import' });
      return;
    }

    const uri = await this.fetchMedia(conversationId, message);
    try {
      const gate = this.deps.entitlements.gate(repository.photos.length, await media.fs.size(uri));
      if (!gate.allowed) throw new MessagingError('vault-refused', gate.reason);
      await repository.addVideo({ uri, durationMs: 0 }, { source: 'import' });
    } finally {
      // In a `finally` deliberately: a refused save must not leave a decrypted copy of somebody
      // else's video in the cache directory, and the refusal branch is the easy one to forget.
      await media.scratch.release(uri);
    }
  }

  private requireMedia(): MediaDeps {
    const media = this.deps.media;
    if (media === undefined) throw new MessagingError('unavailable');
    return media;
  }

  private async fetchBlob(cloud: CloudBackend, path: string): Promise<Bytes> {
    try {
      return await cloud.getBlob(path);
    } catch {
      // Any failure to read the object reads as expiry: after 30 days that is what it is, and a
      // transient network error looks identical from here. The screen offers a retry either way.
      throw new MessagingError('expired');
    }
  }

  private async readSource(media: MediaDeps, source: MediaSource): Promise<Bytes> {
    if (source.bytes !== undefined) return source.bytes;
    return media.fs.readBytes(source.uri);
  }

  private async thumbnailFor(
    media: MediaDeps,
    source: MediaSource,
    plain: Bytes,
  ): Promise<Bytes | null> {
    try {
      if (source.kind === 'video') {
        const poster = await media.videoThumbnails.generate(source.uri, THUMB_MAX_EDGE);
        return poster.jpegBytes;
      }
      const thumb = await media.thumbnails.generate({ bytes: plain }, THUMB_MAX_EDGE);
      return thumb.jpegBytes;
    } catch {
      // A message with no preview is still a message. Refusing the send because a thumbnail
      // could not be made would lose the user's photo over a cosmetic failure.
      return null;
    }
  }

  /**
   * Clears this account's unread count for one conversation. Never gated: a lapsed or non-Pro
   * account may always put its own badge down.
   */
  async markRead(conversationId: string): Promise<void> {
    const { cloud, clock } = this.deps;
    const uid = this.uid;
    if (cloud === null || uid === null || peerOf(conversationId, uid) === null) return;
    try {
      await cloud.putDocument(
        MESSAGING_PATHS.conversation(conversationId),
        { unread: { [uid]: 0 }, readAt: { [uid]: clock.now() } },
        { merge: true },
      );
    } catch {
      // Leaving the badge up is the correct failure here.
    }
  }
}
