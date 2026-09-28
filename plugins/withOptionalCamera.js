/**
 * Declares the camera as OPTIONAL hardware.
 *
 * Google Play infers hardware requirements from permissions: an app that requests
 * `android.permission.CAMERA` is assumed to require `android.hardware.camera` AND
 * `android.hardware.camera.autofocus` unless it says otherwise, and Play then hides the app from
 * every device that lacks them. `android.hardware.camera` means a REAR camera specifically, so
 * without this the listing is filtered off front-camera-only tablets, fixed-focus devices and
 * Chromebooks -- including tablets, a form factor Play requires screenshots for.
 *
 * The camera is one of two ways into the vault, not the only one: `src/gallery/importService.ts`
 * imports through `expo-image-picker`, which needs no camera at all. So the requirement is wrong
 * as well as costly.
 *
 * `<uses-feature>` always takes precedence over a feature implied by a permission, so declaring
 * these two with `required="false"` is the whole fix. The camera still works where there is one;
 * `expo-camera` already handles its absence at runtime.
 *
 * Touchscreen is deliberately left alone. Android assumes `android.hardware.touchscreen` is
 * required for every app, which excludes non-touch Chromebooks and desktops -- form factors this
 * app does not target and has no layout for.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const OPTIONAL = ['android.hardware.camera', 'android.hardware.camera.autofocus'];

module.exports = function withOptionalCamera(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const features = (manifest['uses-feature'] ??= []);

    for (const name of OPTIONAL) {
      const existing = features.find((f) => f.$?.['android:name'] === name);
      if (existing) {
        // Never upgrade an existing declaration to required; only ever relax it.
        existing.$['android:required'] = 'false';
      } else {
        features.push({ $: { 'android:name': name, 'android:required': 'false' } });
      }
    }
    return mod;
  });
};
