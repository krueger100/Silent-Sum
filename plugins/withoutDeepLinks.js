/**
 * Removes every VIEW/BROWSABLE intent filter from the launcher activity.
 *
 * Two reasons:
 *
 * 1. Disguise. Expo registers an `exp+<slug>` URL scheme by default. A scheme carrying the
 *    product's real name is visible to any app that queries the package manager, which defeats the
 *    point of an app that presents itself as a calculator.
 * 2. Attack surface. The app has no deep-link feature at all. The launcher activity is the only
 *    exported component, and it should accept nothing but MAIN/LAUNCHER, so no other app can hand
 *    it a URL and reach into it.
 *
 * Debug builds still load JavaScript from Metro; that connection does not use an intent filter.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

function isDeepLinkFilter(filter) {
  const actions = filter.action ?? [];
  return actions.some((action) => action.$?.['android:name'] === 'android.intent.action.VIEW');
}

module.exports = function withoutDeepLinks(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) return mod;

    for (const activity of application.activity ?? []) {
      if (!Array.isArray(activity['intent-filter'])) continue;
      activity['intent-filter'] = activity['intent-filter'].filter(
        (filter) => !isDeepLinkFilter(filter),
      );
    }
    return mod;
  });
};
