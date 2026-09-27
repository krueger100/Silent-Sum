#!/usr/bin/env node
/**
 * Writes `credentials.json` from `keystore.properties`.
 *
 * Two build paths need the same four values and read them from different files. A local
 * `./gradlew bundleRelease` gets them from `keystore.properties` through
 * `plugins/withReleaseSigning.js`; EAS Build gets them from `credentials.json`, because
 * `credentialsSource: "local"` is what keeps EAS signing with the same key as a local build rather
 * than one of its own. Play only ever accepts one upload key, so "the same key" is the whole point.
 *
 * Maintaining the two by hand is a silent trap: they can disagree, and the way you find out is an
 * EAS build that succeeds and produces an artifact Play then rejects. So one is generated from the
 * other, and `keystore.properties` is the only copy anybody edits.
 *
 * Resolution matches the Gradle plugin exactly -- properties file first, then the environment -- so
 * a machine that builds locally can generate credentials without a second configuration step.
 *
 *   node scripts/eas-credentials.js        # or: npm run eas:credentials
 *
 * No value is ever printed. The output is the path written, the keystore it points at, the key alias
 * and the certificate's SHA-256 fingerprint -- the fingerprint being a public identifier that Play
 * itself displays, and the one thing that proves the passwords are right before a build spends
 * twenty minutes finding out.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROPERTIES_FILE = path.join(ROOT, 'keystore.properties');
const OUTPUT_FILE = path.join(ROOT, 'credentials.json');

/** `keystore.properties` key -> environment variable -> `credentials.json` key. */
const FIELDS = [
  ['storeFile', 'SILENTSUM_KEYSTORE_FILE', 'keystorePath'],
  ['storePassword', 'SILENTSUM_KEYSTORE_PASSWORD', 'keystorePassword'],
  ['keyAlias', 'SILENTSUM_KEY_ALIAS', 'keyAlias'],
  ['keyPassword', 'SILENTSUM_KEY_PASSWORD', 'keyPassword'],
];

/** A deliberately small `.properties` reader: `key=value`, `#` comments, blank lines. */
function parseProperties(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Builds the `credentials.json` contents, or throws naming exactly what is missing.
 *
 * Pure apart from `exists`, which is injected so the shape can be tested without a real keystore.
 */
function buildCredentials({ props = {}, env = {}, root = ROOT, exists = fs.existsSync } = {}) {
  const values = {};
  const missing = [];
  for (const [key, envKey, outKey] of FIELDS) {
    const value = text(props[key]) ?? text(env[envKey]);
    if (value === null) missing.push(`${key} (or ${envKey})`);
    else values[outKey] = value;
  }
  if (missing.length > 0) {
    throw new Error(`no release signing credentials: missing ${missing.join(', ')}`);
  }

  // Same rule as the Gradle plugin: absolute is taken as given, relative is from the project root.
  const given = values.keystorePath;
  const absolute = path.isAbsolute(given) ? given : path.join(root, given);
  if (!exists(absolute)) {
    throw new Error(`keystore not found at ${absolute}`);
  }

  // Relative to the project root when it lives inside it, which is where eas-cli resolves from;
  // absolute otherwise. Forward slashes either way -- valid on Windows and portable off it.
  const relative = path.relative(root, absolute);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const keystorePath = (inside ? relative : absolute).split(path.sep).join('/');

  return {
    credentials: {
      android: {
        keystore: {
          keystorePath,
          keystorePassword: values.keystorePassword,
          keyAlias: values.keyAlias,
          keyPassword: values.keyPassword,
        },
      },
    },
    absolutePath: absolute,
  };
}

/** Whether git would keep this file out of a commit. Conservative: unknown counts as "no". */
function isGitIgnored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The certificate's SHA-256 fingerprint, or null when keytool is unavailable.
 *
 * The store password goes in on stdin rather than as `-storepass`, which would put it in the
 * process list for anything on the machine to read.
 */
function fingerprint(keystore, alias, storePassword) {
  const javaHome = process.env.JAVA_HOME;
  const keytool =
    javaHome === undefined || javaHome === '' ? 'keytool' : path.join(javaHome, 'bin', 'keytool');
  try {
    const out = execFileSync(keytool, ['-list', '-v', '-keystore', keystore, '-alias', alias], {
      input: `${storePassword}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return /SHA256:\s*([0-9A-Fa-f:]{20,})/.exec(out)?.[1] ?? null;
  } catch {
    // Wrong password, wrong alias, or no keytool. Reported by the caller as unverified, not fatal:
    // this is a check on top of the write, and the write itself is what was asked for.
    return null;
  }
}

module.exports = { buildCredentials, parseProperties };

if (require.main === module) {
  const props = fs.existsSync(PROPERTIES_FILE)
    ? parseProperties(fs.readFileSync(PROPERTIES_FILE, 'utf8'))
    : {};

  let built;
  try {
    built = buildCredentials({ props, env: process.env });
  } catch (error) {
    console.error(`eas-credentials: ${error instanceof Error ? error.message : String(error)}`);
    console.error('');
    console.error(
      '  Copy keystore.properties.example to keystore.properties and fill it in, or set',
    );
    console.error(
      '  SILENTSUM_KEYSTORE_FILE, SILENTSUM_KEYSTORE_PASSWORD, SILENTSUM_KEY_ALIAS and',
    );
    console.error('  SILENTSUM_KEY_PASSWORD. See docs/building.md.');
    process.exit(1);
  }

  // Refuse to write secrets somewhere git would pick them up. `.gitignore` already lists this file;
  // the check is here so an edit to .gitignore cannot quietly turn this script into a leak.
  if (!isGitIgnored(OUTPUT_FILE)) {
    console.error('eas-credentials: credentials.json is not git-ignored; refusing to write it.');
    console.error('  Add `credentials.json` to .gitignore first.');
    process.exit(1);
  }

  const existed = fs.existsSync(OUTPUT_FILE);
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(built.credentials, null, 2)}\n`);

  const keystore = built.credentials.android.keystore;
  console.log(`${existed ? 'replaced' : 'wrote'} ${path.relative(ROOT, OUTPUT_FILE)}`);
  console.log(`  keystore  ${keystore.keystorePath}`);
  console.log(`  keyAlias  ${keystore.keyAlias}`);

  const sha = fingerprint(built.absolutePath, keystore.keyAlias, keystore.keystorePassword);
  if (sha === null) {
    console.log(
      '  SHA-256   not verified (keytool unavailable, or the alias/password was refused)',
    );
  } else {
    console.log(`  SHA-256   ${sha}`);
    console.log('');
    console.log('Register that fingerprint as the upload key in Play Console. It is public: Play');
    console.log('displays it, and it is how you confirm a later build used the same key.');
  }
}
