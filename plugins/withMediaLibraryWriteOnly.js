/**
 * Lets the vault write to the device gallery without acquiring the right to read it.
 *
 * `expo-media-library` ships its own config plugin, and this app deliberately does not use it.
 * That plugin adds `READ_EXTERNAL_STORAGE`, `READ_MEDIA_VISUAL_USER_SELECTED` and, by default, all
 * three granular `READ_MEDIA_*` permissions -- the full read-the-user's-library set. The export
 * feature needs none of it. It adds one file and never looks at the gallery again, so the only
 * capability it may hold is the one in `app.config.ts`: `WRITE_EXTERNAL_STORAGE`, which the
 * library's own manifest already caps at `maxSdkVersion="32"`.
 *
 * Why the permission set matters more here than in most apps: the app presents itself as a
 * calculator, and a Play listing that suddenly asks for photo and video access undoes that on the
 * store page, before the app is even installed. `READ_MEDIA_IMAGES` is also a sensitive permission
 * that Play makes you justify in a declaration form.
 *
 * What is left to do is the one thing the library cannot express in its own manifest:
 *
 *   `expo-media-library` picks its implementation by API level. From Android 11 (API 30) it
 *   inserts through MediaStore, which needs no permission at all for content the app created. On
 *   Android 10 (API 29) it falls back to writing a file into public storage directly, and scoped
 *   storage blocks that unless the app opts out with `requestLegacyExternalStorage`. The flag is
 *   ignored from API 30 onwards, so it changes behaviour on exactly one Android version -- the one
 *   where the export would otherwise fail. Below API 29 scoped storage does not exist and the flag
 *   is irrelevant.
 *
 * `minSdkVersion` is 26, so API 29 is inside the supported range and cannot simply be written off.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const LEGACY_STORAGE_FLAG = 'android:requestLegacyExternalStorage';

/**
 * Exported for the spec: the manifest mutation on its own, with no Expo plumbing around it.
 * Throws rather than quietly doing nothing, because a silent no-op would ship an export that
 * fails only on Android 10 -- a device nobody here has.
 */
function enableLegacyExternalStorage(manifest) {
  const application = manifest?.manifest?.application?.[0];
  if (!application) {
    throw new Error(
      'withMediaLibraryWriteOnly: no <application> node in the Android manifest. The template ' +
        'changed shape; gallery export would silently fail on Android 10.',
    );
  }
  application.$ = application.$ ?? {};
  application.$[LEGACY_STORAGE_FLAG] = 'true';
  return manifest;
}

module.exports = function withMediaLibraryWriteOnly(config) {
  return withAndroidManifest(config, (mod) => {
    mod.modResults = enableLegacyExternalStorage(mod.modResults);
    return mod;
  });
};

module.exports.enableLegacyExternalStorage = enableLegacyExternalStorage;
module.exports.LEGACY_STORAGE_FLAG = LEGACY_STORAGE_FLAG;
