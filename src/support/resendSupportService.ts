/**
 * The only outbound request this app makes that is not a backup: one POST, when the user presses
 * Send on the support screen.
 *
 * The body is the shape Resend's `POST /emails` expects, so `SUPPORT_ENDPOINT` can be either
 * Resend itself or a relay of your own that forwards the same JSON with the key held server-side
 * (see the note in `supportConfig.ts` about shipping keys in a binary).
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

export interface ResendSupportOptions {
  readonly fetchImpl?: SupportFetch;
  readonly timeoutMs?: number;
}

export class ResendSupportService implements SupportService {
  /** The configured support inbox, shown (never sent to) by the About screen. */
  get contact(): string {
    return this.config.to;
  }

  private readonly http: SupportFetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: SupportConfig,
    options: ResendSupportOptions = {},
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

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey !== null) headers.Authorization = `Bearer ${this.config.apiKey}`;

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
