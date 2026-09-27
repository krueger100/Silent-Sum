/**
 * `credentials.json` is generated from `keystore.properties` so the two cannot disagree.
 *
 * What matters here is the shape EAS expects and the resolution rule matching the Gradle plugin's,
 * because a mismatch between them is the failure the generator exists to prevent: an EAS build that
 * succeeds with the wrong key and produces an artifact Play refuses.
 *
 * JavaScript because the subject is a CommonJS script; `tsconfig.json` only includes `.ts`/`.tsx`.
 */
const path = require('path');

const { buildCredentials, parseProperties } = require('../scripts/eas-credentials');

const ROOT = '/project';
const KEYSTORE = path.join(ROOT, 'release.jks');

const PROPS = {
  storeFile: 'release.jks',
  storePassword: 'store-secret',
  keyAlias: 'silentsum',
  keyPassword: 'key-secret',
};

/** Only the keystore named by the properties exists. */
const exists = (file) => path.resolve(file) === path.resolve(KEYSTORE);

function build(overrides = {}) {
  return buildCredentials({ props: PROPS, env: {}, root: ROOT, exists, ...overrides });
}

describe('parseProperties', () => {
  it('reads key=value and ignores comments and blanks', () => {
    expect(
      parseProperties(
        '# a comment\n\nstoreFile=release.jks\n  keyAlias = silentsum \n!also=ignored\n',
      ),
    ).toEqual({ storeFile: 'release.jks', keyAlias: 'silentsum' });
  });

  it('keeps a value containing an equals sign intact', () => {
    expect(parseProperties('storePassword=a=b=c')).toEqual({ storePassword: 'a=b=c' });
  });

  it('ignores a line with no key', () => {
    expect(parseProperties('=orphan\nstoreFile=release.jks')).toEqual({ storeFile: 'release.jks' });
  });
});

describe('buildCredentials', () => {
  it('produces exactly the four fields EAS reads, and nothing else', () => {
    const { credentials } = build();

    expect(credentials).toEqual({
      android: {
        keystore: {
          keystorePath: 'release.jks',
          keystorePassword: 'store-secret',
          keyAlias: 'silentsum',
          keyPassword: 'key-secret',
        },
      },
    });
    expect(Object.keys(credentials.android.keystore)).toHaveLength(4);
  });

  it('falls back to the environment, like the Gradle plugin', () => {
    const { credentials } = build({
      props: {},
      env: {
        SILENTSUM_KEYSTORE_FILE: 'release.jks',
        SILENTSUM_KEYSTORE_PASSWORD: 'from-env',
        SILENTSUM_KEY_ALIAS: 'silentsum',
        SILENTSUM_KEY_PASSWORD: 'also-env',
      },
    });
    expect(credentials.android.keystore.keystorePassword).toBe('from-env');
  });

  it('prefers the properties file over the environment', () => {
    const { credentials } = build({ env: { SILENTSUM_KEYSTORE_PASSWORD: 'from-env' } });
    expect(credentials.android.keystore.keystorePassword).toBe('store-secret');
  });

  it('treats an empty or blank value as absent', () => {
    expect(() => build({ props: { ...PROPS, keyAlias: '   ' } })).toThrow(/keyAlias/);
    expect(() => build({ props: { ...PROPS, storePassword: '' } })).toThrow(/storePassword/);
  });

  it('names every missing field at once rather than one per run', () => {
    const error = (() => {
      try {
        build({ props: {} });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).not.toBeNull();
    for (const field of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
      expect(error.message).toContain(field);
    }
    // And says where else each could have come from.
    expect(error.message).toContain('SILENTSUM_KEYSTORE_FILE');
  });

  it('refuses a keystore that is not there, naming the path it looked at', () => {
    expect(() => build({ props: { ...PROPS, storeFile: 'missing.jks' } })).toThrow(
      /keystore not found at .*missing\.jks/,
    );
  });

  it('resolves a relative storeFile from the project root, as the plugin does', () => {
    const { absolutePath } = build();
    expect(path.resolve(absolutePath)).toBe(path.resolve(KEYSTORE));
  });

  it('accepts an absolute storeFile and keeps it absolute when it is outside the project', () => {
    const outside = path.resolve('/elsewhere/release.jks');
    const { credentials, absolutePath } = build({
      props: { ...PROPS, storeFile: outside },
      exists: (f) => path.resolve(f) === outside,
    });

    expect(path.resolve(absolutePath)).toBe(outside);
    // Not rewritten to something relative that would resolve elsewhere from the project root.
    expect(credentials.android.keystore.keystorePath).not.toMatch(/^\.\./);
  });

  it('always emits forward slashes, so the path is valid off Windows too', () => {
    const { credentials } = build({
      props: { ...PROPS, storeFile: path.join('keys', 'release.jks') },
      exists: (f) => path.resolve(f) === path.resolve(path.join(ROOT, 'keys', 'release.jks')),
    });

    expect(credentials.android.keystore.keystorePath).toBe('keys/release.jks');
    expect(credentials.android.keystore.keystorePath).not.toContain('\\');
  });
});
