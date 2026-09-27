import { FORBIDDEN_SUPPORT_HOSTS, parseSupportConfig } from '@/support/supportConfig';

const RELAY = 'https://us-central1-example.cloudfunctions.net/silentsumSupportRelay';

const COMPLETE = {
  endpoint: RELAY,
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

  it('needs all three values; a half-configured build offers no form', () => {
    expect(parseSupportConfig({ ...COMPLETE, endpoint: '' })).toBeNull();
    expect(parseSupportConfig({ ...COMPLETE, from: '' })).toBeNull();
    expect(parseSupportConfig({ ...COMPLETE, to: '   ' })).toBeNull();
  });

  it('refuses a plaintext endpoint rather than sending a support message in the clear', () => {
    expect(parseSupportConfig({ ...COMPLETE, endpoint: 'http://relay.example.com/s' })).toBeNull();
    expect(parseSupportConfig({ ...COMPLETE, endpoint: 'relay.example.com/s' })).toBeNull();
  });

  /**
   * The regression this guards. The app used to post to Resend with a bearer token compiled into
   * `extra`, which is plain text in the APK. There is now no field to put a token in -- and pointing
   * the endpoint back at a provider is refused, so the arrangement cannot return by editing an
   * environment variable.
   */
  it('refuses a mail provider as the endpoint, whatever the casing', () => {
    for (const host of FORBIDDEN_SUPPORT_HOSTS) {
      expect(parseSupportConfig({ ...COMPLETE, endpoint: `https://${host}/emails` })).toBeNull();
      expect(
        parseSupportConfig({ ...COMPLETE, endpoint: `HTTPS://${host.toUpperCase()}/` }),
      ).toBeNull();
    }
  });

  it('carries no credential field at all', () => {
    const parsed = parseSupportConfig({ ...COMPLETE, apiKey: 'test-key' });
    expect(parsed).toEqual(COMPLETE);
    expect(parsed).not.toHaveProperty('apiKey');
  });

  it('names Resend among the hosts it refuses', () => {
    expect(FORBIDDEN_SUPPORT_HOSTS).toContain('api.resend.com');
  });
});
