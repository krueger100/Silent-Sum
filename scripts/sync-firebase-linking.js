#!/usr/bin/env node
/**
 * Keeps the Firebase native modules out of the build unless Firebase is actually configured.
 *
 * Why this is needed: `app.config.ts` already skips the React Native Firebase *config plugins* when
 * no `google-services.json` / `GoogleService-Info.plist` is present, but the npm packages are still
 * dependencies, so autolinking still compiles their native modules in. At least one of them
 * (App Check) touches `FirebaseApp.getInstance()` from its TurboModule constructor, which throws
 * `Default FirebaseApp is not initialized` and kills the app on launch.
 *
 * The brief is explicit that the app must run unchanged with no Firebase. So the packages are
 * excluded from autolinking whenever their config files are absent, and linked back in the moment
 * they appear.
 *
 * Autolinking reads this list from `package.json` at BUILD time, so this script runs from
 * `postinstall` and from the `prebuild` scripts. After adding or removing a Firebase config file,
 * re-run `npm run prebuild` (or this script) before building.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

/** Every Firebase package whose native side must not load without a configured app. */
const FIREBASE_PACKAGES = [
  '@react-native-firebase/app',
  '@react-native-firebase/app-check',
  '@react-native-firebase/analytics',
  '@react-native-firebase/auth',
  '@react-native-firebase/crashlytics',
  '@react-native-firebase/firestore',
  '@react-native-firebase/storage',
];

function firebaseIsConfigured() {
  const env = process.env.SILENTSUM_ENV === 'prod' ? 'prod' : 'dev';
  const candidates = [
    process.env.GOOGLE_SERVICES_JSON ?? `./config/firebase/google-services.${env}.json`,
    process.env.GOOGLE_SERVICES_PLIST ?? `./config/firebase/GoogleService-Info.${env}.plist`,
  ];
  return candidates.some((candidate) => fs.existsSync(path.resolve(ROOT, candidate)));
}

const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
const configured = firebaseIsConfigured();

pkg.expo = pkg.expo ?? {};
pkg.expo.autolinking = pkg.expo.autolinking ?? {};

const previous = Array.isArray(pkg.expo.autolinking.exclude) ? pkg.expo.autolinking.exclude : [];
const others = previous.filter((name) => !FIREBASE_PACKAGES.includes(name));
const next = configured ? others : [...others, ...FIREBASE_PACKAGES];

const changed = JSON.stringify(previous) !== JSON.stringify(next);
pkg.expo.autolinking.exclude = next;

if (next.length === 0) delete pkg.expo.autolinking.exclude;
if (Object.keys(pkg.expo.autolinking).length === 0) delete pkg.expo.autolinking;
if (Object.keys(pkg.expo).length === 0) delete pkg.expo;

if (changed) {
  fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(
  configured
    ? 'firebase linking: config found, Firebase native modules WILL be linked'
    : 'firebase linking: no config, Firebase native modules excluded from autolinking',
);
