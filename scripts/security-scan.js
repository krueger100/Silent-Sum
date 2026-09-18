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
];

/** Files that must not be committed even if they are valid. */
const FORBIDDEN_FILES = [
  'google-services.json',
  'GoogleService-Info.plist',
  'keystore.properties',
  'key.properties',
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

// 3. Config files that belong only on a developer's machine.
for (const file of files) {
  if (FORBIDDEN_FILES.includes(path.basename(file))) {
    report(file, 'is a credential/config file that must not be committed');
  }
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
const NETWORK_ALLOWED = [path.join('src', 'firebase') + path.sep, path.join('src', 'support') + path.sep];
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

if (!fs.existsSync(SRC)) {
  problems.push('src/ is missing; nothing was scanned');
}

if (problems.length > 0) {
  console.error(`security scan: ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`security scan: clean (${String(files.length)} files checked)`);
