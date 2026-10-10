/**
 * Firebase callable functions over plain `fetch`.
 *
 * The callable protocol is small and documented: `POST <base>/<name>` with `{"data": ...}`,
 * the user's ID token as a bearer, the App Check token in `X-Firebase-AppCheck`, and either
 * `{"result": ...}` back or `{"error": {"status": "FAILED_PRECONDITION", "message", "details"}}`.
 * Speaking it directly costs a hundred lines and saves a native module: the alternative,
 * `@react-native-firebase/functions`, would need a prebuild and could only be proved on a device.
 * This module can be proved here, against a fake fetch.
 *
 * It lives in `src/firebase` because that is one of the two modules allowed to reach the network
 * (`scripts/security-scan.js`). Billing code never calls it directly; it goes through
 * `BillingService`, which is what the screens and tests see.
 */
export interface CallableTokens {
  /** The signed-in user's Firebase ID token, or null when nobody is signed in. */
  idToken(): Promise<string | null>;
  /** The App Check token, or null when this build could not obtain one. */
  appCheckToken(): Promise<string | null>;
}

/** Structural, so a test can pass a plain function and the real `fetch` still satisfies it. */
export interface CallableHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type CallableFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<CallableHttpResponse>;

/** What a caller needs from this module: one method, so a test can hand in a stub. */
export interface CallableInvoker {
  call<T>(name: string, data: unknown): Promise<T>;
}

/**
 * A callable failure, with the canonical lower-case code Firebase uses on every platform:
 * `unauthenticated`, `failed-precondition`, `invalid-argument`, `unavailable`, and so on.
 */
export class CallableError extends Error {
  /**
   * Whether an App Check token went out with the request that failed.
   *
   * The server cannot tell a caller which half of its refusal applies: a callable answers
   * `UNAUTHENTICATED` whether the ID token or the App Check token was the problem, because it
   * saw neither. Only this side knows which it actually sent, so recording it turns a guess
   * into a fact -- and the remedy for the two is completely different.
   */
  appCheckSent = false;

  constructor(
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? `CallableError(${code})`);
    this.name = 'CallableError';
  }
}

const CALLABLE_DEV = (globalThis as { __DEV__?: boolean }).__DEV__ === true;

/**
 * Development-only breadcrumb. A callable refusal otherwise reaches the screen as one word,
 * and the difference between "App Check refused this build", "that function is not deployed"
 * and "the network dropped" is invisible from the message alone -- which is exactly the hole
 * that made one misconfiguration look like another for a whole afternoon. Never carries user
 * data: a function name, an HTTP status, and whether a token was attached.
 */
function noteCallable(name: string, detail: string): void {
  if (CALLABLE_DEV) console.warn(`[silentsum] callable ${name}: ${detail}`);
}

export const CALLABLE_TIMEOUT_MS = 30_000;

export interface CallableClientOptions {
  /** `https://<region>-<project>.cloudfunctions.net`, with or without a trailing slash. */
  readonly baseUrl: string;
  readonly tokens: CallableTokens;
  readonly fetchImpl?: CallableFetch;
  readonly timeoutMs?: number;
}

/** The HTTP statuses the callable protocol uses for each canonical code, inverted. */
const HTTP_STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'invalid-argument',
  401: 'unauthenticated',
  403: 'permission-denied',
  404: 'not-found',
  409: 'aborted',
  429: 'resource-exhausted',
  499: 'cancelled',
  500: 'internal',
  501: 'unimplemented',
  503: 'unavailable',
  504: 'deadline-exceeded',
};

async function quietly(read: () => Promise<string | null>): Promise<string | null> {
  try {
    return await read();
  } catch {
    // A token that cannot be fetched is sent as nothing; the server decides what that means.
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The `error` member of a callable failure body, if the body is one. */
function readError(
  parsed: unknown,
): { code: string; message: string | undefined; details: unknown } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const { status, message, details } = error as {
    status?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof status !== 'string' || status === '') return null;
  return {
    code: status.toLowerCase().replace(/_/g, '-'),
    message: typeof message === 'string' ? message : undefined,
    details,
  };
}

export class CallableClient implements CallableInvoker {
  readonly baseUrl: string;

  private readonly tokens: CallableTokens;
  private readonly http: CallableFetch;
  private readonly timeoutMs: number;

  constructor(options: CallableClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.tokens = options.tokens;
    this.http = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? CALLABLE_TIMEOUT_MS;
  }

  async call<T>(name: string, data: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const idToken = await quietly(() => this.tokens.idToken());
    if (idToken !== null && idToken !== '') headers.Authorization = `Bearer ${idToken}`;
    const appCheck = await quietly(() => this.tokens.appCheckToken());
    const appCheckSent = appCheck !== null && appCheck !== '';
    if (appCheckSent) headers['X-Firebase-AppCheck'] = appCheck;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: CallableHttpResponse;
    try {
      response = await this.http(`${this.baseUrl}/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data }),
        signal: controller.signal,
      });
    } catch {
      // No connection, DNS or TLS failure, or our own timeout: all "not reachable right now".
      noteCallable(name, 'request failed before any response');
      throw this.tag(new CallableError('unavailable', 'The server could not be reached.'), appCheckSent);
    } finally {
      clearTimeout(timer);
    }

    let text = '';
    try {
      text = await response.text();
    } catch {
      // A body that cannot be read is treated as empty below.
    }
    const parsed = parseJson(text);

    if (!response.ok) {
      const error = readError(parsed);
      if (error !== null) {
        noteCallable(
          name,
          `HTTP ${String(response.status)} ${error.code}` +
            (appCheckSent ? ' (App Check token sent)' : ' (NO App Check token sent)'),
        );
        throw this.tag(
          new CallableError(error.code, error.message, error.details),
          appCheckSent,
        );
      }
      const fallback =
        HTTP_STATUS_CODES[response.status] ?? (response.status >= 500 ? 'internal' : 'unknown');
      // A body that is not the callable protocol at all. A 404 here is the signature of a
      // function that is not deployed, or a base URL pointing somewhere it should not --
      // nothing to do with App Check, and it must not be reported as though it were.
      noteCallable(name, `HTTP ${String(response.status)} -> ${fallback} (body was not a callable error)`);
      throw this.tag(
        new CallableError(fallback, `HTTP ${String(response.status)}`),
        appCheckSent,
      );
    }

    if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
      throw this.tag(
        new CallableError('internal', 'The server answered without a result.'),
        appCheckSent,
      );
    }
    return (parsed as { result: T }).result;
  }

  private tag(error: CallableError, appCheckSent: boolean): CallableError {
    error.appCheckSent = appCheckSent;
    return error;
  }
}
