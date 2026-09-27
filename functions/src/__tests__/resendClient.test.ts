import { ResendApiError, ResendMailer, type ResendFetch } from '../resendClient';
import type { SupportMail } from '../supportRelay';

/**
 * A fake, and deliberately shorter than a real Resend key. `scripts/security-scan.js` fails the
 * build on `re_` followed by 24 or more characters, which is what a real one looks like; this is
 * long enough to exercise `redactKeys` and short enough not to look like the thing it stands in for.
 */
const KEY = 're_notarealkey01';

const MAIL: SupportMail = {
  from: 'Calculator <support@example.com>',
  to: 'inbox@example.com',
  subject: 'Calculator support: Something is broken',
  text: 'It will not open.',
  replyTo: null,
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function rig(answer: { ok: boolean; status: number; body: string } | Error) {
  const calls: Call[] = [];
  const fetchImpl: ResendFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as unknown });
    if (answer instanceof Error) throw answer;
    return { ok: answer.ok, status: answer.status, text: async () => answer.body };
  };
  return { calls, mailer: new ResendMailer(KEY, { fetchImpl }) };
}

const OK = { ok: true, status: 200, body: '{"id":"msg_abc"}' };

describe('ResendMailer', () => {
  it('posts the mail to Resend and returns its reference', async () => {
    const { calls, mailer } = rig(OK);

    await expect(mailer.send(MAIL)).resolves.toBe('msg_abc');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.body).toEqual({
      from: MAIL.from,
      to: [MAIL.to],
      subject: MAIL.subject,
      text: MAIL.text,
    });
  });

  it('authenticates with the secret and sends it nowhere else', async () => {
    const { calls, mailer } = rig(OK);
    await mailer.send(MAIL);

    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(calls[0]?.body)).not.toContain(KEY);
  });

  it('adds reply_to only when there is one', async () => {
    const without = rig(OK);
    await without.mailer.send(MAIL);
    expect(without.calls[0]?.body).not.toHaveProperty('reply_to');

    const with_ = rig(OK);
    await with_.mailer.send({ ...MAIL, replyTo: 'user@example.com' });
    expect(with_.calls[0]?.body).toMatchObject({ reply_to: 'user@example.com' });
  });

  it('treats an accepted message with no id as sent', async () => {
    const { mailer } = rig({ ok: true, status: 200, body: '{}' });
    await expect(mailer.send(MAIL)).resolves.toBeNull();

    const unparsable = rig({ ok: true, status: 200, body: 'not json' });
    await expect(unparsable.mailer.send(MAIL)).resolves.toBeNull();
  });

  it('throws with the status and Resend’s wording when it refuses', async () => {
    const { mailer } = rig({
      ok: false,
      status: 422,
      body: '{"message":"The from address is not verified"}',
    });

    await expect(mailer.send(MAIL)).rejects.toThrow(ResendApiError);
    await expect(mailer.send(MAIL)).rejects.toThrow(/422.*not verified/);
  });

  it('reports being unable to reach Resend as status 0', async () => {
    const { mailer } = rig(new Error('getaddrinfo ENOTFOUND'));

    const error: unknown = await mailer.send(MAIL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResendApiError);
    expect((error as ResendApiError).status).toBe(0);
  });

  /**
   * The key is the only thing here worth stealing, and an error travels: to the function log, and
   * from there to whatever reads logs. No failure path may carry it outwards.
   */
  it('never puts the secret in an error', async () => {
    const answers = [
      // Resend has no reason to echo the key, but the redaction is what makes that not matter.
      { ok: false, status: 401, body: `{"message":"invalid key ${KEY}"}` },
      { ok: false, status: 500, body: 'oops' },
      { ok: false, status: 422, body: `{"message":"${KEY} is not a domain"}` },
    ];
    for (const answer of answers) {
      const { mailer } = rig(answer);
      const error: unknown = await mailer.send(MAIL).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResendApiError);
      expect((error as ResendApiError).message).not.toContain(KEY);
      expect((error as ResendApiError).detail).not.toContain(KEY);
    }

    // A transport error's own text is never used: only its name, which cannot have been
    // interpolated with anything.
    const network = rig(new Error(`connect failed using ${KEY}`));
    const error: unknown = await network.mailer.send(MAIL).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(KEY);
  });
});
