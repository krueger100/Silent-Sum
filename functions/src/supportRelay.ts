/**
 * The support relay: the app hands over a subject and a body, this decides who it goes to.
 *
 * It exists because the alternative was worse. The app used to POST straight to Resend with a
 * bearer token compiled into `extra`, which is plain text in the APK -- anyone who unzipped the
 * build could send mail as the verified domain, to anybody, until the key was rotated. The key now
 * lives in Secret Manager and never leaves the server.
 *
 * That moves the risk rather than removing it, so the shape of this module is the answer to
 * "what can a stranger who found the URL do with it?":
 *
 *   - `from` and `to` come from the SERVER's configuration. A `to` in the request body is read and
 *     discarded. Without that this would be an open mail relay for the verified domain, which is a
 *     worse thing to publish than the key was.
 *   - `reply_to` is the one address a caller may choose, because it only decides where a human
 *     answer goes, and the app offers the user that field on purpose.
 *   - Sizes are capped, and an oversized message is refused rather than truncated: a support
 *     message cut in half is worse than one the user is told to shorten.
 *   - Callers are rate limited, so the worst outcome is a bounded number of messages into the
 *     operator's own inbox rather than an unbounded Resend bill.
 *
 * There is no authentication. The endpoint is a contact form: it can send to exactly one address,
 * and the vault has no account that a locked-out user -- the one who most needs support -- could
 * sign in with. App Check would narrow it further and is noted in docs/security.md as the next
 * step, but it needs a token the app does not currently attach to this request.
 */
import { createHash } from 'node:crypto';

/** One outbound message, fully resolved. Nothing here came from the caller except the words. */
export interface SupportMail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly replyTo: string | null;
}

export interface SupportMailer {
  /** Returns the provider's reference for the message, or null when it gave none. Throws on failure. */
  send(mail: SupportMail): Promise<string | null>;
}

export interface SupportRelayCounters {
  /** Increments the counter for `key` in `window` and returns the new count. */
  bump(key: string, window: number): Promise<number>;
}

/** Who mail is from and where it goes. Configuration, never request data. */
export interface SupportRelayConfig {
  readonly from: string;
  readonly to: string;
}

export interface SupportRelayDeps {
  readonly mailer: SupportMailer;
  readonly counters: SupportRelayCounters;
  readonly config: SupportRelayConfig;
  readonly now: () => number;
  /**
   * Where a delivery failure is recorded. The caller is told nothing useful on purpose, so without
   * this the reason would be lost entirely; `index.ts` passes the function logger.
   */
  readonly onFailure?: (error: unknown) => void;
}

export interface SupportRelayRequest {
  readonly method: string;
  readonly contentType: string | null;
  /** The parsed JSON body, or whatever arrived instead. Treated as hostile. */
  readonly body: unknown;
  /** Something stable per caller, typically the peer address. Hashed before use; never stored raw. */
  readonly clientId: string;
}

export type SupportRelayResult =
  | { readonly status: 200; readonly body: { readonly id: string | null } }
  | { readonly status: 400 | 405 | 415 | 429 | 502; readonly body: { readonly error: string } };

/** A full subject line from the app is "Calculator support: <topic>"; 200 is ample. */
export const SUPPORT_RELAY_MAX_SUBJECT = 200;

/**
 * The user's 2000 characters, plus the reply-address line and the diagnostics block the app shows
 * them before they press Send. 8000 leaves room without leaving the endpoint useful as a pipe.
 */
export const SUPPORT_RELAY_MAX_TEXT = 8000;

export const SUPPORT_RELAY_WINDOW_MS = 15 * 60_000;

/**
 * Per caller, and in total, per window.
 *
 * Two buckets because the per-caller one cannot be trusted on its own: the caller's address comes
 * from `X-Forwarded-For`, which a client can set, so a script that varies it walks straight past a
 * per-caller limit. The total is the bound that actually holds -- nobody can forge their way out of
 * it -- and it is what caps how much mail this endpoint can ever push into one inbox, or bill to
 * one Resend account. The per-caller limit is there so one abuser does not spend the whole budget
 * and lock everybody else out.
 */
export const SUPPORT_RELAY_MAX_PER_WINDOW = 5;
export const SUPPORT_RELAY_MAX_TOTAL_PER_WINDOW = 60;

/** Which fixed window a moment falls in. Counter keys are scoped to it, so it expires by itself. */
export function windowFor(now: number): number {
  return Math.floor(now / SUPPORT_RELAY_WINDOW_MS);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Deliberately loose, and the same rule the app uses. This only decides whether to attach a
 * reply-to, and a real address rejected here costs someone the answer they were waiting for.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  return /^[^\s@,;]+@[^\s@,;.]+(?:\.[^\s@,;.]+)+$/.test(value);
}

/**
 * A short, stable, non-reversible key for one caller.
 *
 * Truncated to 128 bits, which is plenty to keep buckets apart and still not something anyone can
 * turn back into an address. An empty `clientId` (no peer address available) hashes like any other
 * value, so those callers share one bucket instead of bypassing the limit.
 */
export function clientKeyFor(clientId: string): string {
  return createHash('sha256').update(`silentsum-support:${clientId}`).digest('hex').slice(0, 32);
}

/** The counter every request shares, whatever it claims its address is. */
export const SUPPORT_RELAY_TOTAL_KEY = 'all';

function refuse(status: 400 | 405 | 415 | 429 | 502, error: string): SupportRelayResult {
  return { status, body: { error } };
}

/**
 * Handles one request. Returns the status and body to send; never throws, so a caller cannot make
 * the function log a stack trace by sending something odd.
 */
export async function relaySupport(
  deps: SupportRelayDeps,
  request: SupportRelayRequest,
): Promise<SupportRelayResult> {
  if (request.method.toUpperCase() !== 'POST') {
    return refuse(405, 'Use POST.');
  }
  // A JSON body is the only thing this understands. Checked before the body is read so a form or
  // multipart post is refused as such rather than as a malformed message.
  if (request.contentType === null || !/^application\/json\b/i.test(request.contentType.trim())) {
    return refuse(415, 'Send application/json.');
  }

  const body = record(request.body);
  if (body === null) return refuse(400, 'Expected a JSON object.');

  const subject = text(body.subject);
  const message = text(body.text);
  if (subject === null || message === null) {
    return refuse(400, 'A subject and a body are required.');
  }
  if (subject.length > SUPPORT_RELAY_MAX_SUBJECT || message.length > SUPPORT_RELAY_MAX_TEXT) {
    return refuse(400, 'That message is too long.');
  }

  // Read from the body, unlike `from` and `to`, which are read from configuration below.
  const replyToRaw = text(body.reply_to);
  const replyTo = replyToRaw !== null && isPlausibleEmail(replyToRaw) ? replyToRaw : null;

  // Counted before anything is sent, and counted even when the limit refuses: an attempt that was
  // turned away is still an attempt, and a caller that keeps trying should stay turned away.
  const window = windowFor(deps.now());
  const mine = await deps.counters.bump(clientKeyFor(request.clientId), window);
  if (mine > SUPPORT_RELAY_MAX_PER_WINDOW) {
    return refuse(429, 'Too many messages. Please try again shortly.');
  }
  const total = await deps.counters.bump(SUPPORT_RELAY_TOTAL_KEY, window);
  if (total > SUPPORT_RELAY_MAX_TOTAL_PER_WINDOW) {
    return refuse(429, 'Too many messages. Please try again shortly.');
  }

  try {
    const id = await deps.mailer.send({
      from: deps.config.from,
      to: deps.config.to,
      subject,
      text: message,
      replyTo,
    });
    return { status: 200, body: { id } };
  } catch (error) {
    // The provider's own wording is for the server log, not for a stranger's screen.
    deps.onFailure?.(error);
    return refuse(502, 'The message could not be delivered right now.');
  }
}
