/**
 * What a messaging recovery did, stage by stage, for a developer reading logcat.
 *
 * Recovery has several ways to fail and they used to be indistinguishable from the outside: a
 * refused escrow read, an escrow that is not this account's, a wrong passphrase and a key that is
 * simply not the published one all ended as a single sentence on screen. Working out which one
 * had happened meant reasoning from the copy backwards.
 *
 * WHAT MAY NEVER BE WRITTEN HERE. No passphrase, no master key, no private key, no message body,
 * no contact label. Not even in a length or a prefix -- a hex prefix of a key is still key
 * material, and a passphrase's length is a meaningful narrowing of the search space. What IS
 * allowed is the shape of what happened: which stage ran, whether a document was present, and an
 * error CODE.
 *
 * A public key is the one exception, and only as a short prefix for matching two of them against
 * each other. It is already published to every signed-in user at `messagingKeys/{uid}`; the whole
 * difficulty this logging exists to explain is two public keys not being equal, and saying so
 * without being able to name either is useless. uids are never logged: they are an address, but
 * they are also the social graph when they appear beside a conversation.
 *
 * WHICH BUILDS TRACE. The build's own environment flag, `extra.silentsumEnv`, and nothing else.
 * This was `__DEV__` first, which was exactly wrong for the builds that need it: a dev-environment
 * RELEASE apk -- `SILENTSUM_ENV=dev ./gradlew assembleRelease`, which is what this project installs
 * on the emulator to test against real Firebase -- has `__DEV__` false. So the logging existed in
 * Metro, where recovery is hard to exercise against a real account, and was stripped from the one
 * artifact it was written for. The flag is the same one `app.config.ts` uses to pick the Firebase
 * config file and to decide whether to publish an App Check debug token at all, so there is one
 * notion of "this is a dev build" in the app rather than a second that can disagree with it.
 *
 * Anything that is not literally `dev` traces nothing, a build whose config cannot be read
 * included. The failure that matters here is a release build talking, so the unknown case is
 * silent.
 */
import Constants from 'expo-constants';

/** Where in the recovery a thing happened. Named for the question each stage answers. */
export type RecoveryStage =
  | 'escrow-read'
  | 'escrow-skipped-stale'
  | 'escrow-absent'
  | 'envelope-fallback'
  | 'identity-derived'
  | 'published-key-read'
  | 'key-matched'
  /** The derived key is one this account published earlier: its own vault, one rotation behind. */
  | 'key-historical'
  | 'key-mismatched'
  | 'applied';

/**
 * Whether a build whose `extra.silentsumEnv` is `rawEnv` should trace.
 *
 * Pure and exported so the decision can be tested without a build. The reader below is a one-line
 * wrapper around it, which is how the rest of the repository reads `extra` -- see
 * `support/recoveryConfig.ts`.
 */
export function recoveryTracingEnabled(rawEnv: unknown): boolean {
  return rawEnv === 'dev';
}

/** Read once: the environment is fixed at build time, so re-reading it per line proves nothing. */
let traces: boolean | null = null;

function shouldTrace(): boolean {
  if (traces === null) {
    try {
      traces = recoveryTracingEnabled(Constants.expoConfig?.extra?.silentsumEnv);
    } catch {
      // A logging gate must not be able to fail a recovery. Unreadable config means silent.
      traces = false;
    }
  }
  return traces;
}

/** The first few characters of a base64 public key: enough to tell two apart, and already public. */
export function keyFingerprint(publicKey: string | null): string {
  if (publicKey === null || publicKey === '') return '(none)';
  return `${publicKey.slice(0, 8)}…`;
}

/**
 * One line per stage. Silent in anything that is not a dev-environment build.
 *
 * `detail` is for codes and shapes -- `'permission-denied'`, `'absent'`, a key fingerprint --
 * never for anything derived from a secret. Callers pass literals, so there is no path by which a
 * passphrase or a key could arrive here through a variable nobody noticed.
 */
export function traceRecovery(stage: RecoveryStage, detail?: string): void {
  if (!shouldTrace()) return;
  console.warn(`[silentsum/recovery] ${stage}${detail === undefined ? '' : `: ${detail}`}`);
}
