/**
 * The one Resend call this backend makes, over plain `fetch`.
 *
 * The API key arrives through a Firebase secret (`RESEND_API_KEY`) and is used in exactly one
 * place: the `Authorization` header of a request to `api.resend.com`. It is never logged, never put
 * into an error message, and never returned to a caller -- `ResendApiError` carries the status and
 * Resend's own wording, both of which are safe, and nothing else.
 *
 * Recipients are not this module's business. It sends the `SupportMail` it is given, and what is in
 * that mail was decided by `supportRelay.ts` from server configuration.
 */
import type { SupportMail, SupportMailer } from './supportRelay';

export interface ResendHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type ResendFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<ResendHttpResponse>;

export class ResendApiError extends Error {
  constructor(
    /** HTTP status, or 0 when Resend could not be reached at all. */
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Resend ${String(status)}: ${detail}`);
    this.name = 'ResendApiError';
  }
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 20_000;

export interface ResendMailerOptions {
  readonly endpoint?: string;
  readonly fetchImpl?: ResendFetch;
  readonly timeoutMs?: number;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function field(parsed: unknown, name: string): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Removes anything key-shaped from text on its way into an error.
 *
 * Resend has no reason to echo the key back, and this module never interpolates it into a message
 * itself. But an error travels: into the function log, and from there into whatever reads logs. The
 * one string that must never make that trip is cheap to remove unconditionally.
 */
export function redactKeys(value: string): string {
  return value.replace(/\bre_[A-Za-z0-9_]{8,}/g, 're_***');
}

export class ResendMailer implements SupportMailer {
  private readonly http: ResendFetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: ResendMailerOptions = {},
  ) {
    this.http = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.endpoint = options.endpoint ?? RESEND_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
  }

  async send(mail: SupportMail): Promise<string | null> {
    const payload: Record<string, unknown> = {
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    };
    // Resend's REST field is snake_case; the Node SDK's `replyTo` maps onto this one.
    if (mail.replyTo !== null) payload.reply_to = mail.replyTo;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: ResendHttpResponse;
    try {
      response = await this.http(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      // Unreachable, DNS or TLS failure, or our own timeout. Status 0 says "never got an answer".
      throw new ResendApiError(0, error instanceof Error ? error.name : 'request failed');
    } finally {
      clearTimeout(timer);
    }

    let body = '';
    try {
      body = await response.text();
    } catch {
      // A body that cannot be read is treated as empty; the status still decides.
    }
    const parsed = parseJson(body);

    if (!response.ok) {
      throw new ResendApiError(response.status, redactKeys(field(parsed, 'message') ?? 'rejected'));
    }
    // `{ "id": "..." }` on success. A missing id is not a failure: the mail was accepted.
    return field(parsed, 'id');
  }
}
