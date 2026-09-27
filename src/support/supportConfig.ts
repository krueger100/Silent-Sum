/**
 * Where support messages go, read from the build's Expo config (`extra.support`).
 *
 * The values come from environment variables at build time (see `.env.example`), never from the
 * user and never from anything on the device. A build with no support configuration is normal and
 * fully supported: `readSupportConfig` returns null and the screen says so plainly instead of
 * offering a form that could not deliver anything.
 *
 * NO CREDENTIAL IS CARRIED HERE, AND THERE IS NOWHERE TO PUT ONE
 * --------------------------------------------------------------
 * This configuration used to include a bearer token, because the app posted straight to Resend's
 * `/emails`. Everything in `extra` is plain text in the APK, so that key was published with every
 * build: whoever unzipped one could send mail as the verified domain until it was rotated.
 *
 * The endpoint is now the project's own relay (`functions/src/supportRelay.ts`), which holds the
 * provider's key and decides the recipient itself. The app authenticates with nothing, so there is
 * no token to leak -- and a mail provider is refused as an endpoint below, so the old arrangement
 * cannot come back by editing an environment variable.
 *
 * The endpoint must be https; plaintext is refused rather than downgraded.
 */
import Constants from 'expo-constants';

/**
 * Mail-provider hosts that must never be the endpoint. Reaching one directly would need a bearer
 * token, and the only place this app could keep a token is the bundle, where it is published.
 */
export const FORBIDDEN_SUPPORT_HOSTS: readonly string[] = [
  'api.resend.com',
  'api.sendgrid.com',
  'api.mailgun.net',
  'api.postmarkapp.com',
  'api.mailjet.com',
  'api.brevo.com',
  'email.us-east-1.amazonaws.com',
];

export interface SupportConfig {
  /** The relay that accepts the message and decides where it goes. Never a mail provider. */
  readonly endpoint: string;
  /** Sender, as the provider wants it: `Name <address@your-domain>` or a bare address. */
  readonly from: string;
  /** The support inbox. Shown to the user; the relay, not this, decides where mail is delivered. */
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
  if (endpoint === null || from === null || to === null) return null;

  const host = httpsHost(endpoint);
  if (host === null) return null;
  // A mail provider needs a bearer token, and the only place this app could keep one is the bundle,
  // where it would be published. Refused outright rather than attempted and 401'd, so the mistake
  // cannot be made by setting an environment variable.
  if (FORBIDDEN_SUPPORT_HOSTS.includes(host)) return null;

  return { endpoint, from, to };
}

/** The configuration compiled into this build, or null when it has none. */
export function readSupportConfig(): SupportConfig | null {
  return parseSupportConfig(Constants.expoConfig?.extra?.support);
}
