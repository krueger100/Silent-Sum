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
import { CloudError, type CloudBackend, type CloudUser } from '@/firebase/types';
import type { FileSystem } from '@/storage/fileSystem';
import type { Bytes } from '@/utils/bytes';

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
export class InMemoryCloudBackend implements CloudBackend {
  readonly documents = new Map<string, Record<string, unknown>>();
  readonly blobs = new Map<string, Bytes>();
  /** Every address a reset was requested for, in order. */
  readonly passwordResets: string[] = [];

  /**
   * File transfers need somewhere to read from and write to. Tests that exercise them pass the
   * same `InMemoryFileSystem` the vault is using; without one, those two methods refuse rather
   * than silently doing something else.
   */
  constructor(private readonly files: FileSystem | null = null) {}

  private readonly accounts = new Map<string, string>();
  private readonly listeners = new Set<(user: CloudUser | null) => void>();
  private user: CloudUser | null = null;
  /**
   * Whether the session still counts as a recent login. Firebase ages this out after a few
   * minutes; the fake flips it only when a test asks, which is enough to exercise the one thing
   * that depends on it -- a delete that must be refused until the password is proved again.
   */
  private recentLogin = false;

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

  async putDocument(path: string, data: Record<string, unknown>): Promise<void> {
    this.authorize(path);
    this.documents.set(path, { ...data });
  }

  async getDocument(path: string): Promise<Record<string, unknown> | null> {
    this.authorize(path);
    const document = this.documents.get(path);
    return document === undefined ? null : { ...document };
  }

  async deleteDocument(path: string): Promise<void> {
    this.authorize(path);
    this.documents.delete(path);
  }

  async putBlob(path: string, bytes: Bytes): Promise<void> {
    this.authorize(path);
    this.blobs.set(path, Uint8Array.from(bytes));
  }

  async putBlobFromFile(path: string, localUri: string): Promise<void> {
    this.authorize(path);
    this.blobs.set(path, Uint8Array.from(await this.requireFiles().readBytes(localUri)));
  }

  async getBlob(path: string): Promise<Bytes> {
    this.authorize(path);
    const blob = this.blobs.get(path);
    if (blob === undefined) throw new CloudError(CLOUD_ERROR_CODES.objectNotFound);
    return Uint8Array.from(blob);
  }

  async getBlobToFile(path: string, localUri: string): Promise<void> {
    this.authorize(path);
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

  private authorize(path: string): void {
    const user = this.requireUser();
    // `listBlobs` is allowed to name a folder with a trailing slash; nothing else may be empty.
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    if (!path.startsWith(ownerPrefix(user.uid)) || !hasCleanSegments(normalized)) {
      throw new CloudError(CLOUD_ERROR_CODES.permissionDenied);
    }
  }
}
