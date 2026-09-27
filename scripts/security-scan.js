#!/usr/bin/env node
/**
 * Fails the build on the mistakes that would quietly undo this app's security properties.
 *
 * These are architectural invariants that a type checker cannot see: an import from the wrong
 * layer still compiles, and a committed `google-services.json` is still valid JSON. Each check
 * below corresponds to something documented in docs/security.md and docs/architecture.md.
 *
 * Run with `npm run security:scan`.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Directories whose code is allowed to touch a given platform module. */
const IMPORT_RULES = [
  {
    what: 'the libsodium binding',
    pattern: /from\s+['"]react-native-libsodium['"]/,
    allowed: [path.join('src', 'crypto', 'sodium.ts')],
    why: 'all crypto goes through src/crypto, which is what keeps it testable and auditable',
  },
  {
    what: 'a @react-native-firebase package',
    pattern: /from\s+['"]@react-native-firebase\//,
    allowed: [path.join('src', 'firebase') + path.sep],
    why: 'Firebase is optional; nothing outside src/firebase may depend on it existing',
  },
  {
    what: 'expo-secure-store',
    pattern: /from\s+['"]expo-secure-store['"]/,
    allowed: [path.join('src', 'secure-storage') + path.sep],
    why: 'the secure store is reached through the SecureStore interface so tests can fake it',
  },
];

/** Things that must never appear anywhere in the tracked source. */
const FORBIDDEN_CONTENT = [
  {
    what: 'a hardcoded Google API key',
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    what: 'a hardcoded Resend API key',
    pattern: /\bre_[A-Za-z0-9_]{24,}/,
  },
  {
    what: 'a private key block',
    pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    what: 'a Firebase service-account credential',
    pattern: /"type"\s*:\s*"service_account"/,
  },
  // PayMongo credentials belong in Firebase Secret Manager, bound to the functions that use them.
  // A secret key in tracked source can create charges; a webhook secret can forge "payment
  // received" events. Neither may appear anywhere here, docs and test fixtures included.
  {
    what: 'a PayMongo secret key',
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{12,}/,
  },
  {
    what: 'a PayMongo webhook signing secret',
    pattern: /\bwhsk_[A-Za-z0-9]{12,}/,
  },
];

/**
 * Files that must not be COMMITTED, however valid they are.
 *
 * Every one of them is supposed to exist on a machine that builds: docs/building.md asks for
 * `keystore.properties`, and `scripts/eas-credentials.js` writes `credentials.json` from it. So
 * presence on disk is not the fault -- being tracked by git is. The check below tests the latter,
 * which is what the rule was always about; testing presence made following the release instructions
 * fail the scan.
 */
const FORBIDDEN_FILES = [
  'google-services.json',
  'GoogleService-Info.plist',
  'keystore.properties',
  'key.properties',
  'credentials.json',
];

/** Git-ignored by design: see the note at the secrets check below. */
const FIREBASE_CONFIG_DIR = path.join('config', 'firebase') + path.sep;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'android',
  'ios',
  'dist',
  'coverage',
  '.expo',
  'patches',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // The functions' compiled output is regenerated on every build and never committed.
      if (entry.name === 'lib' && path.basename(dir) === 'functions') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const problems = [];

function report(file, message) {
  problems.push(`${path.relative(ROOT, file)}: ${message}`);
}

const files = walk(ROOT);

// 1. Layering: only the designated module may import each platform dependency.
for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const relative = path.relative(ROOT, file);
  if (relative.includes('__tests__') || relative.startsWith('test' + path.sep)) continue;

  const text = fs.readFileSync(file, 'utf8');
  for (const rule of IMPORT_RULES) {
    if (!rule.pattern.test(text)) continue;
    const permitted = rule.allowed.some((allowed) => relative.startsWith(allowed));
    if (!permitted) {
      report(file, `imports ${rule.what} directly; ${rule.why}`);
    }
  }
}

// 2. Secrets: nothing key-shaped in tracked files.
for (const file of files) {
  if (/\.(png|jpg|jpeg|gif|webp|ttf|otf|ico|apk|aab|keystore|jks)$/i.test(file)) continue;
  const relative = path.relative(ROOT, file);
  if (relative === path.join('scripts', 'security-scan.js')) continue;
  // config/firebase/ is where the native Firebase config files are SUPPOSED to live, and
  // .gitignore excludes every .json/.plist in it. They carry a Firebase API key by design - a
  // public client identifier, not a secret - so scanning them would fail the build for doing
  // exactly what docs/firebase-setup.md asks for. Everywhere else, the rule still applies.
  if (relative.startsWith(FIREBASE_CONFIG_DIR)) continue;
  // A credential store holds credentials; that is its job, and check 3 decides whether it has
  // escaped into git. Reading one here would only invite a false alarm when a password happens to
  // look like a key.
  if (FORBIDDEN_FILES.includes(path.basename(file))) continue;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const rule of FORBIDDEN_CONTENT) {
    if (rule.pattern.test(text)) report(file, `contains what looks like ${rule.what}`);
  }
}

// 3. Config files that belong only on a developer's machine -- and only there.
//
// Reported when git TRACKS one, not when one merely exists: these are files a building machine is
// meant to have. `git ls-files` is the whole tracked set in one call. If git cannot be reached the
// check falls back to reporting on presence, which is the conservative direction: a false alarm is
// recoverable, a committed keystore password is not.
let tracked = null;
try {
  tracked = new Set(
    execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => path.resolve(ROOT, entry)),
  );
} catch {
  tracked = null;
}

for (const file of files) {
  if (!FORBIDDEN_FILES.includes(path.basename(file))) continue;
  if (tracked !== null && !tracked.has(path.resolve(file))) continue;
  report(
    file,
    tracked === null
      ? 'is a credential/config file that must not be committed (git unavailable, checked by presence)'
      : 'is a credential/config file and is TRACKED BY GIT; remove it from the index',
  );
}

// 4. The vault must never write outside app-private storage.
for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const relative = path.relative(ROOT, file);
  if (!relative.startsWith('src' + path.sep)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/MediaLibrary|createAssetAsync|saveToLibraryAsync/.test(text)) {
    report(file, 'references the OS media library; vault content must never be written there');
  }
}

// 5. The unlock path must not reach the network.
const AUTH_FILES = files.filter((f) => {
  const rel = path.relative(ROOT, f);
  return (
    rel.startsWith(path.join('src', 'auth')) &&
    /\.ts$/.test(rel) &&
    !rel.includes('__tests__') &&
    !rel.includes('screens')
  );
});
for (const file of AUTH_FILES) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\bfetch\(|XMLHttpRequest|@react-native-firebase|axios/.test(text)) {
    report(file, 'the offline authentication path must not reference any network client');
  }
}

// 6. Only the two modules that are allowed to talk to a server may reach for a network client.
// Everything else in this app works offline and must keep working offline.
const NETWORK_ALLOWED = [
  path.join('src', 'firebase') + path.sep,
  path.join('src', 'support') + path.sep,
];
for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const relative = path.relative(ROOT, file);
  if (!relative.startsWith('src' + path.sep)) continue;
  if (relative.includes('__tests__')) continue;
  if (NETWORK_ALLOWED.some((allowed) => relative.startsWith(allowed))) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/\bfetch\(|XMLHttpRequest|\baxios\b/.test(text)) {
    report(file, 'reaches the network outside src/firebase and src/support');
  }
}

// 7. The app never talks to PayMongo. Only the Cloud Functions (functions/) hold a PayMongo
// credential, so a PayMongo host anywhere in the app is a design error, whatever it is doing.
for (const file of files) {
  if (!/\.(ts|tsx|js)$/.test(file)) continue;
  const relative = path.relative(ROOT, file);
  if (!relative.startsWith('src' + path.sep) && relative !== 'App.tsx') continue;
  // Test doubles hand the screens a fake hosted page; that is the backend's answer, not a call.
  if (relative.includes('__tests__')) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/paymongo\.com/i.test(text)) {
    report(file, 'references a PayMongo host; payments go through functions/, never the app');
  }
}

// 8. The app and the functions are separate programs with separate dependencies. Importing
// server code into the bundle would drag firebase-admin and the billing internals into the APK.
for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const relative = path.relative(ROOT, file);
  if (!relative.startsWith('src' + path.sep)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/from\s+['"](?:\.\.\/)+functions\//.test(text)) {
    report(file, 'imports from functions/; the app must not depend on the backend package');
  }
}

// 9. No credential may be compiled into the bundle through the Expo config. Everything in `extra`
// is plain text in the APK, so a bearer token there is published, not configured. The support
// screen posts to a Cloud Function that holds the mail provider's key instead
// (functions/src/supportRelay.ts); there is nothing left for the app to authenticate WITH.
const CONFIG_FILE = path.join(ROOT, 'app.config.ts');
if (fs.existsSync(CONFIG_FILE)) {
  const text = fs.readFileSync(CONFIG_FILE, 'utf8');
  for (const name of ['SUPPORT_API_KEY', 'RESEND_API_KEY']) {
    // Mentioned in a comment is fine; read into the config is not.
    if (new RegExp(`process\\.env\\.${name}`).test(text)) {
      report(CONFIG_FILE, `reads ${name}; a credential in \`extra\` ships inside the APK`);
    }
  }
  if (/\bapiKey\s*:/.test(text)) {
    report(
      CONFIG_FILE,
      'puts an apiKey in the config; nothing in `extra` may carry a bearer token',
    );
  }
}

// 10. The generated Android project must not sign a release with the debug key. Play rejects it,
// and `debug.keystore` is the same key in every React Native checkout, so anything it signs can be
// replaced by anyone. `plugins/withReleaseSigning.js` rewrites this; the check is here because
// `android/` is regenerated and gitignored, so a stale or unpatched prebuild is the way it comes
// back. Skipped when the project has not been generated, which is how CI runs.
const APP_GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
if (fs.existsSync(APP_GRADLE)) {
  const gradle = fs.readFileSync(APP_GRADLE, 'utf8');
  const buildTypes = gradle.indexOf('buildTypes {');
  const releaseAt = buildTypes === -1 ? -1 : gradle.indexOf('release {', buildTypes);
  const release =
    releaseAt === -1 ? '' : gradle.slice(releaseAt, gradle.indexOf('\n        }', releaseAt));
  if (releaseAt === -1) {
    report(APP_GRADLE, 'has no release build type; the signing configuration cannot be checked');
  } else if (release.includes('signingConfigs.debug')) {
    report(APP_GRADLE, 'signs the release build with the DEBUG key; re-run `npx expo prebuild`');
  } else if (!gradle.includes('SILENTSUM_RELEASE_SIGNING')) {
    report(APP_GRADLE, 'was generated without withReleaseSigning; re-run `npx expo prebuild`');
  }
}

if (!fs.existsSync(SRC)) {
  problems.push('src/ is missing; nothing was scanned');
}

if (problems.length > 0) {
  console.error(`security scan: ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`security scan: clean (${String(files.length)} files checked)`);
