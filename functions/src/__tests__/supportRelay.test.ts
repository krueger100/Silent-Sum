import {
  SUPPORT_RELAY_MAX_PER_WINDOW,
  SUPPORT_RELAY_MAX_SUBJECT,
  SUPPORT_RELAY_MAX_TEXT,
  SUPPORT_RELAY_MAX_TOTAL_PER_WINDOW,
  SUPPORT_RELAY_TOTAL_KEY,
  SUPPORT_RELAY_WINDOW_MS,
  relaySupport,
  windowFor,
  type SupportMail,
  type SupportMailer,
  type SupportRelayCounters,
  type SupportRelayRequest,
} from '../supportRelay';

class FakeMailer implements SupportMailer {
  readonly sent: SupportMail[] = [];
  failWith: Error | null = null;
  id: string | null = 'msg_1';

  async send(mail: SupportMail): Promise<string | null> {
    if (this.failWith !== null) throw this.failWith;
    this.sent.push(mail);
    return this.id;
  }
}

/** A counter per key, exactly as Firestore's fixed-window documents behave. */
class FakeCounters implements SupportRelayCounters {
  readonly bumps: { key: string; window: number }[] = [];
  private readonly counts = new Map<string, number>();

  /** Pretends `key` is already at `count`, as if earlier requests had used the window. */
  preload(key: string, window: number, count: number): void {
    this.counts.set(`${key}_${String(window)}`, count);
  }

  get keys(): string[] {
    return this.bumps.map((b) => b.key);
  }

  async bump(key: string, window: number): Promise<number> {
    this.bumps.push({ key, window });
    const id = `${key}_${String(window)}`;
    const next = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, next);
    return next;
  }
}

const CONFIG = { from: 'Calculator <support@example.com>', to: 'inbox@example.com' } as const;

const NOW = 1_700_000_000_000;
const WINDOW = windowFor(NOW);

function rig(overrides: Partial<SupportRelayRequest> = {}) {
  const mailer = new FakeMailer();
  const counters = new FakeCounters();
  const failures: unknown[] = [];
  const request: SupportRelayRequest = {
    method: 'POST',
    contentType: 'application/json',
    body: { subject: 'Calculator support: Something is broken', text: 'It will not open.' },
    clientId: '203.0.113.7',
    ...overrides,
  };
  return {
    mailer,
    counters,
    failures,
    run: () =>
      relaySupport(
        {
          mailer,
          counters,
          config: CONFIG,
          now: () => NOW,
          onFailure: (error) => failures.push(error),
        },
        request,
      ),
  };
}

describe('relaySupport', () => {
  it('sends the message to the address the SERVER is configured with', async () => {
    const { mailer, run } = rig();
    const result = await run();

    expect(result.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      from: CONFIG.from,
      to: CONFIG.to,
      subject: 'Calculator support: Something is broken',
      text: 'It will not open.',
      replyTo: null,
    });
  });

  it('answers with the provider reference the app shows the user', async () => {
    const { run } = rig();
    await expect(run()).resolves.toEqual({ status: 200, body: { id: 'msg_1' } });
  });

  /**
   * The point of the whole relay. A caller that names its own recipient must not get one: this is
   * a public endpoint, and honouring `to` would make it an open mail relay for whatever domain the
   * Resend key is verified for.
   */
  it('ignores a sender and recipient supplied by the caller', async () => {
    const { mailer, run } = rig({
      body: {
        subject: 'Invoice attached',
        text: 'Please pay.',
        from: 'billing@bank.example',
        to: ['victim@example.com'],
        reply_to: 'attacker@example.com',
        bcc: 'list@example.com',
      },
    });
    const result = await run();

    expect(result.status).toBe(200);
    expect(mailer.sent[0]?.from).toBe(CONFIG.from);
    expect(mailer.sent[0]?.to).toBe(CONFIG.to);
    // `reply_to` is the one caller-supplied address that is honoured: it only decides where a
    // human reply goes, and the app offers it to the user on purpose.
    expect(mailer.sent[0]?.replyTo).toBe('attacker@example.com');
    expect(mailer.sent[0]).not.toHaveProperty('bcc');
  });

  it('keeps a plausible reply address and drops an implausible one', async () => {
    const good = rig({ body: { subject: 's', text: 't', reply_to: ' user@example.com ' } });
    await good.run();
    expect(good.mailer.sent[0]?.replyTo).toBe('user@example.com');

    const bad = rig({ body: { subject: 's', text: 't', reply_to: 'not an address' } });
    const result = await bad.run();
    // Not a refusal: the message is still worth delivering without a reply address.
    expect(result.status).toBe(200);
    expect(bad.mailer.sent[0]?.replyTo).toBeNull();
  });

  it('refuses anything but a JSON POST', async () => {
    await expect(rig({ method: 'GET' }).run()).resolves.toMatchObject({ status: 405 });
    await expect(rig({ method: 'PUT' }).run()).resolves.toMatchObject({ status: 405 });
    await expect(rig({ contentType: 'text/plain' }).run()).resolves.toMatchObject({ status: 415 });
  });

  it('refuses a body with nothing to send', async () => {
    await expect(rig({ body: {} }).run()).resolves.toMatchObject({ status: 400 });
    await expect(rig({ body: 'hello' }).run()).resolves.toMatchObject({ status: 400 });
    await expect(rig({ body: { subject: 's' } }).run()).resolves.toMatchObject({ status: 400 });
    await expect(rig({ body: { text: 't' } }).run()).resolves.toMatchObject({ status: 400 });
    await expect(rig({ body: { subject: '   ', text: '   ' } }).run()).resolves.toMatchObject({
      status: 400,
    });
  });

  it('refuses an oversized subject or body rather than truncating it', async () => {
    const longSubject = rig({
      body: { subject: 'x'.repeat(SUPPORT_RELAY_MAX_SUBJECT + 1), text: 't' },
    });
    await expect(longSubject.run()).resolves.toMatchObject({ status: 400 });
    expect(longSubject.mailer.sent).toHaveLength(0);

    const longText = rig({ body: { subject: 's', text: 'x'.repeat(SUPPORT_RELAY_MAX_TEXT + 1) } });
    await expect(longText.run()).resolves.toMatchObject({ status: 400 });
    expect(longText.mailer.sent).toHaveLength(0);
  });

  it('accepts a body exactly at the limit', async () => {
    const atLimit = rig({
      body: {
        subject: 'x'.repeat(SUPPORT_RELAY_MAX_SUBJECT),
        text: 'x'.repeat(SUPPORT_RELAY_MAX_TEXT),
      },
    });
    await expect(atLimit.run()).resolves.toMatchObject({ status: 200 });
  });

  it('lets a caller send up to the per-caller limit, then refuses', async () => {
    const { mailer, counters, run } = rig();
    for (let i = 0; i < SUPPORT_RELAY_MAX_PER_WINDOW; i += 1) {
      await expect(run()).resolves.toMatchObject({ status: 200 });
    }
    expect(mailer.sent).toHaveLength(SUPPORT_RELAY_MAX_PER_WINDOW);

    await expect(run()).resolves.toMatchObject({ status: 429 });
    // Nothing further was sent, and the refused attempt was still counted.
    expect(mailer.sent).toHaveLength(SUPPORT_RELAY_MAX_PER_WINDOW);
    expect(counters.bumps.filter((b) => b.key !== SUPPORT_RELAY_TOTAL_KEY)).toHaveLength(
      SUPPORT_RELAY_MAX_PER_WINDOW + 1,
    );
  });

  /**
   * The bound that actually holds. `X-Forwarded-For` is caller-supplied, so a script that varies it
   * gets a fresh per-caller bucket every time; the total is what stops it.
   */
  it('refuses a fresh caller once the total for the window is spent', async () => {
    const { mailer, counters, run } = rig({ clientId: 'someone-new' });
    counters.preload(SUPPORT_RELAY_TOTAL_KEY, WINDOW, SUPPORT_RELAY_MAX_TOTAL_PER_WINDOW);

    await expect(run()).resolves.toMatchObject({ status: 429 });
    expect(mailer.sent).toHaveLength(0);
  });

  it('counts every request against the same total, whatever address it claims', async () => {
    const a = rig({ clientId: '203.0.113.7' });
    const b = rig({ clientId: '198.51.100.9' });
    await a.run();
    await b.run();

    expect(a.counters.keys).toContain(SUPPORT_RELAY_TOTAL_KEY);
    expect(b.counters.keys).toContain(SUPPORT_RELAY_TOTAL_KEY);
  });

  it('starts everyone fresh in a new window', async () => {
    const { counters, run } = rig();
    counters.preload(SUPPORT_RELAY_TOTAL_KEY, WINDOW - 1, SUPPORT_RELAY_MAX_TOTAL_PER_WINDOW);
    await expect(run()).resolves.toMatchObject({ status: 200 });
    expect(counters.bumps.every((b) => b.window === WINDOW)).toBe(true);
  });

  it('never hands the caller address to the counters in the clear', async () => {
    const { counters, run } = rig({ clientId: '203.0.113.7' });
    await run();

    const mine = counters.keys.filter((k) => k !== SUPPORT_RELAY_TOTAL_KEY);
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toContain('203.0.113.7');
    // A key at all, and the same one for the same caller.
    expect(mine[0]).toMatch(/^[0-9a-f]{32}$/);
    const again = rig({ clientId: '203.0.113.7' });
    await again.run();
    expect(again.counters.keys[0]).toBe(mine[0]);
  });

  it('gives different callers different keys', async () => {
    const a = rig({ clientId: '203.0.113.7' });
    const b = rig({ clientId: '198.51.100.9' });
    await a.run();
    await b.run();
    expect(a.counters.keys[0]).not.toBe(b.counters.keys[0]);
  });

  it('counts callers with no address at all as one bucket', async () => {
    const { counters, run } = rig({ clientId: '' });
    await expect(run()).resolves.toMatchObject({ status: 200 });
    expect(counters.keys[0]).toMatch(/^[0-9a-f]{32}$/);
    const other = rig({ clientId: '' });
    await other.run();
    expect(other.counters.keys[0]).toBe(counters.keys[0]);
  });

  it('does not count a request it never understood', async () => {
    const bad = rig({ method: 'GET' });
    await bad.run();
    expect(bad.counters.bumps).toHaveLength(0);

    const empty = rig({ body: {} });
    await empty.run();
    expect(empty.counters.bumps).toHaveLength(0);
  });

  it('reports a provider failure as a server problem, not a bad request', async () => {
    const { mailer, failures, run } = rig();
    mailer.failWith = new Error('resend said no');

    const result = await run();
    expect(result.status).toBe(502);
    // The provider's own wording stays server-side -- but is not lost.
    expect(JSON.stringify(result.body)).not.toContain('resend said no');
    expect(failures).toEqual([mailer.failWith]);
  });

  it('is fine with a provider that returns no reference', async () => {
    const { mailer, run } = rig();
    mailer.id = null;
    await expect(run()).resolves.toEqual({ status: 200, body: { id: null } });
  });

  it('has limits worth having', () => {
    expect(SUPPORT_RELAY_MAX_PER_WINDOW).toBeGreaterThan(0);
    expect(SUPPORT_RELAY_MAX_PER_WINDOW).toBeLessThanOrEqual(20);
    expect(SUPPORT_RELAY_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
    // The total has to be the wider of the two, or the per-caller limit would never be reached.
    expect(SUPPORT_RELAY_MAX_TOTAL_PER_WINDOW).toBeGreaterThan(SUPPORT_RELAY_MAX_PER_WINDOW);
  });
});
