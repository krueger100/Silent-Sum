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
import { CloudError, increment, type CloudBackend } from '@/firebase/types';
import { DirectoryError, type Directory } from '@/messaging/directory';
import { ConversationAdminError, type ConversationAdmin } from '@/messaging/conversationAdmin';
import type { TransferState } from '@/messaging/mediaProgress';
import type { HiddenMessages } from '@/messaging/hiddenMessages';
import { deriveMessagingIdentity, type MessagingIdentity } from '@/messaging/identity';
import {
  CONVERSATION_PAGE_SIZE,
  MAX_PUBLISHED_KEY_HISTORY,
  MESSAGE_PAGE_SIZE,
  MESSAGING_PATHS,
  byRecency,
  checkMessage,
  conversationIdFor,
  conversationRecord,
  deletedMessageRecord,
  mediaRecord,
  membersOf,
  messageRecord,
  parseConversation,
  identityStanding,
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
  openMedia,
  openThumb,
  plaintextBudget,
  sealMedia,
  sealThumb,
  packSealed,
  unpackSealed,
  THUMB_MAX_EDGE,
  THUMB_PLAINTEXT_BUDGET,
  type MediaBinding,
  type MediaKind,
} from '@/messaging/media';
import { encodeUnderCap, fitPhotoForSending, THUMB_SEND_EDGES } from '@/messaging/mediaFit';
import type { FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import type { PlaybackScratch } from '@/vault/playbackScratch';
import {
  storedBytesOf,
  type VaultRepository,
  type ThumbnailGenerator,
  type VideoThumbnailGenerator,
} from '@/vault/types';
import { keyFingerprint, traceRecovery } from '@/messaging/recoveryTrace';
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

/**
 * What `useRecoveredMasterKey` did.
 *
 * `mismatch` is the interesting one: the passphrase unwrapped the backup correctly, but the
 * identity it derives is not the one this account published. That means a THIRD vault set this
 * account up, and accepting the key would leave a device that silently reads nothing.
 *
 * `unavailable` and `unreachable` were one value, and that was a reporting bug rather than a
 * simplification. `unavailable` is a fact about the ACCOUNT -- it has published no messaging key,
 * so there is nothing for any passphrase to unlock and opening Messages is what fixes it.
 * `unreachable` is a fact about the REQUEST -- the published key could not be read, because the
 * device is offline or because App Check refused this build -- and it is retryable. Told the wrong
 * one, a user with a working connection goes looking at their wifi, and a user who is genuinely
 * offline is told their account is broken.
 */
export type RecoveredIdentityResult = 'ok' | 'historical' | 'mismatch' | 'unavailable' | 'unreachable';

/**
 * Why a message has no preview, when it has none.
 *
 * The distinction is the whole value of the type. `expired` says the bytes are gone and the
 * 30-day rule took them; `sealed` says they are sitting right there and this device has no key
 * that opens them. Collapsing the two -- which a bare `null` did -- told people a photo sent a
 * minute ago had been destroyed.
 */
export type ThumbMiss = 'expired' | 'sealed';

/**
 * What came of adopting this vault as the account's messaging identity.
 *
 * `not-needed` is a success, not a failure: the account's key already belongs to this vault, so
 * there was nothing to retire. It is kept apart from `ok` because the two deserve different
 * sentences -- one has to say what was given up, and the other must not.
 */
export type FreshIdentityResult =
  | 'ok'
  | 'not-needed'
  | 'history-full'
  | 'raced'
  | 'unavailable'
  | 'unreachable';

export type MessagingErrorCode =
  /** Nobody is signed in to a backup account. */
  | 'unauthenticated'
  /**
   * Signed in, but App Check could not vouch for this build, so the lookup was refused. Distinct
   * from `unauthenticated` because the remedy is different and the user is already past sign-in.
   */
  | 'attestation'
  /** The vault is locked, so there is no key to encrypt or decrypt with. */
  | 'locked'
  /** Not Pro. Starting and sending both need it; reading never does. */
  | 'pro-required'
  /** The address resolved to nobody. */
  | 'no-such-user'
  /** You cannot start a conversation with yourself. */
  | 'self'
  /** The request never reached the server: no connection, DNS, TLS, or a timeout. */
  | 'offline'
  /** Too many directory lookups for now. */
  | 'rate-limited'
  /** What was typed is not an address. */
  | 'invalid-email'
  /** The other account has never opened messaging, so it has published no key. */
  | 'peer-has-no-key'
  /**
   * This account already published a messaging key, and this vault did not derive it.
   *
   * The mirror of `peer-has-no-key`: there the other side has no usable identity, here we do
   * not. It happens when a backup account is signed in on a vault other than the one that set
   * messaging up -- a second device, or a vault remade after a reinstall. The published key
   * belongs to the original vault's master key, which this one does not have, so nothing sent
   * to this account can be opened here and nothing sent from it could be opened there.
   *
   * The remedy is to recover the vault, not to overwrite the key: see `publishKey`.
   */
  | 'foreign-vault'
  /** The text was refused before anything was written. */
  | 'rejected'
  /** Only a message's own sender may withdraw it for everyone. */
  | 'not-mine'
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
  /**
   * This vault holds a key this account published EARLIER. Old threads open; sending does not,
   * because the device holding the current key derives from that one and would never see it.
   */
  | 'historical-identity'
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
    case 'attestation':
      return (
        'This device could not prove to the server that the app is genuine. Update Google Play ' +
        'Store, or install SilentSum from the store, and try again.'
      );
    case 'locked':
      return 'Unlock the vault to read and send messages.';
    case 'pro-required':
      return 'Messaging is a Pro feature.';
    case 'offline':
      return 'Could not reach the server. Check your connection and try again.';
    case 'rate-limited':
      return 'Too many lookups. Try again in an hour.';
    case 'invalid-email':
      return 'That is not an e-mail address.';
    case 'no-such-user':
      return 'Nobody here uses that address.';
    case 'self':
      return 'That is your own address.';
    case 'peer-has-no-key':
      return 'That person has not set up messaging yet. Ask them to open Messages once.';
    case 'historical-identity':
      return (
        'This vault holds an older messaging key for this account, so older messages open but ' +
        'sending is off. Recover the current key to send from here.'
      );
    case 'foreign-vault':
      // Deliberately names the recovery passphrase. The neighbouring remedy -- "Restore from
      // backup" -- only downloads photos into a vault that is already open, so a user sent
      // there would do it, see nothing change, and conclude messaging is broken.
      return (
        'This vault is not the one that set up messaging for this account. Recover your vault ' +
        'with your recovery passphrase to read and send messages here.'
      );
    case 'rejected':
      return 'That message was not sent.';
    case 'not-mine':
      return 'You can only delete your own messages for everyone.';
    case 'vault-refused':
      return 'The vault would not take this item.';
    case 'expired':
      return 'This has expired. Media is kept for 30 days.';
    case 'unavailable':
      // NOT "not available in this build". That sentence is true only when the build has no
      // Firebase at all, and the screen says it for itself in that case. Reaching this from a
      // server refusal -- a 404 from a function that was never deployed, a 500, an App Check
      // rejection landing anywhere unexpected -- made a configuration fault look like a
      // property of the binary, and sent the reader looking in entirely the wrong place.
      return 'The server did not answer as expected. Try again shortly.';
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
  /**
   * This account's published key was derived by a different vault, so messaging cannot work
   * here until that vault is recovered. False until the key has been read, so a screen reading
   * it never accuses a vault on the strength of a lookup that has not happened yet.
   */
  readonly foreignVault: boolean;
  /**
   * This vault derives a key the account published BEFORE its current one. Reading works; sending
   * is withheld. Never true at the same time as {@link foreignVault}: the two are different
   * answers to one question.
   */
  readonly historicalIdentity: boolean;
}

export const EMPTY_MESSAGING_STATE: MessagingState = {
  conversations: [],
  totalUnread: 0,
  signedIn: false,
  unlocked: false,
  canMessage: false,
  loaded: false,
  foreignVault: false,
  historicalIdentity: false,
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
  /** Ending a conversation for both sides. Null when this build cannot reach the functions. */
  readonly conversationAdmin?: ConversationAdmin | null;
  readonly entitlements: EntitlementsController;
  readonly clock: Clock;
  readonly random: SecureRandom;
  /** The unlocked session's messaging identity, or null while the vault is locked. */
  readonly identity: () => MessagingIdentity | null;
  /**
   * Messages hidden on this device only. Absent in a build or a test without one, in which case
   * "delete for me" is simply unavailable and nothing else changes.
   */
  readonly hidden?: HiddenMessages;
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

/**
 * Opens with the first key that authenticates, or null when none does.
 *
 * The wire format carries no key identifier and has nowhere to put one: the message document
 * is pinned by `hasOnly` in the rules, and the AAD binds the conversation, sender and time
 * rather than the key. Trying each candidate is therefore the only thing this protocol
 * supports -- and it is sound rather than a guess, because AEAD authenticates: a wrong key
 * fails cleanly and can never yield wrong plaintext. Candidates are newest first, so a thread
 * that has never seen a rotation costs exactly one attempt per message.
 */
function openWithAny<T>(keys: readonly Bytes[], open: (key: Bytes) => T | null): T | null {
  for (const key of keys) {
    const opened = open(key);
    if (opened !== null) return opened;
  }
  return null;
}

export class MessagingService {
  private conversations: readonly Conversation[] = [];

  private labels = new Map<string, string>();

  private loaded = false;

  /**
   * Peer uid -> every key that peer has published, current first. Cleared whenever the
   * identity goes away.
   */
  private readonly peerKeys = new Map<string, readonly Bytes[]>();

  /** Peers whose address has already been asked for. One attempt each, per unlocked session. */
  private readonly namedPeers = new Set<string>();

  /**
   * Whether the contacts listener has delivered once. Until it has, an absent label means "not
   * loaded yet" rather than "unknown", and asking the directory about a peer this account already
   * named would spend the hourly budget on an answer it is holding.
   */
  private contactsLoaded = false;

  /**
   * Which account everything above belongs to, so a second account on this device is never
   * shown the conversations or the contact names of the first.
   *
   * Locking the vault is NOT this. `forgetKeys` handles locking and deliberately keeps the
   * conversation list, which stays readable while locked. This is a different account
   * entirely, which must see none of the previous one.
   */
  private cacheUid: string | null = null;

  /**
   * Whether the key published for this account was derived by some other vault.
   *
   * Set by `publishKey`, which is the only thing that reads the published key for this account,
   * and cleared when the account changes. Starts false and stays false until a read actually
   * disagrees, so a failed lookup never presents itself as a mismatch.
   */
  private foreignVault = false;

  /** @see MessagingState.historicalIdentity */
  private historicalIdentity = false;

  /**
   * The identity recovered from THIS ACCOUNT's backup passphrase, when the vault's own is not
   * the one the account published.
   *
   * Held in memory only and dropped the moment the vault locks, because it is derived from
   * another account's master key -- the same key that unwraps that account's backup. Nothing
   * persists it, so the user supplies the passphrase again after each unlock. That is the
   * deliberate trade: this device never stores a key that opens an account it does not own.
   */
  private recovered: MessagingIdentity | null = null;

  /**
   * The contacts collection as it last arrived, still sealed.
   *
   * Ciphertext, so holding it costs nothing in secrecy -- and it is what lets a recovered
   * identity re-open the address book without waiting for the collection to change. Dropped with
   * everything else when the ACCOUNT changes; deliberately kept when only the identity does.
   */
  private contactEntries: readonly {
    readonly id: string;
    readonly data: Record<string, unknown>;
  }[] = [];

  /** Open threads that want telling when this device hides a message. */
  private readonly hiddenChanged = new Set<() => void>();

  /**
   * Open threads and lists that want telling when the account's messaging identity changes.
   *
   * Recovering an identity writes NOTHING to the server -- that is the whole point of it -- so no
   * snapshot arrives to re-emit anything, and every open screen would go on showing what the
   * previous key could read. One screen used to work around this with a counter of its own, which
   * meant recovery only ever refreshed whichever screen had thought to have one.
   */
  private readonly identityChanged = new Set<() => void>();

  constructor(private readonly deps: MessagingDeps) {}

  /** False in a build with no cloud backend: the screen says so rather than failing. */
  get available(): boolean {
    return this.deps.cloud !== null && this.deps.directory !== null;
  }

  private get uid(): string | null {
    return this.deps.cloud?.currentUser?.uid ?? null;
  }

  private get unlocked(): boolean {
    const identity = this.currentIdentity();
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

  /**
   * The identity to speak as: the account's own where it has been recovered, the vault's
   * otherwise.
   *
   * Every caller goes through here rather than reading `deps.identity()`, so there is exactly
   * one place that decides, and a recovered identity cannot be half-applied -- reading old
   * messages with one key while sealing new ones with another is the state that would quietly
   * produce a thread only this device can read.
   */
  private currentIdentity(): MessagingIdentity | null {
    const recovered = this.recovered;
    if (recovered !== null && !recovered.isDisposed) return recovered;
    return this.deps.identity();
  }

  private requireIdentity(): MessagingIdentity {
    const identity = this.currentIdentity();
    if (identity === null || identity.isDisposed) throw new MessagingError('locked');
    return identity;
  }

  /**
   * Opens this account's messaging with the identity the ACCOUNT published, recovered from that
   * account's own backup passphrase.
   *
   * The opposite of a rotation, and deliberately so. `publishKey` refuses to replace a key this
   * vault did not derive, because replacing it strands whoever holds the real one -- which it
   * already did, to ten production accounts, silently. This fixes the same situation from the
   * other end: instead of making the account's key match this device, it gives this device the
   * account's key. Nothing is written. `messagingKeys` is untouched, `previous` is untouched,
   * and the peer -- who derives the conversation key from the published key and their own
   * secret -- sees no change at all, because from their side there is none.
   *
   * The derived key is CHECKED against the published one before it is accepted. A passphrase
   * that unwraps the backup but produces a different identity means this account's messaging was
   * set up by a third vault; installing it would leave a device that silently reads nothing, so
   * that is reported instead.
   *
   * The master key is only read. It still belongs to the caller, which must zero it.
   */
  async useRecoveredMasterKey(masterKey: Bytes): Promise<RecoveredIdentityResult> {
    const cloud = this.deps.cloud;
    const uid = this.syncAccount();
    if (cloud === null || uid === null) return 'unavailable';

    let published;
    try {
      published = parsePublishedKey(uid, await cloud.getDocument(MESSAGING_PATHS.publicKey(uid)));
    } catch {
      // Not narrowed to a cloud error: whatever shape it has, the stage is what matters and
      // the message could carry anything. The one thing that IS known is that the server never
      // answered, which is a different sentence from "this account has no key" below.
      traceRecovery('published-key-read', 'failed');
      return 'unreachable';
    }
    // No key published at all is not something a passphrase fixes: nobody has set this account's
    // messaging up yet, and opening Messages normally will.
    if (published === null) {
      traceRecovery('published-key-read', 'absent');
      return 'unavailable';
    }
    traceRecovery('published-key-read', keyFingerprint(published.publicKey));

    const identity = deriveMessagingIdentity(masterKey);
    const derived = base64Encode(identity.publicKey);
    traceRecovery('identity-derived', keyFingerprint(derived));
    const standing = identityStanding(published, derived);
    if (standing === 'foreign') {
      identity.dispose();
      traceRecovery('key-mismatched');
      return 'mismatch';
    }
    traceRecovery(standing === 'current' ? 'key-matched' : 'key-historical');

    // Caches first: contact labels were sealed under the OTHER identity's contacts key and will
    // not open under this one. Clearing also drops whatever `recovered` held, so the assignment
    // has to come after it rather than before.
    //
    // The SEALED entries are carried across it, though. They belong to this account -- the uid
    // has not moved -- and the contacts listener only fires again when the collection changes, so
    // dropping them would leave the address book blank next to threads that had just started
    // opening, with nothing to refill it until the user happened to add a contact.
    const sealedContacts = this.contactEntries;
    this.forgetKeys();
    this.recovered = identity;
    this.foreignVault = false;
    // An older key opens what was sealed under it and nothing newer. Recorded rather than
    // resolved, exactly as a foreign vault is, so the composer and the banner can be honest.
    this.historicalIdentity = standing === 'historical';
    this.contactEntries = sealedContacts;
    this.relabel();
    // Last, so every listener sees the finished state rather than a half-applied one.
    for (const listener of this.identityChanged) listener();
    traceRecovery('applied');
    return standing === 'current' ? 'ok' : 'historical';
  }

  /**
   * Adopts THIS vault as the account's messaging identity, retiring the key it cannot reach.
   *
   * The remedy of last resort, and the exact opposite of {@link useRecoveredMasterKey}: that one
   * gives this device the account's key, this one gives the account this device's key. It exists
   * because the first has a dead end. When the vault that set an account up is gone -- no copy
   * on this device, no escrow written before it went, nothing in `previous` -- no passphrase
   * anywhere produces the published key, and the account was then locked out of messaging for
   * good: `canSend` is false while `foreignVault` holds, and only recovering that very key could
   * clear it.
   *
   * WHAT IT COSTS, and why it is never automatic. Every message already sent to this account was
   * sealed under the old key, and the private half is gone, so they stay unreadable. Rotating
   * does not lose them -- they were lost when the vault went. It stops the loss being total.
   *
   * `publishKey` is NOT relaxed by this and must not be. Its refusal is automatic and silent,
   * and an automatic rotation is precisely what quietly broke ten production accounts, each
   * device taking the identity back from the last. This is the same write made deliberately:
   * reached only after recovery has been tried and failed, and only on the user's own second,
   * informed decision.
   *
   * The retired key is APPENDED, never dropped -- which the rules enforce, and which is also
   * what makes this survivable from the other side. A device still holding the old vault then
   * reads as `historical` rather than `foreign`: it keeps every conversation it can open and
   * merely stops being able to send, instead of being told the account belongs to a stranger.
   */
  async startFreshIdentity(): Promise<FreshIdentityResult> {
    const cloud = this.deps.cloud;
    const uid = this.syncAccount();
    // The one place that deliberately does NOT ask `currentIdentity()`. A recovered identity is
    // the account's own key held in memory, so publishing it back would re-publish the very key
    // this replaces -- and its presence means there is nothing wrong to repair. Refusing here
    // leaves `currentIdentity()` the single place deciding which key to SPEAK as, while this
    // asks a different question: which key does this VAULT own.
    const recovered = this.recovered;
    if (recovered !== null && !recovered.isDisposed) return 'not-needed';
    const identity = this.deps.identity();
    if (cloud === null || uid === null || identity === null || identity.isDisposed) {
      return 'unavailable';
    }
    const encoded = base64Encode(identity.publicKey);

    let published;
    try {
      published = parsePublishedKey(uid, await cloud.getDocument(MESSAGING_PATHS.publicKey(uid)));
    } catch {
      // Re-read rather than rotate on a guess. Writing over a key that could not be read is the
      // one mistake this whole area exists to prevent, and a failed read proves nothing about
      // what is stored.
      return 'unreachable';
    }
    // Checked against the server now rather than trusted from `foreignVault`, which was computed
    // before the user read a screen and made a decision. In between, another device may have
    // recovered the account properly -- and retiring a key this vault turns out to own would
    // destroy the very thing the user came here to save.
    if (published === null) return 'not-needed';
    if (identityStanding(published, encoded) !== 'foreign') return 'not-needed';
    // The cap the rules impose on `previous`. Hitting it refuses the rotation rather than
    // dropping a key, which is the safe direction to fail; saying so beats a bare refusal.
    if (published.previous.length >= MAX_PUBLISHED_KEY_HISTORY) return 'history-full';

    try {
      await cloud.putDocument(
        MESSAGING_PATHS.publicKey(uid),
        publishedKeyRecord(
          uid,
          encoded,
          [...published.previous, published.publicKey],
          this.deps.clock.now(),
        ),
      );
    } catch {
      // Covers the rules refusing a stale append -- two devices rotating at once, where the
      // loser computed its history from a read that is now one key behind. Nothing was written,
      // so trying again re-reads and either succeeds or reports `not-needed`.
      return 'raced';
    }

    // Same order as `useRecoveredMasterKey`, for the same reasons. The conversation keys cached
    // here were derived from the identity just retired. The sealed contact labels were sealed
    // under its contacts key and will not open under this one, but they are carried across
    // rather than dropped: the contacts listener only fires again when the collection CHANGES,
    // so dropping them would empty the address book with nothing to refill it.
    const sealedContacts = this.contactEntries;
    this.forgetKeys();
    this.foreignVault = false;
    this.historicalIdentity = false;
    this.contactEntries = sealedContacts;
    this.relabel();
    // Last, so every listener sees the finished state rather than a half-applied one.
    for (const listener of this.identityChanged) listener();
    return 'ok';
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
   * Publishes this account's public key, so others can start a conversation with it.
   *
   * An account publishes ONCE. If a key is already there and this vault did not derive it, that
   * is not a key to update -- it is somebody else's identity, and the vault holding it is the
   * one that can read this account's conversations. Replacing it would hand the account's
   * identity to whichever vault opened Messages most recently, and the previous one would take
   * it back on its next unlock, each rotation stranding the other for everything sent in
   * between. That is not a hypothetical: an audit of production found ten accounts whose keys
   * had been rewritten this way, by exactly this code path, with no user ever being told.
   *
   * So a mismatch is recorded rather than resolved, and `foreignVault` is how the rest of the
   * service refuses to pretend. The remedy belongs to the user and is vault recovery, which
   * brings the original master key -- and with it the original key -- back to this device.
   *
   * Writing is still safe to call on every unlock: it writes only on an account that has never
   * published, and is a no-op on the ordinary case where the stored key is this vault's own.
   */
  async publishKey(): Promise<void> {
    const cloud = this.deps.cloud;
    // Scoped like every other account-aware entry point, and for the same reason: this both
    // reads and sets `foreignVault`, which belongs to one account. Without it the first `watch`
    // or `watchConversation` afterwards would see a new account, clear the caches, and take the
    // answer with them -- whichever of them happened to run first.
    const uid = this.syncAccount();
    const identity = this.currentIdentity();
    if (cloud === null || uid === null || identity === null || identity.isDisposed) return;
    const encoded = base64Encode(identity.publicKey);
    const path = MESSAGING_PATHS.publicKey(uid);
    // Twice, because a create can lose to another device creating at the same instant. Reading
    // again settles it: the loser sees the winner's key and reports a mismatch rather than
    // overwriting, which is the whole point.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const existing = parsePublishedKey(uid, await cloud.getDocument(path));
        if (existing !== null) {
          // The whole record, not just its head. A key in `previous` was this account's own
          // published key once, so a vault deriving it is this account's vault one rotation
          // behind -- which used to be reported as a different vault entirely. Nothing is
          // written either way; `previous` is read here exactly as `peerKeyCandidates` reads it.
          const standing = identityStanding(existing, encoded);
          this.foreignVault = standing === 'foreign';
          this.historicalIdentity = standing === 'historical';
          return;
        }
        await cloud.putDocument(path, publishedKeyRecord(uid, encoded, [], this.deps.clock.now()));
        this.foreignVault = false;
        this.historicalIdentity = false;
        return;
      } catch {
        // Publishing is best effort; the next unlock tries again. Nothing else depends on it
        // having happened by any particular moment -- and `foreignVault` is deliberately left
        // alone here, because a read that failed proves nothing about whose key is stored.
      }
    }
  }

  /**
   * Every key this peer has published, current first, then retired ones newest-last.
   *
   * Encryption always takes the first. Decryption tries them in turn, because a message
   * sent before the peer rotated was sealed under the key that was current then.
   */
  private async peerKeyCandidates(peerUid: string, refresh = false): Promise<readonly Bytes[]> {
    const cached = this.peerKeys.get(peerUid);
    if (cached !== undefined && !refresh) return cached;
    const cloud = this.requireCloud();
    let doc: Record<string, unknown> | null;
    try {
      doc = await cloud.getDocument(MESSAGING_PATHS.publicKey(peerUid));
    } catch {
      // On a REFRESH a failed read is not a reason to refuse the message. The cached key is what
      // this would have sealed with had it never asked, so falling back is never worse than not
      // refreshing -- while refusing would take messaging away on every passing blip. With
      // nothing cached there is nothing to fall back to.
      if (cached !== undefined) return cached;
      throw new MessagingError('unavailable');
    }
    const published = parsePublishedKey(peerUid, doc);
    if (published === null) throw new MessagingError('peer-has-no-key');
    const decoded: Bytes[] = [];
    const seen = new Set<string>();
    // Newest first, so the ordinary case opens on the first attempt. A rotation back to an
    // earlier key would otherwise list it twice and decrypt it twice for nothing.
    for (const encoded of [published.publicKey, ...[...published.previous].reverse()]) {
      if (seen.has(encoded)) continue;
      seen.add(encoded);
      try {
        decoded.push(base64Decode(encoded));
      } catch {
        // One unreadable historical entry must not cost the others. The current key failing
        // to decode is caught by the emptiness check below.
      }
    }
    if (decoded.length === 0) throw new MessagingError('peer-has-no-key');
    this.peerKeys.set(peerUid, decoded);
    return decoded;
  }

  /** The key to encrypt to: whatever this peer publishes now. */
  private async peerKey(peerUid: string): Promise<Bytes> {
    const [current] = await this.peerKeyCandidates(peerUid);
    if (current === undefined) throw new MessagingError('peer-has-no-key');
    return current;
  }

  /** Drops every cached peer key. Called when the vault locks or the account changes. */
  forgetKeys(): void {
    this.peerKeys.clear();
    this.labels = new Map();
    this.contactEntries = [];
    this.namedPeers.clear();
    this.contactsLoaded = false;
    // Locking takes the recovered identity with it, exactly as it takes the vault's own. It is
    // another account's secret and nothing writes it down, so the passphrase is asked for again.
    this.recovered?.dispose();
    this.recovered = null;
  }

  /**
   * Drops everything that belonged to the account that just went away.
   *
   * Everything `forgetKeys` drops, plus the two it deliberately keeps: the conversation list,
   * and the fact that it has loaded. Locking has to keep those, because the list stays
   * readable while locked. Another account must not be handed either -- not the rows, and not
   * the flag that would present them as settled data rather than a list still arriving.
   */
  private forgetAccount(): void {
    this.forgetKeys();
    this.conversations = [];
    this.loaded = false;
    // Whose key is published is a fact about an account, not about a device. Carried into the
    // next account it would accuse a vault that owns its identity perfectly well.
    this.foreignVault = false;
    this.historicalIdentity = false;
  }

  /**
   * Points the caches at whoever is signed in NOW, emptying them when that is somebody else.
   *
   * Called before anything reads them or subscribes, so no caller can observe data from the
   * previous account -- not even during the one synchronous emit `watch` makes before its
   * listeners attach, which is where this leaked. The same shape as
   * `EntitlementsController.follow`, which compares the uid on the mirrored document against
   * the signed-in one and resets to nothing when they differ, for the same reason.
   */
  private syncAccount(): string | null {
    const uid = this.uid;
    if (uid !== this.cacheUid) {
      this.forgetAccount();
      this.cacheUid = uid;
    }
    return uid;
  }

  // -------------------------------------------------------------------------------------------
  // Contact labels (private to this account, encrypted with its own key)
  // -------------------------------------------------------------------------------------------

  /**
   * Re-opens every sealed contact label with whichever identity is current.
   *
   * Called both when the collection arrives and when the identity changes, so there is one place
   * that decides what the address book says and no way for the two to disagree.
   */
  private relabel(): void {
    const labels = new Map<string, string>();
    for (const entry of this.contactEntries) {
      const label = this.openLabel(entry.id, entry.data);
      if (label !== null) labels.set(entry.id, label);
    }
    this.labels = labels;
  }

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
    const identity = this.currentIdentity();
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
      foreignVault: this.foreignVault,
      historicalIdentity: this.historicalIdentity,
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
    // Before the first emit, not after. That emit is synchronous, and without this it hands
    // the account that just signed in the conversations and contact names of the one before.
    const uid = this.syncAccount();
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
    //
    // Emitting afterwards is not decoration: this is also where a foreign vault is discovered,
    // and nothing else would tell the screen. Without it the banner would wait for whatever
    // snapshot happened to arrive next, which on a quiet account is never.
    void this.publishKey().then(emit);
    const stopConversations = cloud.watchCollection(
      MESSAGING_PATHS.conversations(),
      { arrayContains: { field: 'members', value: uid }, limit: CONVERSATION_PAGE_SIZE },
      (entries) => {
        // A listener outlives the account that opened it: the screen holds it until its effect
        // unmounts, and signing out does not unmount anything. Without this a late snapshot
        // would refill the caches `syncAccount` just emptied, with rows from the wrong account.
        if (uid !== this.uid) return;
        const parsed: Conversation[] = [];
        for (const entry of entries) {
          const conversation = parseConversation(entry.id, entry.data, uid);
          if (conversation !== null) parsed.push(conversation);
        }
        this.conversations = parsed;
        this.loaded = true;
        emit();
        this.nameUnknownPeers(uid);
      },
      () => {
        onError?.(new MessagingError('unavailable'));
      },
    );
    // Recovery changes what this list can say -- the labels open, and `foreignVault` clears --
    // without anything arriving from the server to prompt it.
    this.identityChanged.add(emit);
    const stopContacts = cloud.watchCollection(
      `users/${uid}/contacts`,
      { orderBy: 'updatedAt', direction: 'desc', limit: CONVERSATION_PAGE_SIZE },
      (entries) => {
        if (uid !== this.uid) return;
        this.contactEntries = entries.map((entry) => ({ id: entry.id, data: entry.data }));
        this.relabel();
        this.contactsLoaded = true;
        emit();
        this.nameUnknownPeers(uid);
      },
      () => undefined,
    );
    return () => {
      this.identityChanged.delete(emit);
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
    // Same reason as `watch`: the label below is read from the cache, and a thread opened
    // straight after an account change must not be captioned with the name the previous
    // account gave that peer.
    const uid = this.syncAccount();
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
    // Every key this thread could be sealed under. Empty until they are derived, which is
    // what `canSend` and the null bodies below are reading.
    let keys: readonly Bytes[] = [];
    let problem: MessagingErrorCode | null = null;
    let loaded = false;
    // Applied on every emit rather than once, so a message hidden while the thread is open
    // disappears from it without needing the screen to be closed and reopened.
    let hidden: ReadonlySet<string> = new Set();
    /** Message ids that have already had a peer-key refresh spent on them. See `emit`. */
    const refreshedFor = new Set<string>();
    let refreshingKeys = false;

    const emit = (): void => {
      const messages: DecryptedMessage[] = stored
        // Dropped here, at the one place the thread is built, so there is no path that assembles
        // a list of messages without this filter having run.
        .filter((message) => !hidden.has(message.id))
        .map((message) => ({
          id: message.id,
          from: message.from,
          createdAt: message.createdAt,
          mine: message.from === uid,
          // A withdrawn message has no ciphertext left to open -- the document it came from no
          // longer carries any. The placeholder is the screen's job, not this layer's.
          //
          // A media message's `box` holds its caption envelope, which is empty today; the media
          // itself is fetched separately. Opening it is harmless either way and keeps one path.
          body:
            message.deleted || keys.length === 0
              ? null
              : openWithAny(keys, (key) =>
                  openMessage({ box: message.box, nonce: message.nonce }, key, {
                    conversationId,
                    from: message.from,
                    createdAt: message.createdAt,
                  }),
                ),
          kind: message.kind,
          object: message.object,
          thumbObject: message.thumbObject,
          deleted: message.deleted,
        }));
      const canSend =
        this.canMessage() && keys.length > 0 && !this.foreignVault && !this.historicalIdentity;
      onChange({
        id: conversationId,
        peerUid,
        label: this.labels.get(peerUid) ?? null,
        messages,
        canSend,
        // The concrete failure wins: it is the thing that actually happened. Only when there
        // was none is "no Pro" the answer, and only after that is it simply not ready yet.
        //
        // A foreign vault comes first of all, because the keys derive perfectly well from it --
        // they are simply the wrong ones. Left to the line below, a composer that can never
        // work would sit on "Getting this conversation ready…" indefinitely.
        sendBlocked: canSend
          ? null
          : this.foreignVault
            ? 'foreign-vault'
            : this.historicalIdentity
              ? 'historical-identity'
              : (problem ?? (this.canMessage() ? 'preparing' : 'pro-required')),
        loaded,
        problem,
      });

      // THE OTHER DIRECTION of the stale-key bug. `conversationKey` now re-reads before sealing,
      // so this device never writes to a key its peer has retired -- but the keys it OPENS with
      // come from the same cache, which is filled once and cleared only by a vault lock. So when
      // the PEER rotates, their new messages arrive sealed under a key this device has never
      // heard of and read as "could not be opened" until the vault happens to lock.
      //
      // One re-read fixes that, and the whole difficulty is doing it ONCE. This account may hold
      // messages that can never open -- anything sealed under an identity it has since retired,
      // which `startFreshIdentity` creates deliberately. A plain retry-on-failure would re-read
      // the peer's keys on every emit, for ever, for messages no key will ever open.
      //
      // So failures are remembered by id. A message that has already been through a refresh
      // never triggers another; only an id failing for the FIRST time does. A rotation always
      // arrives as new ids, so it always gets its one attempt, and a thread full of permanently
      // dead messages costs exactly one read in total.
      if (keys.length > 0 && !refreshingKeys) {
        const unopened = messages.filter((m) => !m.deleted && m.body === null).map((m) => m.id);
        if (unopened.some((id) => !refreshedFor.has(id))) {
          for (const id of unopened) refreshedFor.add(id);
          refreshingKeys = true;
          loadKeys(true);
        }
      }
    };

    const refreshHidden = (): void => {
      void this.deps.hidden?.forConversation(conversationId).then((ids) => {
        hidden = ids;
        emit();
      });
    };

    /**
     * Derives this thread's keys and shows whatever they can open.
     *
     * Run again when the identity is recovered, because the conversation key is
     * HKDF(ECDH(peer, mine)) and "mine" has just changed -- so the SAME stored messages open
     * under a different key, and nothing arrives from the server to say so.
     */
    const loadKeys = (refresh = false): void => {
      void this.conversationKeys(conversationId, peerUid, refresh)
        .then((derived) => {
          keys = derived;
          problem = null;
          refreshingKeys = false;
          emit();
        })
        .catch((error: unknown) => {
          problem = error instanceof MessagingError ? error.code : 'unavailable';
          refreshingKeys = false;
          emit();
        });
    };

    emit();
    refreshHidden();
    // Re-read when this device hides something, so the message leaves an OPEN thread rather than
    // only a reopened one. `deleteForMe` fires this after the write, never before.
    this.hiddenChanged.add(refreshHidden);
    this.identityChanged.add(loadKeys);
    loadKeys();

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
    return () => {
      this.hiddenChanged.delete(refreshHidden);
      this.identityChanged.delete(loadKeys);
      stop();
    };
  }

  /**
   * Every conversation key this thread could be sealed under, newest first.
   *
   * One per key the peer has published. A historical entry that is not a usable X25519 key is
   * skipped rather than fatal -- it can only have come from a document this client did not
   * write, and the keys around it are still good.
   */
  private async conversationKeys(
    conversationId: string,
    peerUid: string,
    refresh = false,
  ): Promise<readonly Bytes[]> {
    const identity = this.requireIdentity();
    const keys: Bytes[] = [];
    for (const peerPublic of await this.peerKeyCandidates(peerUid, refresh)) {
      try {
        keys.push(identity.conversationKey(peerPublic, conversationId));
      } catch {
        // Not a key this protocol can use. Skip it.
      }
    }
    if (keys.length === 0) throw new MessagingError('peer-has-no-key');
    return keys;
  }

  /**
   * The key to seal WITH: derived from what the peer publishes now, never from history.
   *
   * "Now" is RE-READ rather than remembered, and that is the whole point of the flag. `peerKeys`
   * is filled on first use and cleared only by `forgetKeys` -- a vault lock or an account change
   * -- so a device left unlocked kept sealing to a key the peer had since retired. Nothing
   * expired the entry, nothing invalidated it, and neither side was told: the sender saw its own
   * message appear normally, and the recipient, who never held the retired private half, got
   * "This message could not be opened on this device" for ever.
   *
   * That was not theoretical. It happened within minutes of the first real `startFreshIdentity`,
   * in a conversation created five minutes AFTER the rotation -- the peer had every chance to
   * read the new key and never looked.
   *
   * One extra document read per message sent, which buys the message being readable at all. The
   * OPEN path deliberately keeps using the cache: a stale list there costs a retry, while a
   * stale key here costs the message permanently.
   */
  private async conversationKey(conversationId: string, peerUid: string): Promise<Bytes> {
    const [current] = await this.conversationKeys(conversationId, peerUid, true);
    if (current === undefined) throw new MessagingError('peer-has-no-key');
    return current;
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
      if (error instanceof DirectoryError && error.code === 'attestation') {
        throw new MessagingError('attestation');
      }
      // Every remaining code the directory can give has copy of its own; letting them all fall
      // into one bucket is what hid an App Check failure behind a sentence about the build.
      if (error instanceof DirectoryError) {
        if (error.code === 'rate-limited') throw new MessagingError('rate-limited');
        if (error.code === 'invalid-email') throw new MessagingError('invalid-email');
        if (error.code === 'offline') throw new MessagingError('offline');
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
    // Which is exactly what a foreign vault cannot give them. Starting here would create a
    // conversation whose every reply is sealed to the other vault's key and unreadable on this
    // device, so refuse before anything is written rather than after.
    if (this.foreignVault) throw new MessagingError('foreign-vault');

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
  private nameUnknownPeers(uid: string): void {
    const { directory } = this.deps;
    if (directory === null || !this.unlocked || !this.contactsLoaded) return;
    // The two snapshots arrive in either order, so the contacts one can land while the
    // conversation list still belongs to the account that just signed out. Naming those peers
    // writes THEIR addresses into the contacts of THIS one -- a real write, to the cloud, of
    // one contact list into another account. The caller says which account its snapshot was for,
    // and nothing happens unless that, the signed-in account and the caches all agree.
    if (uid !== this.uid || uid !== this.cacheUid) return;
    for (const conversation of this.conversations) {
      const peerUid = conversation.peerUid;
      if (this.labels.has(peerUid) || this.namedPeers.has(peerUid)) continue;
      // Marked before the lookup, not after, so two snapshots arriving together ask once.
      this.namedPeers.add(peerUid);
      void (async () => {
        try {
          const email = await directory.emailForUid(peerUid);
          if (email !== null && email !== '') await this.rememberContact(peerUid, email);
        } catch (error) {
          // A name is a nicety, not a requirement. The row falls back to the account id.
          //
          // But nothing was learned here, so the mark above is now a lie: left in place it says
          // this peer has been asked about, and no later snapshot would ever ask again. One
          // failed lookup -- App Check not yet registered, a moment offline -- then meant a row
          // showing a raw account id for the life of the process, which reopening Messages did
          // not fix and only killing the app did.
          //
          // `rate-limited` is the exception, and the one refusal that means what the mark says:
          // the budget is spent for the hour, and asking again is how it was spent.
          const spent = error instanceof DirectoryError && error.code === 'rate-limited';
          if (!spent) this.namedPeers.delete(peerUid);
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
    // The peer seals to the key this account published, which this vault cannot open; what it
    // sends back is sealed to a secret the peer does not have. The bytes would arrive and be
    // unreadable at both ends, which is worse than not sending them.
    if (this.foreignVault) throw new MessagingError('foreign-vault');
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
      deleted: false,
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

    // A video is read whole into memory, so its size is taken from the file system BEFORE the read:
    // picking a 500 MB clip would otherwise allocate 500 MB in order to refuse it. Two deliberate
    // exemptions -- a photo, because being over the budget is not a refusal for one (it is
    // re-encoded below), and a source that already carries its bytes, which has no file to ask
    // about and no second copy to avoid.
    if (source.kind === 'video' && source.bytes === undefined) {
      const onDisk = await media.fs.size(source.uri);
      if (onDisk > plaintextBudget('video')) {
        throw new MessagingError('rejected', 'video-too-large');
      }
    }
    const plain = await this.readSource(media, source);
    if (plain.length === 0) throw new MessagingError('rejected', 'empty');
    // What will actually be sent: the original bytes when they fit, a smaller re-encode when they
    // do not. Everything below works on `sendable`, so the preview, the cipher, the uploaded
    // object and the `bytes` field in the document all describe the same image.
    const sendable = await this.fitForSending(media, source.kind, plain);

    const key = await this.conversationKey(conversationId, peerUid);
    const createdAt = this.deps.clock.now();
    const id = `m_${this.deps.random.hexId(12)}`;
    const objectPath = MESSAGING_PATHS.mediaObject(conversationId, source.kind, id);
    const thumbPath = MESSAGING_PATHS.thumbObject(conversationId, id);
    const binding: MediaBinding = { conversationId, from: uid, createdAt, objectPath };

    // The preview is regenerated at the chat size even when the source already has one: the
    // vault's own thumbnails are 512px and over the 32 KB cap the Storage rules enforce.
    const thumbBytes = await this.thumbnailFor(media, source, sendable);
    let thumbObject: string | null = null;
    if (thumbBytes !== null) {
      const sealedThumb = sealThumb(thumbBytes, key, binding, this.deps.random);
      await cloud.putBlob(thumbPath, packSealed(sealedThumb));
      thumbObject = thumbPath;
    }

    const sealed = sealMedia(sendable, key, binding, this.deps.random);
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
      deleted: false,
    };
  }

  /**
   * The full media, decrypted to a scratch file the caller must release.
   *
   * Throws `expired` when the object is gone, which after 30 days is the ordinary fate of every
   * media message -- the screen needs to tell that apart from a failure it could retry.
   */
  async fetchMedia(
    conversationId: string,
    message: DecryptedMessage,
    onProgress?: (state: TransferState) => void,
  ): Promise<string> {
    const media = this.requireMedia();
    const plain = await this.fetchMediaBytes(conversationId, message, onProgress);
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
  async fetchMediaBytes(
    conversationId: string,
    message: DecryptedMessage,
    onProgress?: (state: TransferState) => void,
  ): Promise<Bytes> {
    const cloud = this.requireCloud();
    const uid = this.requireUid();
    if (message.object === null || message.kind === null) {
      throw new MessagingError('unavailable');
    }
    const peerUid = peerOf(conversationId, uid);
    if (peerUid === null) throw new MessagingError('unavailable');
    // Held in a const because the binding below is built inside a callback, where the narrowing
    // from the null check above no longer applies.
    const objectPath = message.object;
    const keys = await this.conversationKeys(conversationId, peerUid);
    const blob = await this.fetchBlob(cloud, objectPath, onProgress);
    // Everything past this point is one atomic open of a sealed box, which has no fraction to
    // report. Saying so is the difference between a wait and an apparent hang: on a real video
    // this phase alone ran for forty seconds behind an unchanging spinner.
    onProgress?.({ opening: true });
    const sealed = unpackSealed(blob);
    if (sealed === null) throw new MessagingError('unavailable');
    const plain = openWithAny(keys, (key) =>
      openMedia(sealed, key, {
        conversationId,
        from: message.from,
        createdAt: message.createdAt,
        objectPath,
      }),
    );
    if (plain === null) throw new MessagingError('unavailable');
    return plain;
  }

  /**
   * The preview bytes, or WHY there are none.
   *
   * A miss rather than a throw because an expired preview is the ordinary end state of every
   * message older than 30 days: a thread scrolling through a year of history would otherwise be
   * throwing constantly for something that is not an error.
   *
   * It used to return a bare `null` for four unrelated things -- object gone, blob malformed,
   * keys underivable, and nothing able to open it -- and the screen read every one of them as
   * expiry. So a photo sent sixty seconds earlier, sealed under a key this device no longer
   * holds, was reported to its owner as destroyed by a 30-day rule. `MediaBubble`'s own header
   * had the principle right all along ("showing expired for a dropped connection would tell
   * someone their photo had been destroyed when it had not"); it was this function that could
   * not tell the caller which had happened.
   *
   * Now it says. Gone is `expired`, present-but-unopenable is `sealed`, and anything that a
   * retry might fix -- a dropped connection above all -- THROWS, so the screen offers one.
   */
  async fetchThumb(conversationId: string, message: DecryptedMessage): Promise<Bytes | ThumbMiss> {
    const cloud = this.deps.cloud;
    const uid = this.uid;
    // Not expiry in any of these: there is no backend, nobody is signed in, or the record names
    // no object. Nothing here was destroyed, and nothing a retry does will change it.
    if (cloud === null || uid === null) return 'sealed';
    if (message.thumbObject === null || message.object === null) return 'sealed';
    const peerUid = peerOf(conversationId, uid);
    if (peerUid === null) return 'sealed';
    // As in `fetchMedia`: the binding is built inside a callback, past the null check.
    const objectPath = message.object;
    let sealed: ReturnType<typeof unpackSealed>;
    try {
      sealed = unpackSealed(await cloud.getBlob(message.thumbObject));
    } catch (cause) {
      // ONLY a missing object is expiry. A refusal or a dropped connection is not, and saying
      // so used to turn a bad signal into "your photo is gone": rethrowing puts a retry on
      // screen instead, which is the thing that might actually work.
      if (cause instanceof CloudError && cause.code === 'object-not-found') return 'expired';
      throw cause;
    }
    // The bytes are here and are not a sealed box this build understands. No retry reaches that.
    if (sealed === null) return 'sealed';
    const keys = await this.conversationKeys(conversationId, peerUid);
    const plain = openWithAny(keys, (key) =>
      openThumb(sealed, key, {
        conversationId,
        from: message.from,
        createdAt: message.createdAt,
        objectPath,
      }),
    );
    // THE ONE THIS EXISTS FOR. The object is present and intact; no key this device holds opens
    // it, because it was sealed under an identity the account has since retired. Permanent, and
    // emphatically not expiry.
    return plain ?? 'sealed';
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
      const gate = this.deps.entitlements.gate(
        repository.photos.length,
        bytes.length,
        storedBytesOf(repository.photos),
      );
      if (!gate.allowed) throw new MessagingError('vault-refused', gate.reason);
      await repository.addPhoto({ bytes }, { source: 'import' });
      return;
    }

    const uri = await this.fetchMedia(conversationId, message);
    try {
      const gate = this.deps.entitlements.gate(
        repository.photos.length,
        await media.fs.size(uri),
        storedBytesOf(repository.photos),
      );
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

  private async fetchBlob(
    cloud: CloudBackend,
    path: string,
    onProgress?: (state: TransferState) => void,
  ): Promise<Bytes> {
    try {
      return await cloud.getBlob(path, (transferred, total) => {
        onProgress?.({ transferred, total });
      });
    } catch {
      // Any failure to read the object reads as expiry: after 30 days that is what it is, and a
      // transient network error looks identical from here. The screen offers a retry either way.
      throw new MessagingError('expired');
    }
  }

  /**
   * The bytes that will be sent, which are not always the bytes that were picked.
   *
   * A photo over its budget is re-encoded smaller rather than refused. The picker is opened with
   * `quality: 1`, so a photo arrives at whatever size the camera wrote -- routinely 6-8 MB against
   * an 8 MB ceiling -- and "choose a smaller photo" is not an instruction a camera roll can obey.
   * Only when even the smallest edge will not fit is the send refused, and then the reason says so
   * instead of offering a retry that would re-run the identical work.
   *
   * A VIDEO is different and stays refused: this app has no transcoder, so nothing here could make
   * one smaller, and pretending otherwise would just move the failure later.
   */
  private async fitForSending(media: MediaDeps, kind: MediaKind, plain: Bytes): Promise<Bytes> {
    const budget = plaintextBudget(kind);
    if (kind === 'video') {
      if (plain.length > budget) throw new MessagingError('rejected', 'video-too-large');
      return plain;
    }
    const fit = await fitPhotoForSending(plain, budget, media.thumbnails);
    if (fit.kind === 'too-large') throw new MessagingError('rejected', 'photo-too-large');
    return fit.bytes;
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
        if (poster.jpegBytes.length <= THUMB_PLAINTEXT_BUDGET) return poster.jpegBytes;
        // A poster is produced at the chat size but under no byte ceiling, so one that does not
        // fit is re-encoded from itself rather than abandoned.
        const shrunk = await encodeUnderCap(
          { bytes: poster.jpegBytes },
          THUMB_PLAINTEXT_BUDGET,
          THUMB_SEND_EDGES,
          media.thumbnails,
        );
        return shrunk === null ? null : shrunk.bytes;
      }
      // The ladder starts at THUMB_MAX_EDGE, so an ordinary preview still costs exactly one
      // generation and only an unusually incompressible one costs more. Enforcing the ceiling here
      // is what keeps an oversized preview from failing the WHOLE send: `putBlob` has no try/catch
      // around it, so a refused thumbnail upload takes the photo with it.
      const fitted = await encodeUnderCap(
        { bytes: plain },
        THUMB_PLAINTEXT_BUDGET,
        THUMB_SEND_EDGES,
        media.thumbnails,
      );
      return fitted === null ? null : fitted.bytes;
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

  /**
   * Hides one message on THIS device. The peer is not told and the server never learns of it.
   *
   * Works on anything in the thread, including the other person's messages and one already
   * withdrawn -- it is a decision about what this person wants to look at, so nothing about who
   * sent it comes into it.
   */
  async deleteForMe(conversationId: string, messageId: string): Promise<void> {
    const { hidden } = this.deps;
    if (hidden === undefined) throw new MessagingError('unavailable');
    if (peerOf(conversationId, this.requireUid()) === null) {
      throw new MessagingError('unavailable');
    }
    await hidden.hide(conversationId, messageId);
    // Only after the write, so a thread never hides a message this device would show again on
    // the next launch.
    for (const listener of this.hiddenChanged) listener();
  }

  /**
   * Withdraws one of this account's own messages for both sides.
   *
   * The document is REPLACED by a tombstone rather than flagged, so the ciphertext stops existing
   * instead of merely going unrendered; the peer's own listener delivers that same document, so
   * no client is left holding a copy it could choose to show. The rules enforce the same thing
   * independently -- this method being wrong could not turn into a way past them.
   *
   * Media is deleted from Storage as well, because the document pointer disappearing would
   * otherwise leave the object readable by anyone who had noted its path. Best effort and
   * deliberately after the tombstone: a failed blob delete must not leave the message readable,
   * whereas a leftover object that nothing points at is inert.
   */
  async deleteForEveryone(conversationId: string, message: DecryptedMessage): Promise<void> {
    const cloud = this.requireCloud();
    const uid = this.requireUid();
    if (peerOf(conversationId, uid) === null) throw new MessagingError('unavailable');
    if (!message.mine || message.from !== uid) throw new MessagingError('not-mine');
    if (message.deleted) return;

    try {
      await cloud.putDocument(
        MESSAGING_PATHS.message(conversationId, message.id),
        deletedMessageRecord(message.from, message.createdAt, this.deps.clock.now()),
      );
    } catch (error) {
      throw error instanceof MessagingError ? error : new MessagingError('unavailable');
    }

    for (const object of [message.object, message.thumbObject]) {
      if (object === null) continue;
      try {
        await cloud.deleteBlob(object);
      } catch {
        // Unreachable from the app either way: nothing points at it any more.
      }
    }
  }

  /**
   * Deletes a whole conversation for BOTH members: every message, its media, and each side's
   * private label for the other.
   *
   * Irreversible, and it leaves nothing behind -- the thread disappears from the other person's
   * list with no placeholder, which is the one way this differs from withdrawing a message. The
   * screen confirms before calling it.
   *
   * Goes through a callable because it has to: the rules refuse to delete a conversation or a
   * message, and no client can delete a subcollection. Membership is checked again on the server,
   * from the conversation id, so this check is a courtesy rather than the gate.
   */
  async deleteConversation(conversationId: string): Promise<void> {
    const admin = this.deps.conversationAdmin;
    if (admin === undefined || admin === null) throw new MessagingError('unavailable');
    const uid = this.requireUid();
    if (peerOf(conversationId, uid) === null) throw new MessagingError('unavailable');
    try {
      await admin.deleteForBoth(conversationId);
    } catch (error) {
      if (error instanceof ConversationAdminError) {
        throw new MessagingError(
          error.code === 'unauthenticated' ? 'unauthenticated' : 'unavailable',
        );
      }
      throw new MessagingError('unavailable');
    }
    this.labels.delete(peerOf(conversationId, uid) ?? '');
  }
}
