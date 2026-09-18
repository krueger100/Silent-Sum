import { buildDiagnostics } from '@/support/diagnostics';
import {
  bodyFor,
  buildSupportEmail,
  isPlausibleEmail,
  subjectFor,
  SUPPORT_BODY_MAX,
} from '@/support/supportMessage';
import type { SupportMessage } from '@/support/types';

const MESSAGE: SupportMessage = {
  topic: 'unlock',
  body: 'The calculator will not open the vault.',
  replyTo: 'user@example.com',
  diagnostics: null,
};

describe('subjectFor', () => {
  it('names the disguise, not the product: the reply lands in the user own inbox', () => {
    expect(subjectFor(MESSAGE)).toBe('Calculator support: Unlocking and PIN');
    expect(subjectFor({ ...MESSAGE, topic: 'bug' })).toBe('Calculator support: Something is broken');
    expect(subjectFor(MESSAGE)).not.toMatch(/SilentSum|vault|photo/i);
  });
});

describe('bodyFor', () => {
  it('removes anything PIN-shaped before the message can reach a support inbox', () => {
    const text = bodyFor({ ...MESSAGE, body: 'My code 12142907 stopped working after 1214.' });
    expect(text).not.toContain('12142907');
    expect(text).not.toContain('1214');
    expect(text).toContain('My code [redacted] stopped working after [redacted].');
  });

  it('keeps numbers that could not be a PIN, so version and error numbers survive', () => {
    expect(bodyFor({ ...MESSAGE, body: 'Crash 500 on build 123456789.' })).toContain(
      'Crash 500 on build 123456789.',
    );
  });

  it('removes file paths that would prove where a vault lives', () => {
    expect(bodyFor({ ...MESSAGE, body: 'broke at /data/user/0/app/vault/index' })).toContain(
      'broke at [path]',
    );
  });

  it('records the reply address, or says plainly that there is none', () => {
    expect(bodyFor(MESSAGE)).toContain('Reply to: user@example.com');
    expect(bodyFor({ ...MESSAGE, replyTo: null })).toContain('did not leave a reply address');
  });

  it('appends the diagnostics block only when the user left it attached', () => {
    const diagnostics = buildDiagnostics({
      appVersion: '0.1.0',
      platform: 'android',
      osVersion: '34',
      cloudConfigured: false,
      backupEnabled: false,
    });
    expect(bodyFor({ ...MESSAGE, diagnostics })).toContain('App version: 0.1.0');
    expect(bodyFor(MESSAGE)).not.toContain('App version');
  });

  it('caps the length so one message cannot be an upload channel', () => {
    const text = bodyFor({ ...MESSAGE, body: 'a'.repeat(SUPPORT_BODY_MAX + 500) });
    expect(text).toContain('a'.repeat(SUPPORT_BODY_MAX));
    expect(text).not.toContain('a'.repeat(SUPPORT_BODY_MAX + 1));
  });
});

describe('buildSupportEmail', () => {
  it('is the subject and the scrubbed body together', () => {
    const email = buildSupportEmail({ ...MESSAGE, body: 'code 4321' });
    expect(email).toEqual({
      subject: 'Calculator support: Unlocking and PIN',
      text: bodyFor({ ...MESSAGE, body: 'code 4321' }),
    });
    expect(email.text).not.toContain('4321');
  });
});

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const value of ['a@b.co', 'first.last+tag@sub.example.com', '  user@example.com  ']) {
      expect(isPlausibleEmail(value)).toBe(true);
    }
  });

  it('rejects what could not be delivered to', () => {
    for (const value of ['', '   ', 'user', 'user@', '@example.com', 'user@example', 'a b@c.de']) {
      expect(isPlausibleEmail(value)).toBe(false);
    }
  });
});

describe('buildDiagnostics', () => {
  it('carries the build and the platform, and no identifier of any kind', () => {
    const text = buildDiagnostics({
      appVersion: '0.1.0',
      platform: 'android',
      osVersion: '34',
      cloudConfigured: true,
      backupEnabled: true,
    });
    expect(text).toBe(
      ['App details', 'App version: 0.1.0', 'System: android 34', 'Cloud backup: on'].join('\n'),
    );
  });

  it('says when this build has no cloud configuration at all', () => {
    expect(
      buildDiagnostics({
        appVersion: '0.1.0',
        platform: 'ios',
        osVersion: '17.0',
        cloudConfigured: false,
        backupEnabled: true,
      }),
    ).toContain('Cloud backup: not available in this build');
  });
});
