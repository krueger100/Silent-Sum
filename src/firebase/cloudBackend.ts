/**
 * The shared parts of the `CloudBackend` contract plus the in-memory implementation.
 *
 * `InMemoryCloudBackend` is not only a convenience fake: it enforces the same owner-only rule as
 * the deployed Firestore/Storage rules, so a caller that reaches outside `users/<uid>/` fails in a
 * test instead of failing in production against rules nobody can debug from the device.
 *
 * Everything stored here is whatever the backup layer uploads — ciphertext and a passphrase-wrapped
 * key envelope. This module never sees a vault key.
 */
import {
  CloudError,
  isFieldIncrement,
  type CloudBackend,
  type CloudUser,
  type CollectionEntry,
  type CollectionQuery,
} from '@/firebase/types';
import type { FileSystem } from '@/storage/fileSystem';
import type { Bytes } from '@/utils/bytes';

/**
 * What a field is worth when ordering a collection. Only numbers and strings order; anything else
 * (absent, null, an object) has no place in the sort and is pushed to the end.
 */
function sortKey(value: unknown): number | string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return null;
}

/** Numbers before strings, as Firestore orders across types; equal values fall through to 0. */
function compareKeys(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The error codes the app is allowed to branch on. Both backends produce exactly these for the
 * situations they describe, so UI copy can be written once against them.
 */
export const CLOUD_ERROR_CODES = {
  /** No blob at that path. */
  objectNotFound: 'object-not-found',
  /** Path is outside the signed-in user's own subtree, or the rules refused it. */
  permissionDenied: 'permission-denied',
  /** No signed-in user. */
  unauthenticated: 'unauthenticated',
  /**
   * Signed in, but not recently enough for an operation the provider treats as sensitive.
   *
   * Deliberately distinct from `unauthenticated`: the remedy is to prove the account password
   * again, not to sign in. Folding the two together told a signed-in user to sign in.
   */
  requiresRecentLogin: 'requires-recent-login',
  /** Sign-in rejected the e-mail/password pair. */
  wrongPassword: 'wrong-password',
  /** Sign-up with an e-mail that already has an account. */
  emailAlreadyInUse: 'email-already-in-use',
  /** No account for that address. Never surfaced as such: see `requestPasswordReset`. */
  userNotFound: 'user-not-found',
  /** Anything the native SDK reported without a code we recognise. */
  unknown: 'unknown',
} as const;

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[keyof typeof CLOUD_ERROR_CODES];

/** Every document and blob the app may touch lives under this prefix. */
export function ownerPrefix(uid: string): string {
  return `users/${uid}/`;
}

/**
 * The two collections that deliberately sit OUTSIDE the owner subtree, because they are shared
 * with another account. These mirror the deployed security rules exactly; anything looser here
 * would let a test pass that the real database refuses.
 *
 * - `messagingKeys/<uid>`: one public key per account. Any signed-in user may read one (that is
 *   what makes it a public key); only its owner may write it.
 * - `conversations/<a>__<b>[/messages/<id>]`: readable and writable only by the two accounts
 *   named in the id. Membership comes from the id itself, so neither store has to read the
 *   parent document to answer the question.
 */
const MESSAGING_KEYS_PREFIX = 'messagingKeys/';
const CONVERSATIONS_PREFIX = 'conversations/';
/** The Storage half of a conversation: `messages/{cid}/{photo|video|thumb}/{objectId}`. */
const CHAT_MEDIA_PREFIX = 'messages/';
export const CONVERSATION_ID_SEPARATOR = '__';

function sharedPathAllows(path: string, uid: string, write: boolean): boolean {
  if (path.startsWith(MESSAGING_KEYS_PREFIX)) {
    const rest = path.slice(MESSAGING_KEYS_PREFIX.length);
    if (rest === '' || rest.includes('/')) return false;
    return write ? rest === uid : true;
  }
  // Chat media objects. The Storage rules read membership straight from the conversation id in
  // the path (`request.auth.uid in cid.split('__')`), and so does this: a fake that waved these
  // through would let a test pass that the real bucket refuses.
  if (path.startsWith(CHAT_MEDIA_PREFIX)) {
    const [conversationId, kind, ...tail] = path.slice(CHAT_MEDIA_PREFIX.length).split('/');
    if (conversationId === undefined || conversationId === '') return false;
    if (kind !== 'photo' && kind !== 'video' && kind !== 'thumb') return false;
    // Exactly one object name under the kind, matching `messages/{cid}/{kind}/{objectId}`.
    if (tail.length !== 1 || tail[0] === '') return false;
    return conversationId.split(CONVERSATION_ID_SEPARATOR).includes(uid);
  }
  if (!path.startsWith(CONVERSATIONS_PREFIX)) return false;
  const rest = path.slice(CONVERSATIONS_PREFIX.length);
  const [conversationId, ...tail] = rest.split('/');
  if (conversationId === undefined || conversationId === '') return false;
  // The conversation document, its `messages` collection, and one message in it. Nothing else.
  if (tail.length > 2) return false;
  if (tail.length >= 1 && tail[0] !== 'messages') return false;
  if (tail.length === 2 && tail[1] === '') return false;
  return conversationId.split(CONVERSATION_ID_SEPARATOR).includes(uid);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Applies one write the way Firestore would: a replace by default, or a field-by-field merge that
 * recurses into nested maps and resolves `FieldIncrement` against what is already stored. A
 * missing field counts as zero, exactly as `FieldValue.increment` does.
 */
function mergeInto(
  existing: Record<string, unknown>,
  data: Record<string, unknown>,
  merge: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = merge ? { ...existing } : {};
  for (const [key, value] of Object.entries(data)) {
    const before = existing[key];
    if (isFieldIncrement(value)) {
      out[key] = (typeof before === 'number' ? before : 0) + value.__increment;
    } else if (isPlainObject(value)) {
      out[key] = mergeInto(isPlainObject(before) ? before : {}, value, merge);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The app only ever builds paths from `BACKUP_PATHS`, so an empty, `.` or `..` segment means the
 * path was assembled from something untrusted. Rejecting it keeps `startsWith` from being fooled by
 * `users/<uid>/../someone-else/...`.
 */
function hasCleanSegments(path: string): boolean {
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Deterministic per-e-mail id. Arbitrary by design: only the fake ever mints uids. */
function fakeUid(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (Math.imul(31, hash) + email.charCodeAt(i)) | 0;
  }
  return `uid_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * In-memory `CloudBackend` for tests and for running the backup flows without a Firebase project.
 *
 * Authorisation is checked on every single document and blob operation, including `listBlobs`:
 * no signed-in user is `unauthenticated`, and a path outside `users/<uid>/` is `permission-denied`.
 */
/**
 * The database behind the fake, separated from the signed-in session in front of it.
 *
 * One store can back TWO backends, which is how a two-party feature is tested: each account gets
 * its own `InMemoryCloudBackend` (its own session, its own authorisation) over one set of
 * documents and one set of listeners, so a write by one really does wake the other's watcher.
 */
export class InMemoryCloudStore {
  readonly documents = new Map<string, Record<string, unknown>>();
  readonly blobs = new Map<string, Bytes>();
  readonly passwordResets: string[] = [];
  readonly accounts = new Map<string, string>();
  readonly watchers = new Map<string, Set<(doc: Record<string, unknown> | null) => void>>();
  readonly collectionWatchers = new Map<string, Set<() => void>>();
}

export class InMemoryCloudBackend implements CloudBackend {
  /**
   * File transfers need somewhere to read from and write to. Tests that exercise them pass the
   * same `InMemoryFileSystem` the vault is using; without one, those two methods refuse rather
   * than silently doing something else. `store` is shared to put a second account on the same
   * database; left out, this backend gets one of its own.
   */
  constructor(
    private readonly files: FileSystem | null = null,
    private readonly store: InMemoryCloudStore = new InMemoryCloudStore(),
  ) {}

  get documents(): Map<string, Record<string, unknown>> {
    return this.store.documents;
  }

  get blobs(): Map<string, Bytes> {
    return this.store.blobs;
  }

  /** Every address a reset was requested for, in order. */
  get passwordResets(): string[] {
    return this.store.passwordResets;
  }

  private get accounts(): Map<string, string> {
    return this.store.accounts;
  }

  private readonly listeners = new Set<(user: CloudUser | null) => void>();
  private user: CloudUser | null = null;
  /**
   * Whether the session still counts as a recent login. Firebase ages this out after a few
   * minutes; the fake flips it only when a test asks, which is enough to exercise the one thing
   * that depends on it -- a delete that must be refused until the password is proved again.
   */
  private recentLogin = false;

  /** Armed by `failNextBlobUpload`, consumed by the next blob write. */
  private failNextUpload = false;

  /** Every blob path written, in order, so a test can prove nothing was uploaded. */
  readonly blobWrites: string[] = [];

  get currentUser(): CloudUser | null {
    return this.user;
  }

  /** Emits the current user immediately, like Firebase Auth's own listener does. */
  onAuthStateChanged(listener: (user: CloudUser | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.user);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async signIn(email: string, password: string): Promise<CloudUser> {
    if (this.accounts.get(email) !== password) {
      throw new CloudError(CLOUD_ERROR_CODES.wrongPassword);
    }
    return this.setUser(email);
  }

  async signUp(email: string, password: string): Promise<CloudUser> {
    if (this.accounts.has(email)) {
      throw new CloudError(CLOUD_ERROR_CODES.emailAlreadyInUse);
    }
    this.accounts.set(email, password);
    return this.setUser(email);
  }

  /**
   * Records the request. The fake cannot send mail, so a test asserts on what was asked for.
   *
   * An unknown address is reported the way Firebase reports it with e-mail enumeration protection
   * off, so the screens are exercised against the harder case; they are the ones that decide not
   * to confirm whether an account exists.
   */
  async sendPasswordReset(email: string): Promise<void> {
    this.passwordResets.push(email);
    if (!this.accounts.has(email)) throw new CloudError(CLOUD_ERROR_CODES.userNotFound);
  }

  async signOut(): Promise<void> {
    this.setCurrentUser(null);
  }

  /** Test helper: the account password, so a spec can prove a reset did not silently change it. */
  passwordFor(email: string): string | undefined {
    return this.accounts.get(email);
  }

  /** Test helper: stands in for the user following the link in the mail. */
  completePasswordReset(email: string, newPassword: string): void {
    if (!this.accounts.has(email)) throw new CloudError(CLOUD_ERROR_CODES.userNotFound);
    this.accounts.set(email, newPassword);
    // Firebase revokes refresh tokens on a reset; the fake models that as an immediate sign-out.
    if (this.user?.email === email) this.setCurrentUser(null);
  }

  /**
   * Re-proves the account password for the signed-in user, making the session recent again.
   * A wrong password leaves the session exactly as stale as it was.
   */
  async reauthenticate(password: string): Promise<void> {
    const user = this.requireUser();
    if (user.email === null || this.accounts.get(user.email) !== password) {
      throw new CloudError(CLOUD_ERROR_CODES.wrongPassword);
    }
    this.recentLogin = true;
  }

  /** Test helper: ages the session out, the way Firebase does after a few minutes. */
  expireRecentLogin(): void {
    this.recentLogin = false;
  }

  /**
   * Test helper: deletes every blob under a prefix, leaving documents untouched.
   *
   * This is what the 30-day chat-media lifecycle rule does. That rule is bucket configuration
   * that no test can run, so without this seam the expired state -- the ordinary end state of
   * every media message older than a month -- could not be exercised at all.
   */
  expireBlobsUnder(prefix: string): void {
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(prefix)) this.blobs.delete(key);
    }
  }

  /** Test helper: makes the next blob upload fail, so a partial send can be exercised. */
  failNextBlobUpload(): void {
    this.failNextUpload = true;
  }

  /** Removes the account and everything it owns, mirroring a full server-side wipe. */
  async deleteAccount(): Promise<void> {
    const user = this.requireUser();
    // Firebase refuses this on a stale session, and so does the fake: a flow that only ever runs
    // against a fresh one here would sail through the tests and fail on the first real device.
    if (!this.recentLogin) throw new CloudError(CLOUD_ERROR_CODES.requiresRecentLogin);
    const prefix = ownerPrefix(user.uid);
    for (const key of [...this.documents.keys()]) {
      if (key.startsWith(prefix)) this.documents.delete(key);
    }
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(prefix)) this.blobs.delete(key);
    }
    if (user.email !== null) this.accounts.delete(user.email);
    this.setCurrentUser(null);
  }

  async putDocument(
    path: string,
    data: Record<string, unknown>,
    options?: { readonly merge?: boolean },
  ): Promise<void> {
    this.authorize(path);
    const existing = options?.merge === true ? this.documents.get(path) : undefined;
    this.documents.set(path, mergeInto(existing ?? {}, data, options?.merge === true));
    this.notify(path);
  }

  async getDocument(path: string): Promise<Record<string, unknown> | null> {
    this.authorize(path, 'read');
    const document = this.documents.get(path);
    return document === undefined ? null : { ...document };
  }

  async deleteDocument(path: string): Promise<void> {
    this.authorize(path);
    this.documents.delete(path);
    this.notify(path);
  }

  watchDocument(
    path: string,
    onChange: (doc: Record<string, unknown> | null) => void,
    _onError?: (error: CloudError) => void,
  ): () => void {
    this.authorize(path);
    let listeners = this.watchers.get(path);
    if (listeners === undefined) {
      listeners = new Set();
      this.watchers.set(path, listeners);
    }
    listeners.add(onChange);
    onChange(this.snapshotOf(path));
    return () => {
      listeners.delete(onChange);
    };
  }

  watchCollection(
    path: string,
    query: CollectionQuery,
    onChange: (entries: CollectionEntry[]) => void,
    _onError?: (error: CloudError) => void,
  ): () => void {
    this.authorizeCollection(path, query);
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const deliver = (): void => {
      onChange(this.collectionSnapshot(prefix, query));
    };
    let listeners = this.collectionWatchers.get(prefix);
    if (listeners === undefined) {
      listeners = new Set();
      this.collectionWatchers.set(prefix, listeners);
    }
    listeners.add(deliver);
    deliver();
    return () => {
      listeners.delete(deliver);
    };
  }

  /**
   * What the Admin SDK does on the server: a write that answers to no owner rule. Only the
   * simulated backend calls this; the app has no such power and no such code path.
   */
  adminPutDocument(path: string, data: Record<string, unknown>): void {
    this.documents.set(path, { ...data });
    this.notify(path);
  }

  adminDeleteDocument(path: string): void {
    this.documents.delete(path);
    this.notify(path);
  }

  private get watchers(): Map<string, Set<(doc: Record<string, unknown> | null) => void>> {
    return this.store.watchers;
  }

  private get collectionWatchers(): Map<string, Set<() => void>> {
    return this.store.collectionWatchers;
  }

  private snapshotOf(path: string): Record<string, unknown> | null {
    const document = this.documents.get(path);
    return document === undefined ? null : { ...document };
  }

  /**
   * Direct children of `prefix` only, as a Firestore collection is: `a/b/c` belongs to `a/b/`,
   * `a/b/c/d` does not. Ordered by the query's field, with a missing or non-comparable value
   * sorting last, then capped.
   */
  private collectionSnapshot(prefix: string, query: CollectionQuery): CollectionEntry[] {
    const entries: CollectionEntry[] = [];
    const filter = query.arrayContains;
    for (const [key, value] of this.documents) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (id === '' || id.includes('/')) continue;
      if (filter !== undefined) {
        const field = value[filter.field];
        if (!Array.isArray(field) || !field.includes(filter.value)) continue;
      }
      entries.push({ id, data: { ...value } });
    }
    const orderBy = query.orderBy;
    if (orderBy === undefined) {
      entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit));
    }
    const descending = query.direction === 'desc';
    entries.sort((a, b) => {
      const left = sortKey(a.data[orderBy]);
      const right = sortKey(b.data[orderBy]);
      if (left === null && right === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (left === null) return 1;
      if (right === null) return -1;
      const order = compareKeys(left, right);
      if (order === 0) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return descending ? -order : order;
    });
    return query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit));
  }

  /** Each listener gets its own copy, as a Firestore snapshot would be, so none can edit the store. */
  private notify(path: string): void {
    const listeners = this.watchers.get(path);
    if (listeners !== undefined) {
      for (const listener of [...listeners]) listener(this.snapshotOf(path));
    }
    const slash = path.lastIndexOf('/');
    if (slash <= 0) return;
    const collectionListeners = this.collectionWatchers.get(path.slice(0, slash + 1));
    if (collectionListeners === undefined) return;
    for (const listener of [...collectionListeners]) listener();
  }

  /** Consumes an armed upload failure, mirroring a network or rules refusal mid-send. */
  private checkUpload(): void {
    if (!this.failNextUpload) return;
    this.failNextUpload = false;
    throw new CloudError(CLOUD_ERROR_CODES.permissionDenied);
  }

  async putBlob(path: string, bytes: Bytes): Promise<void> {
    this.authorize(path);
    this.checkUpload();
    this.blobWrites.push(path);
    this.blobs.set(path, Uint8Array.from(bytes));
  }

  async putBlobFromFile(path: string, localUri: string): Promise<void> {
    this.authorize(path);
    this.checkUpload();
    this.blobWrites.push(path);
    this.blobs.set(path, Uint8Array.from(await this.requireFiles().readBytes(localUri)));
  }

  async getBlob(path: string): Promise<Bytes> {
    this.authorize(path, 'read');
    const blob = this.blobs.get(path);
    if (blob === undefined) throw new CloudError(CLOUD_ERROR_CODES.objectNotFound);
    return Uint8Array.from(blob);
  }

  async getBlobToFile(path: string, localUri: string): Promise<void> {
    this.authorize(path, 'read');
    const blob = this.blobs.get(path);
    if (blob === undefined) throw new CloudError(CLOUD_ERROR_CODES.objectNotFound);
    await this.requireFiles().writeBytes(localUri, blob);
  }

  private requireFiles(): FileSystem {
    const files = this.files;
    if (files === null) {
      throw new CloudError(CLOUD_ERROR_CODES.unknown, 'file transfers need a file system');
    }
    return files;
  }

  async deleteBlob(path: string): Promise<void> {
    this.authorize(path);
    this.blobs.delete(path);
  }

  async listBlobs(prefix: string): Promise<string[]> {
    this.authorize(prefix);
    const folder = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const names: string[] = [];
    for (const key of this.blobs.keys()) {
      if (!key.startsWith(folder)) continue;
      const name = key.slice(folder.length);
      if (!name.includes('/')) names.push(name);
    }
    return names;
  }

  private setUser(email: string): CloudUser {
    const user: CloudUser = { uid: fakeUid(email), email };
    // Signing in IS a recent login; signing out ends any claim to one.
    this.recentLogin = true;
    this.setCurrentUser(user);
    return user;
  }

  private setCurrentUser(user: CloudUser | null): void {
    if (user === null) this.recentLogin = false;
    this.user = user;
    for (const listener of this.listeners) listener(user);
  }

  private requireUser(): CloudUser {
    const user = this.user;
    if (user === null) throw new CloudError(CLOUD_ERROR_CODES.unauthenticated);
    return user;
  }

  /**
   * A collection listing is allowed when every document it can return is one the user may read.
   * The top-level `conversations` collection qualifies only when the query itself is narrowed to
   * the caller's own membership -- which is exactly the constraint Firestore imposes, where an
   * unfiltered listing is refused rather than silently trimmed.
   */
  private authorizeCollection(path: string, query: CollectionQuery): void {
    const user = this.requireUser();
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    if (normalized === 'conversations') {
      const filter = query.arrayContains;
      if (filter?.field === 'members' && filter.value === user.uid) return;
      throw new CloudError(CLOUD_ERROR_CODES.permissionDenied);
    }
    this.authorize(path, 'read');
  }

  private authorize(path: string, mode: 'read' | 'write' = 'write'): void {
    const user = this.requireUser();
    // `listBlobs` is allowed to name a folder with a trailing slash; nothing else may be empty.
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    if (!hasCleanSegments(normalized)) {
      throw new CloudError(CLOUD_ERROR_CODES.permissionDenied);
    }
    if (path.startsWith(ownerPrefix(user.uid))) return;
    if (sharedPathAllows(normalized, user.uid, mode === 'write')) return;
    throw new CloudError(CLOUD_ERROR_CODES.permissionDenied);
  }
}
