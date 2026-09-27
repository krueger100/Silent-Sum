/**
 * Signs release builds with a real keystore, and refuses to build one without it.
 *
 * Expo's template leaves `buildTypes.release { signingConfig signingConfigs.debug }` behind a
 * comment telling you to fix it. Play rejects a debug-signed upload, so that default is a dead
 * end -- but it is a SILENT one: `assembleRelease` succeeds and hands you an artifact that only
 * fails hours later, at upload. Worse, `debug.keystore` is the same key in every React Native
 * checkout, so anything it signs can be replaced by anyone.
 *
 * So this plugin does two things: it adds a real `signingConfigs.release`, and it makes any
 * release-assembling task FAIL when no credentials are present. There is deliberately no fallback.
 * A build either has the release key or stops.
 *
 * Credentials are read at BUILD time and never stored here. Either
 *
 *   - `keystore.properties` in the PROJECT ROOT (git-ignored), with `storeFile`, `storePassword`,
 *     `keyAlias` and `keyPassword`, or
 *   - the environment: `SILENTSUM_KEYSTORE_FILE`, `SILENTSUM_KEYSTORE_PASSWORD`,
 *     `SILENTSUM_KEY_ALIAS`, `SILENTSUM_KEY_PASSWORD`, for CI that holds them as secrets.
 *
 * The properties file sits in the project root rather than `android/` because `expo prebuild`
 * deletes `android/` wholesale -- it would take the credentials with it, and on this machine the
 * D: build junctions too (docs/building.md).
 *
 * Nothing secret is in this file: no path, no alias, no password. It only says where to look.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

/** Presence of this marker means the patch is already applied; the plugin is then a no-op. */
const MARKER = 'SILENTSUM_RELEASE_SIGNING';

/**
 * Resolution of the credentials, as Groovy. Written as an array of lines rather than a template
 * literal so Groovy's `${...}` interpolation cannot collide with JavaScript's.
 */
const RESOLVE = [
  '// --- ' + MARKER + ' -------------------------------------------------------------',
  '// Resolved once, at configuration time. Null means this checkout has no release key, which is',
  '// the normal state for a debug-only working copy; the guard below stops release builds then.',
  '//',
  '// EAS Build is the exception. It brings its own signing: it writes android/app/eas-build.gradle',
  '// with a `signingConfigs.release` of its own and applies it from build.gradle. `android/` is',
  '// git-ignored here, so EAS regenerates it with prebuild and this block runs there too -- where',
  '// there is no keystore.properties and no SILENTSUM_KEYSTORE_* to find. Without standing down, the',
  '// guard below would fail every EAS build for want of credentials EAS already has.',
  "def silentsumOnEas = System.getenv('EAS_BUILD') == 'true'",
  'def silentsumProjectRoot = rootProject.projectDir.parentFile',
  'def silentsumResolveSigning = {',
  '    def props = new Properties()',
  "    def propsFile = new File(silentsumProjectRoot, 'keystore.properties')",
  '    if (propsFile.exists()) {',
  '        propsFile.withInputStream { props.load(it) }',
  '    }',
  '    def pick = { String key, String envKey ->',
  '        def fromFile = props.getProperty(key)',
  '        if (fromFile != null && !fromFile.trim().isEmpty()) return fromFile.trim()',
  '        def fromEnv = System.getenv(envKey)',
  '        return (fromEnv != null && !fromEnv.trim().isEmpty()) ? fromEnv.trim() : null',
  '    }',
  "    def storeName = pick('storeFile', 'SILENTSUM_KEYSTORE_FILE')",
  "    def storePassword = pick('storePassword', 'SILENTSUM_KEYSTORE_PASSWORD')",
  "    def keyAlias = pick('keyAlias', 'SILENTSUM_KEY_ALIAS')",
  "    def keyPassword = pick('keyPassword', 'SILENTSUM_KEY_PASSWORD')",
  '    if (storeName == null || storePassword == null || keyAlias == null || keyPassword == null) {',
  '        return null',
  '    }',
  '    def resolved = new File(storeName)',
  '    if (!resolved.isAbsolute()) resolved = new File(silentsumProjectRoot, storeName)',
  '    if (!resolved.exists()) {',
  '        // A wrong path must not degrade into "no credentials" and then into a stopped build with',
  '        // a misleading reason. Say exactly which file is missing.',
  '        throw new GradleException(',
  '            "Release keystore not found at " + resolved.absolutePath +',
  '            " (keystore.properties storeFile, or SILENTSUM_KEYSTORE_FILE)")',
  '    }',
  '    return [store: resolved, storePassword: storePassword, alias: keyAlias, keyPassword: keyPassword]',
  '}',
  'def silentsumSigning = silentsumResolveSigning()',
  '',
  '// A release build with no key must stop, not quietly emit an unsigned or debug-signed artifact.',
  '// Checked against the task graph so debug builds, `:app:dependencies` and IDE syncs are',
  '// unaffected: only a task that actually assembles a release trips it. Skipped on EAS, which',
  '// signs the release itself -- see the note above.',
  'if (silentsumSigning == null && !silentsumOnEas) {',
  '    gradle.taskGraph.whenReady { graph ->',
  '        def releasing = graph.allTasks.any { t ->',
  "            (t.name.startsWith('assemble') || t.name.startsWith('bundle')) && t.name.endsWith('Release')",
  '        }',
  '        if (releasing) {',
  '            throw new GradleException(',
  '                "No Android release signing credentials.\\n" +',
  '                "  Put keystore.properties in the project root (git-ignored) with storeFile,\\n" +',
  '                "  storePassword, keyAlias and keyPassword, or set SILENTSUM_KEYSTORE_FILE,\\n" +',
  '                "  SILENTSUM_KEYSTORE_PASSWORD, SILENTSUM_KEY_ALIAS and SILENTSUM_KEY_PASSWORD.\\n" +',
  '                "  See docs/building.md. The debug keystore must never sign a release: Play\\n" +',
  '                "  rejects it, and it is the same key in every React Native checkout.")',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

/** The release signing config, added beside the template's `debug` one. */
const SIGNING_CONFIG = [
  '        release {',
  '            // Populated only when credentials were found. An empty config is valid to declare;',
  '            // it is never USED, because the release build type takes null instead and the guard',
  '            // above has already stopped the build by then.',
  '            if (silentsumSigning != null) {',
  '                storeFile silentsumSigning.store',
  '                storePassword silentsumSigning.storePassword',
  '                keyAlias silentsumSigning.alias',
  '                keyPassword silentsumSigning.keyPassword',
  '            }',
  '        }',
].join('\n');

/**
 * Replaces the template's line. Indented to sit where that line already sits.
 *
 * On EAS nothing is assigned at all: `eas-build.gradle` sets the release signing config itself, and
 * writing `null` here would depend on which of the two files Gradle applies last.
 */
const RELEASE_SIGNING = [
  '// Signed with the release key, or not at all: see plugins/withReleaseSigning.js.',
  '            if (!silentsumOnEas) {',
  '                signingConfig silentsumSigning != null ? signingConfigs.release : null',
  '            }',
].join('\n');

/** What the Expo template puts in both build types. The LAST one is the release block's. */
const TEMPLATE_LINE = 'signingConfig signingConfigs.debug';

/**
 * The template's advice, directly above that line in the release block. Removed with it: left
 * behind it would be telling a reader to do the thing this plugin has just done.
 */
const TEMPLATE_ADVICE = [
  '// Caution! In production, you need to generate your own keystore file.',
  '            // see https://reactnative.dev/docs/signed-apk-android.',
  '            ',
].join('\n');

const SIGNING_CONFIGS_ANCHOR = 'signingConfigs {\n';
const ANDROID_ANCHOR = '\nandroid {\n';

function patch(contents) {
  if (contents.includes(MARKER)) return contents;

  // Fail loudly rather than leave debug signing in place. If Expo's template moves, this plugin has
  // to be re-read against it; silently doing nothing would be the very bug it exists to prevent.
  const occurrences = contents.split(TEMPLATE_LINE).length - 1;
  if (occurrences !== 2) {
    throw new Error(
      `withReleaseSigning: expected 2 \`${TEMPLATE_LINE}\` lines in android/app/build.gradle, ` +
        `found ${String(occurrences)}. The Expo template has changed; re-check the release ` +
        'signingConfig by hand before building.',
    );
  }
  if (!contents.includes(SIGNING_CONFIGS_ANCHOR) || !contents.includes(ANDROID_ANCHOR)) {
    throw new Error(
      'withReleaseSigning: android/app/build.gradle has no `signingConfigs {` or top-level ' +
        '`android {` block to patch. The Expo template has changed.',
    );
  }

  // The release build type comes after the debug one, so the LAST occurrence is the one to replace.
  // Done first, while there is still exactly one `release {` in the file.
  const at = contents.lastIndexOf(TEMPLATE_LINE);
  const head = contents.slice(0, at);
  const tail = contents.slice(at + TEMPLATE_LINE.length);
  const trimmedHead = head.endsWith(TEMPLATE_ADVICE)
    ? head.slice(0, head.length - TEMPLATE_ADVICE.length)
    : head;

  let next = trimmedHead + RELEASE_SIGNING + tail;
  next = next.replace(SIGNING_CONFIGS_ANCHOR, SIGNING_CONFIGS_ANCHOR + SIGNING_CONFIG + '\n');
  next = next.replace(ANDROID_ANCHOR, '\n' + RESOLVE + ANDROID_ANCHOR.slice(1));
  return next;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error(
        `withReleaseSigning: expected a Groovy build.gradle, got ${mod.modResults.language}.`,
      );
    }
    mod.modResults.contents = patch(mod.modResults.contents);
    return mod;
  });
};

// Exported for the test, which runs the patch against a copy of the template.
module.exports.patch = patch;
