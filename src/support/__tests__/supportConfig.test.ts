import { parseSupportConfig, RESEND_ENDPOINT } from '@/support/supportConfig';

const COMPLETE = {
  endpoint: RESEND_ENDPOINT,
  apiKey: 'test-key',
  from: 'Calculator <support@example.com>',
  to: 'support@example.com',
};

describe('parseSupportConfig', () => {
  it('accepts a complete configuration and trims it', () => {
    expect(parseSupportConfig({ ...COMPLETE, to: '  support@example.com  ' })).toEqual(COMPLETE);
  });

  it('treats a build with no support block as simply not offering support', () => {
    for (const raw of [undefined, null, {}, [], 'nope', { from: 'a@b.c' }]) {
      expect(parseSupportConfig(raw)).toBeNull();
    }
  });

  it('refuses a plaintext endpoint rather than sending a support message in the clear', () => {
    expect(parseSupportConfig({ ...COMPLETE, endpoint: 'http://api.resend.com/emails' })).toBeNull();
    expect(parseSupportConfig({ ...COMPLETE, endpoint: 'api.resend.com/emails' })).toBeNull();
  });

  it('refuses Resend itself without a key, because the form could only ever 401', () => {
    expect(parseSupportConfig({ ...COMPLETE, apiKey: '' })).toBeNull();
    expect(parseSupportConfig({ ...COMPLETE, endpoint: 'HTTPS://API.RESEND.COM/emails', apiKey: undefined })).toBeNull();
  });

  it('allows a relay with no key: the relay holds the credentials, not the app', () => {
    const relay = { ...COMPLETE, endpoint: 'https://relay.example.com/support', apiKey: '' };
    expect(parseSupportConfig(relay)).toEqual({ ...relay, apiKey: null });
  });
});
