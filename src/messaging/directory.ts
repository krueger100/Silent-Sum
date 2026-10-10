/**
 * Finding the person you want to talk to.
 *
 * One exact address goes out, one account id (or nothing) comes back. There is no search, so
 * SilentSum has no browsable directory of its users and no way to discover who else is on it.
 * The Pro requirement and the per-caller budget are enforced on the server; this side only has
 * to report what the server said.
 */
export type DirectoryErrorCode =
  | 'unauthenticated'
  /**
   * The server refused because this build could not prove it is genuine -- App Check got no
   * token, or the one it sent was rejected. Indistinguishable from `unauthenticated` on the
   * wire, because the server saw neither token and says so the same way either time. The
   * client knows which it actually attached, so this is now read from that rather than guessed
   * from sign-in state. Kept apart because telling a signed-in user to sign in is both wrong
   * and unactionable, and the real remedy is something they can do.
   */
  | 'attestation'
  | 'pro-required'
  | 'rate-limited'
  | 'invalid-email'
  /** Only from the reverse lookup: you may not ask about someone you are not talking to. */
  | 'not-a-correspondent'
  /**
   * The request never got an answer: no connection, DNS, TLS, or our own timeout. Separated
   * from `unavailable` because the user can act on it and because collapsing the two is what
   * let a deployment problem and a dropped connection wear the same sentence.
   */
  | 'offline'
  /** The server answered, but with something this client did not expect: a 404, a 500, a body */
  /** that is not the callable protocol. A configuration fault, not a user one. */
  | 'unavailable';

export class DirectoryError extends Error {
  constructor(readonly code: DirectoryErrorCode) {
    super(`DirectoryError(${code})`);
    this.name = 'DirectoryError';
  }
}

export function describeDirectoryError(code: DirectoryErrorCode): string {
  switch (code) {
    case 'unauthenticated':
      return 'Sign in to your backup account first.';
    case 'attestation':
      return (
        'This device could not prove to the server that the app is genuine. Update Google Play ' +
        'Store, or install SilentSum from the store, and try again.'
      );
    case 'pro-required':
      return 'Messaging is a Pro feature.';
    case 'rate-limited':
      return 'Too many lookups. Try again in an hour.';
    case 'invalid-email':
      return 'That is not an e-mail address.';
    case 'not-a-correspondent':
      return 'You are not in a conversation with that account.';
    case 'offline':
      return 'Could not reach the server. Check your connection and try again.';
    case 'unavailable':
      return 'The server did not answer as expected. Try again shortly.';
  }
}

export interface Directory {
  /** The account id for exactly this address, or null when nobody has it. */
  findByEmail(email: string): Promise<string | null>;
  /**
   * The address of an account already in a conversation with this one, or null when the server
   * answered and has none.
   *
   * The opposite direction, and a different gate: no Pro, because receiving never needs it, but
   * the server answers only for a correspondent. Best effort by design -- the caller uses it to
   * put a name on a row, and a row with an account id on it is a worse screen, not a broken one.
   *
   * A refusal throws {@link DirectoryError} rather than returning null, so the caller can tell
   * "there is no address" from "we did not get to ask" and retry only the second.
   */
  emailForUid(uid: string): Promise<string | null>;
}

/**
 * The fake, for tests and for a build with no Firebase project. It enforces the same gates as the
 * deployed functions, so a test cannot pass by skipping what the server would refuse.
 */
export class InMemoryDirectory implements Directory {
  readonly lookups: string[] = [];

  readonly reverseLookups: string[] = [];

  constructor(
    private readonly accounts: ReadonlyMap<string, string>,
    private readonly isPro: () => boolean,
    /**
     * Whether the caller may ask about `peerUid`. Left open by default for the harnesses that
     * never exercise the reverse lookup; the ones that do wire it to the conversations they have
     * actually created, because the membership gate is the whole security of this call.
     */
    private readonly sharesConversation: (peerUid: string) => boolean = () => true,
  ) {}

  async findByEmail(email: string): Promise<string | null> {
    const normalised = email.trim().toLowerCase();
    if (normalised === '' || !normalised.includes('@')) {
      throw new DirectoryError('invalid-email');
    }
    if (!this.isPro()) throw new DirectoryError('pro-required');
    this.lookups.push(normalised);
    return this.accounts.get(normalised) ?? null;
  }

  async emailForUid(uid: string): Promise<string | null> {
    if (uid === '') throw new DirectoryError('invalid-email');
    if (!this.sharesConversation(uid)) throw new DirectoryError('not-a-correspondent');
    this.reverseLookups.push(uid);
    for (const [email, owner] of this.accounts) if (owner === uid) return email;
    return null;
  }
}
