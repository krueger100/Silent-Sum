/**
 * Refuses to build a release App Bundle unless `SILENTSUM_ENV=prod`.
 *
 * An `.aab` exists for exactly one purpose: uploading to Google Play. A Play build must use the
 * Play Integrity App Check provider, and which provider it uses is decided entirely by
 * `SILENTSUM_ENV`: `app.config.ts` defaults it to `dev`, and `firebaseGateway.ts` reads that to
 * pick `'debug'` over `'playIntegrity'`. A debug-provider build on a real device mints an App Check
 * token nobody registered, so every callable is refused -- messaging, the directory and billing all
 * fail for every tester, while Firestore reads keep working and disguise it as an app bug.
 *
 * This is not hypothetical: the version 3 closed-testing release was built this way and refused
 * every real device. Nothing about it is visible until then. The build succeeds, the upload
 * succeeds, the app installs and starts, and the first symptom is a callable failing on somebody
 * else's phone hours later. Forgetting one environment variable should stop the build instead.
 *
 * `assembleRelease` is deliberately NOT gated. A dev-environment release APK is how this project
 * tests on an emulator, where Play Integrity cannot attest at all and the debug provider is the
 * only thing that works.
 *
 * Why a plugin as well as the edit in `android/app/build.gradle`: `android/` is git-ignored here
 * and regenerated wholesale by `expo prebuild`, which would take the guard with it. The committed
 * plugin is the durable copy; the generated file is the one Gradle actually reads. Same split as
 * `versionCode`, for the same reason.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

/** Presence of this marker means the patch is already applied; the plugin is then a no-op. */
const MARKER = 'SILENTSUM_APP_CHECK_ENV_GUARD';

const ANDROID_ANCHOR = '\nandroid {\n';

/**
 * The guard, as Groovy. An array of lines rather than a template literal so Groovy's `${...}`
 * interpolation can never collide with JavaScript's.
 */
const GUARD = [
  '// --- ' + MARKER + ' -------------------------------------------------------------',
  '// An .aab goes to Google Play, and a Play build MUST use the Play Integrity App Check provider.',
  "// app.config.ts defaults SILENTSUM_ENV to 'dev', which selects the DEBUG provider; a debug",
  '// provider on a real device mints a token nobody registered, and every callable is refused.',
  '// Firestore reads keep working, which hides it. Version 3 shipped exactly this way.',
  "def silentsumBuildEnv = System.getenv('SILENTSUM_ENV')",
  "if (silentsumBuildEnv != 'prod') {",
  '    gradle.taskGraph.whenReady { graph ->',
  "        // Matched by full path, NOT by `name.startsWith('bundle') && name.endsWith('Release')`.",
  '        // That obvious predicate is wrong: the Expo library modules contribute',
  '        // `bundleLibCompileToJarRelease` and `bundleLibRuntimeToJarRelease` to EVERY release',
  '        // build, so it fires on `assembleRelease` too and blocks the emulator path this guard is',
  '        // meant to leave alone. `:app:bundleRelease` is the only task that produces an .aab.',
  '        // (A product flavour would add `:app:bundle<Flavour>Release`; this project has none.)',
  "        def bundlingRelease = graph.allTasks.any { t -> t.path == ':app:bundleRelease' }",
  '        if (bundlingRelease) {',
  '            throw new GradleException(',
  '                "Refusing to build a release App Bundle with SILENTSUM_ENV=" +',
  '                (silentsumBuildEnv == null ? "(unset)" : silentsumBuildEnv) + ".\\n" +',
  '                "  An .aab goes to Google Play, and a Play build must use the Play Integrity App\\n" +',
  '                "  Check provider. app.config.ts defaults SILENTSUM_ENV to \'dev\', which selects the\\n" +',
  '                "  DEBUG provider -- every callable is then refused on every real device.\\n" +',
  '                "  Build it as:  SILENTSUM_ENV=prod ./gradlew bundleRelease\\n" +',
  '                "  See docs/building.md.")',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

function patch(contents) {
  if (contents.includes(MARKER)) return contents;
  const at = contents.indexOf(ANDROID_ANCHOR);
  if (at < 0) {
    // A moved anchor must stop the build, not silently produce an unguarded one. This is the
    // realistic way the plugin breaks: Expo's template changes under a future prebuild.
    throw new Error(
      "withAppCheckEnvGuard: could not find the `android {` block to anchor to. Expo's template " +
        'has changed; update ANDROID_ANCHOR.',
    );
  }
  return contents.slice(0, at) + '\n' + GUARD + contents.slice(at);
}

module.exports = function withAppCheckEnvGuard(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error(
        `withAppCheckEnvGuard: expected a Groovy build.gradle, got ${mod.modResults.language}.`,
      );
    }
    mod.modResults.contents = patch(mod.modResults.contents);
    return mod;
  });
};

// Exported for the test, which runs the patch against a copy of the template.
module.exports.patch = patch;
