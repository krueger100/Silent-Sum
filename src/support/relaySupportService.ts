/**
 * The only outbound request this app makes that is not a backup: one POST, when the user presses
 * Send on the support screen.
 *
 * It carries NO credential. The endpoint is the project's own relay
 * (`functions/src/supportRelay.ts`), which holds the mail provider's key and chooses the recipient
 * from its own configuration. The body keeps the provider's field names because the relay forwards
 * them, but `from` and `to` in it are advisory: the server discards them. That is deliberate --
 * a public endpoint that honoured a caller's `to` would be an open mail relay.
 *
 * Nothing here retries on its own and nothing is queued: a failed send stays on screen as text the
 * user still has, and it is their choice whether to try again. A silent background retry would
 * mean this app makes network requests the user did not ask for, which is precisely what it
 * promises not to do.
 */
import { buildSupportEmail, isPlausibleEmail } from '@/support/supportMessage';
import type { SupportConfig } from '@/support/supportConfig';
import type {
  SupportFailure,
  SupportMessage,
  SupportSendResult,
  SupportService,
} from '@/support/types';

/** Structural, so a test can pass a plain function and the real `fetch` still satisfies it. */
export interface SupportHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type SupportFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<SupportHttpResponse>;

export const SUPPORT_TIMEOUT_MS = 20_000;

export interface RelaySupportOptions {
  readonly fetchImpl?: SupportFetch;
  readonly timeoutMs?: number;
}

export class RelaySupportService implements SupportService {
  /** The configured support inbox, shown (never sent to) by the About screen. */
  get contact(): string {
    return this.config.to;
  }

  private readonly http: SupportFetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: SupportConfig,
    options: RelaySupportOptions = {},
  ) {
    this.http = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? SUPPORT_TIMEOUT_MS;
  }

  async send(message: SupportMessage): Promise<SupportSendResult> {
    const email = buildSupportEmail(message);
    const payload: Record<string, unknown> = {
      from: this.config.from,
      to: [this.config.to],
      subject: email.subject,
      text: email.text,
    };
    // Resend's REST field is snake_case; the Node SDK's `replyTo` maps onto this.
    if (message.replyTo !== null && isPlausibleEmail(message.replyTo)) {
      payload.reply_to = message.replyTo;
    }

    // No Authorization header: there is no credential in this build to send one with.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: SupportHttpResponse;
    try {
      response = await this.http(this.config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      // No connection, DNS failure, TLS failure, or our own timeout. All the same to the user.
      return { kind: 'failed', reason: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return { kind: 'failed', reason: failureFor(response.status) };
    return { kind: 'sent', reference: await referenceOf(response) };
  }
}

function failureFor(status: number): SupportFailure {
  if (status === 401 || status === 403) return 'configuration';
  // Statements about the ADDRESS rather than about the message: nothing is deployed there, or
  // what is deployed is not this relay. Folded into `rejected` once, which sent users off to
  // shorten a message nothing had read.
  if (status === 404 || status === 405) return 'missing';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'rejected';
  return 'unknown';
}

/** Resend answers `{ "id": "..." }`. A missing or unparsable body is not a failure: it was sent. */
async function referenceOf(response: SupportHttpResponse): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id = (parsed as Record<string, unknown>).id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}
