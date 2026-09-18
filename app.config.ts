import type { ConfigContext, ExpoConfig } from 'expo/config';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * SilentSum app configuration.
 *
 * Firebase is optional. The React Native Firebase config plugins refuse to run when the native
 * config files are missing, so they are added only when the config file for the platform exists.
 * Without them the app is compiled without any Firebase native initialisation and the JS layer
 * detects that at runtime (`src/firebase/firebaseGateway.ts`), leaving the calculator and the
 * offline vault untouched.
 *
 * Environment variables (see `.env.example`; Expo CLI loads `.env` automatically):
 *   SILENTSUM_ENV            dev | prod (default dev)
 *   GOOGLE_SERVICES_JSON     path to google-services.json
 *   GOOGLE_SERVICES_PLIST    path to GoogleService-Info.plist
 *   APP_CHECK_DEBUG_TOKEN    optional App Check debug token for dev builds
 *   APP_ID                   Android applicationId / iOS bundleIdentifier
 *   FIREBASE_STORAGE_BUCKET  SilentSum's OWN Storage bucket (no gs:// prefix); without it
 *                            cloud backup is not offered, on purpose - see
 *                            CloudBackendOptions.storageBucket
 *   SUPPORT_ENDPOINT         Resend /emails, or your own relay (https only)
 *   SUPPORT_API_KEY          bearer token for that endpoint
 *   SUPPORT_FROM             sender, e.g. "Calculator <support@example.com>"
 *   SUPPORT_TO               the support inbox
 *
 * Support is optional in the same way Firebase is: with no SUPPORT_FROM/SUPPORT_TO the customer
 * service screen says it is not set up in this build rather than offering a form that goes nowhere.
 * Note that anything put in `extra` is readable in the shipped bundle - see the warning in
 * src/support/supportConfig.ts before pointing SUPPORT_API_KEY at a real Resend key.
 */

// Read statically, one property at a time: Expo inlines `process.env.X` at build time and cannot
// follow a dynamic lookup, so `process.env[name]` would silently be empty in a production bundle.
const pick = (value: string | undefined, fallback: string): string =>
  value === undefined || value === '' ? fallback : value;

const silentsumEnv = pick(process.env.SILENTSUM_ENV, 'dev') === 'prod' ? 'prod' : 'dev';
const appId = pick(process.env.APP_ID, 'com.kruegerco.silentsum');
const appCheckDebugToken = pick(process.env.APP_CHECK_DEBUG_TOKEN, '');
const firebaseStorageBucket = pick(process.env.FIREBASE_STORAGE_BUCKET, '');

const supportEndpoint = pick(process.env.SUPPORT_ENDPOINT, 'https://api.resend.com/emails');
const supportApiKey = pick(process.env.SUPPORT_API_KEY, '');
const supportFrom = pick(process.env.SUPPORT_FROM, '');
const supportTo = pick(process.env.SUPPORT_TO, '');
const support =
  supportFrom === '' || supportTo === ''
    ? undefined
    : {
        endpoint: supportEndpoint,
        apiKey: supportApiKey === '' ? undefined : supportApiKey,
        from: supportFrom,
        to: supportTo,
      };

const googleServicesJson = pick(
  process.env.GOOGLE_SERVICES_JSON,
  `./config/firebase/google-services.${silentsumEnv}.json`,
);
const googleServicesPlist = pick(
  process.env.GOOGLE_SERVICES_PLIST,
  `./config/firebase/GoogleService-Info.${silentsumEnv}.plist`,
);

const firebaseAndroid = existsSync(resolve(__dirname, googleServicesJson));
const firebaseIos = existsSync(resolve(__dirname, googleServicesPlist));
const firebaseConfigured = firebaseAndroid || firebaseIos;

const firebasePlugins: NonNullable<ExpoConfig['plugins']> = firebaseConfigured
  ? [
      ['@react-native-firebase/app', { ios: { disableSPM: true } }],
      '@react-native-firebase/auth',
      '@react-native-firebase/crashlytics',
      '@react-native-firebase/app-check',
      '@react-native-firebase/analytics',
    ]
  : [];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Calculator',
  slug: 'silentsum',
  version: '0.1.0',
  orientation: 'default',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: appId,
    supportsTablet: true,
    ...(firebaseIos ? { googleServicesFile: googleServicesPlist } : {}),
    infoPlist: {
      // Vault contents must never appear in the OS photo library or file browsers.
      UIFileSharingEnabled: false,
      LSSupportsOpeningDocumentsInPlace: false,
      // App Store export compliance: standard, publicly available encryption for user data at rest.
      ITSAppUsesNonExemptEncryption: false,
      NSCameraUsageDescription:
        'The camera is used to take photos that are stored encrypted inside the app.',
      NSPhotoLibraryUsageDescription:
        'Photo library access lets you import pictures into the encrypted vault. Originals are never modified.',
    },
  },
  android: {
    package: appId,
    ...(firebaseAndroid ? { googleServicesFile: googleServicesJson } : {}),
    adaptiveIcon: {
      backgroundColor: '#1F2937',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    // The vault is app-private ciphertext plus a Keystore-wrapped key; a restored backup could never
    // be opened on another device, so exclude everything from OS backups.
    allowBackup: false,
    predictiveBackGestureEnabled: false,
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.ACCESS_MEDIA_LOCATION',
      'com.google.android.gms.permission.AD_ID',
      'android.permission.ACCESS_ADSERVICES_AD_ID',
      'android.permission.ACCESS_ADSERVICES_ATTRIBUTION',
      'android.permission.ACCESS_ADSERVICES_TOPICS',
      // React Native's development overlay declares these. The shipped app draws no overlays and
      // has no haptics, so neither belongs in the released permission set.
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.VIBRATE',
      // expo-secure-store declares these for its `requireAuthentication` option, which this app
      // deliberately does not use: under it a biometrics-invalidated key reads back as "absent",
      // which is indistinguishable from "no vault" and would fail open.
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      // Play referrer and Google services lookups pulled in by transitive libraries. The app has
      // no attribution, no ads and no Play integration.
      'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
      'com.google.android.providers.gsf.permission.READ_GSERVICES',
    ],
    // DETECT_SCREEN_CAPTURE is not optional despite the app never listening for screenshots:
    // expo-screen-capture registers a screen-capture observer when its native module loads, and
    // on Android 14+ that call is refused without the permission, which kills the app at startup.
    // It only allows being *told* a screenshot happened; it grants no access to screen contents.
    permissions: [
      'android.permission.CAMERA',
      'android.permission.INTERNET',
      'android.permission.DETECT_SCREEN_CAPTURE',
    ],
  },
  plugins: [
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 160,
        resizeMode: 'contain',
        backgroundColor: '#1F2937',
        dark: { backgroundColor: '#111827' },
      },
    ],
    'react-native-libsodium',
    'expo-secure-store',
    'expo-image',
    // expo-dev-client is deliberately NOT registered as a plugin: it injects an `exp+silentsum`
    // deep-link scheme into the manifest, and a launcher-visible URL scheme carrying the product's
    // real name defeats the point of the calculator disguise. Debug builds still load from Metro.
    [
      'expo-camera',
      {
        cameraPermission: 'Allow $(PRODUCT_NAME) to use the camera to take photos into the vault.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'Allow $(PRODUCT_NAME) to read the photos you choose to import into the vault.',
        // `cameraPermission: false` here would block CAMERA outright, overriding expo-camera's
        // grant and leaving the capture screen permanently unable to ask. The picker never opens
        // the camera in this app, so the option is simply left unset.
        microphonePermission: false,
      },
    ],
    [
      'expo-video',
      {
        // Both are security settings, not preferences. Background playback would keep a decrypted
        // recording running after the user left the app, and a picture-in-picture window is drawn
        // by the system OUTSIDE the app, where FLAG_SECURE does not reach. Declaring them false
        // keeps the PiP activity and the background-audio capability out of the manifest
        // altogether, so neither can be reached even by mistake.
        supportsBackgroundPlayback: false,
        supportsPictureInPicture: false,
      },
    ],
    // expo-video-thumbnails and expo-screen-capture ship no config plugin: they are autolinked and
    // need no native config. Listing them here makes prebuild fail while trying to load their main
    // entry as a plugin.
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 26,
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
        ios: {
          deploymentTarget: '16.4',
          useFrameworks: 'static',
        },
      },
    ],
    ...firebasePlugins,
    './plugins/withGradleMemory',
    // Runs last so it also strips filters contributed by the plugins above.
    './plugins/withoutDeepLinks',
  ],
  extra: {
    silentsumEnv,
    firebaseConfigured,
    firebaseAndroid,
    firebaseIos,
    appCheckDebugToken: appCheckDebugToken === '' ? undefined : appCheckDebugToken,
    firebaseStorageBucket: firebaseStorageBucket === '' ? undefined : firebaseStorageBucket,
    support,
  },
});
