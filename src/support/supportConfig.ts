/**
 * Where support messages go, read from the build's Expo config (`extra.support`).
 *
 * The values come from environment variables at build time (see `.env.example`), never from the
 * user and never from anything on the device. A build with no support configuration is normal and
 * fully supported: `readSupportConfig` returns null and the screen says so plainly instead of
 * offering a form that could not deliver anything.
 *
 * SHIPPING A RESEND API KEY
 * -------------------------
 * `https://api.resend.com/emails` needs an `Authorization: Bearer re_...` header, and a key
 * compiled into a mobile app is readable by anyone who unzips the APK. Whoever extracts it can
 * send mail as your verified domain until you rotate it. So:
 *
 *   - Preferred: point SUPPORT_ENDPOINT at a small relay you control (Cloud Function, Worker)
 *     that holds the Resend key server-side and forwards the same JSON body. Leave
 *     SUPPORT_API_KEY empty, or set it to a token that only your relay accepts.
 *   - Acceptable for a private/internal build: a Resend key restricted to *sending only*, on a
 *     domain you are willing to rotate. Never a full-access key.
 *
 * Either way the endpoint must be https; plaintext is refused below rather than downgraded.
 */
import Constants from 'expo-constants';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SupportConfig {
  /** The Resend `/emails` endpoint, or a relay that accepts the same JSON body. */
  readonly endpoint: string;
  /** Bearer token for the endpoint, or null when the relay authenticates some other way. */
  readonly apiKey: string | null;
  /** Sender, as Resend wants it: `Name <address@your-domain>` or a bare address. */
  readonly from: string;
  /** The support inbox. */
  readonly to: string;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function httpsHost(endpoint: string): string | null {
  // No URL parsing: Hermes has `URL`, but a hand-rolled check keeps this total and dependency-free.
  const match = /^https:\/\/([^/?#\s]+)(?:[/?#]|$)/i.exec(endpoint);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Validates a raw `extra.support` blob.
 *
 * Returns null - support is simply not offered - rather than throwing, because a malformed build
 * config must never stop the vault from opening.
 */
export function parseSupportConfig(raw: unknown): SupportConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const endpoint = text(o.endpoint);
  const from = text(o.from);
  const to = text(o.to);
  const apiKey = text(o.apiKey);
  if (endpoint === null || from === null || to === null) return null;

  const host = httpsHost(endpoint);
  if (host === null) return null;
  // Resend itself always needs the bearer token; offering the form without one would only produce
  // a 401 the user cannot do anything about.
  if (host === 'api.resend.com' && apiKey === null) return null;

  return { endpoint, apiKey, from, to };
}

/** The configuration compiled into this build, or null when it has none. */
export function readSupportConfig(): SupportConfig | null {
  return parseSupportConfig(Constants.expoConfig?.extra?.support);
}
