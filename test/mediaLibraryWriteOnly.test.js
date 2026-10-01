/**
 * Gallery export must never grow into gallery access.
 *
 * The code half of this is small -- one manifest flag -- and the spec for it is correspondingly
 * short. The half worth guarding is the configuration: it is a one-line edit to register
 * `expo-media-library`'s own config plugin, or to "tidy" the blocked list, and either would add
 * `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` to a shipped app that presents itself as a
 * calculator. Nothing about the app would appear to break, so nothing would catch it except this.
 */
const fs = require('fs');
const path = require('path');

const withMediaLibraryWriteOnly = require('../plugins/withMediaLibraryWriteOnly');
const { enableLegacyExternalStorage, LEGACY_STORAGE_FLAG } = withMediaLibraryWriteOnly;

const APP_CONFIG = fs.readFileSync(path.join(__dirname, '..', 'app.config.ts'), 'utf8');

/** A permission or package named in a comment is being explained, not wired up. */
function withoutComments(source) {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/**
 * The literal entries of a two-space-indented array in `app.config.ts`, comments removed. Sliced
 * rather than matched: a hand-built regular expression over source text is how you lose a
 * character and get a spec that passes for the wrong reason.
 */
function arraySource(name) {
  const opener = name + ': [';
  const start = APP_CONFIG.indexOf(opener);
  if (start < 0) throw new Error(name + ' array not found in app.config.ts');
  const from = start + opener.length;
  // The closing bracket is the first one starting a line at that indent; nested entries sit
  // deeper and cannot match.
  const end = APP_CONFIG.indexOf('\n  ]', from);
  if (end < 0) throw new Error(name + ' array is not terminated in app.config.ts');
  return withoutComments(APP_CONFIG.slice(from, end));
}

function manifest() {
  return { manifest: { application: [{ $: { 'android:name': '.MainApplication' } }] } };
}

describe('the gallery-export manifest flag', () => {
  it('opts out of scoped storage so the Android 10 fallback path can write at all', () => {
    const result = enableLegacyExternalStorage(manifest());

    expect(result.manifest.application[0].$[LEGACY_STORAGE_FLAG]).toBe('true');
  });

  it('is idempotent, so re-running prebuild does not accumulate anything', () => {
    const once = enableLegacyExternalStorage(manifest());
    const twice = enableLegacyExternalStorage(once);

    expect(twice.manifest.application[0].$[LEGACY_STORAGE_FLAG]).toBe('true');
    expect(Object.keys(twice.manifest.application[0].$)).toHaveLength(2);
  });

  it('refuses a manifest it does not recognise instead of silently doing nothing', () => {
    expect(() => enableLegacyExternalStorage({ manifest: {} })).toThrow(/no <application> node/);
  });

  it('touches nothing but that one flag -- it is not a permission plugin', () => {
    const result = enableLegacyExternalStorage(manifest());

    expect(result.manifest['uses-permission']).toBeUndefined();
  });
});

describe('the shipped Android permission set', () => {
  const blocked = arraySource('blockedPermissions');

  it.each([
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
    'android.permission.ACCESS_MEDIA_LOCATION',
  ])('keeps %s blocked: the vault writes to the gallery and never reads it', (permission) => {
    expect(blocked).toContain(permission);
  });

  it('allows WRITE_EXTERNAL_STORAGE, the single permission the export actually needs', () => {
    expect(blocked).not.toContain('android.permission.WRITE_EXTERNAL_STORAGE');
  });

  it('does not register expo-media-library’s own plugin, which would add the read set', () => {
    expect(arraySource('plugins')).not.toContain('expo-media-library');
  });

  it('registers the write-only plugin instead', () => {
    expect(arraySource('plugins')).toContain("'./plugins/withMediaLibraryWriteOnly'");
  });
});
