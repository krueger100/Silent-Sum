#!/usr/bin/env node
/**
 * Mints support-issued recovery codes.
 *
 * Run this on the machine that holds the signing key, which should not be the machine that builds
 * the app and ideally is not online. It needs nothing but Node: no npm install, no project, no
 * network. Copy this one file onto the signing machine if that is easier.
 *
 *   node scripts/recovery-code.js keygen
 *   node scripts/recovery-code.js sign --ref 7K4M-2QX9-VB3T-Z8QP --key <base64 private key>
 *   node scripts/recovery-code.js sign --ref ... --key-file ./recovery.key --days 7
 *
 * `keygen` prints both halves once. The PUBLIC half goes into RECOVERY_PUBLIC_KEY and ships in
 * the app, where it can only verify. The PRIVATE half is the whole security of the scheme: anyone
 * holding it can mint a code for any installation, so it belongs in a password manager or on
 * paper, never in this repository and never in a build.
 *
 * Before signing anything, satisfy yourself that the person asking owns the phone. The code does
 * not decrypt a vault -- they still need their own backup password and recovery passphrase, and
 * neither exists on our side -- but it does confirm to whoever is holding that handset that the
 * app is a vault rather than a calculator, and for some users that alone is the thing they were
 * relying on.
 *
 * The code layout here is duplicated from `src/support/recoveryCode.ts` so that this file stays
 * dependency-free. `src/support/__tests__/recoveryCodeScript.test.ts` signs with this script and
 * verifies with the app's module, so the two cannot drift apart unnoticed.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const CONTEXT = 'SSRC1';
const INSTALL_REF_BYTES = 10;
const SIGNATURE_BYTES = 64;
const KEY_BYTES = 32;
const DEFAULT_TTL_DAYS = 7;
const MS_PER_DAY = 86400000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Node speaks PKCS#8/SPKI DER; libsodium and this CLI speak raw 32-byte keys. These are the fixed
// Ed25519 wrappers that convert between the two, and they are the entire conversion.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base32Encode(bytes) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((acc >> bits) & 31);
    }
  }
  if (bits > 0) out += ALPHABET.charAt((acc << (5 - bits)) & 31);
  return out;
}

function base32Decode(text) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const raw of String(text).toUpperCase()) {
    if (!/[0-9A-Z]/.test(raw)) continue;
    const folded = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
    const value = ALPHABET.indexOf(folded);
    if (value < 0) throw new Error(`not a base32 character: ${raw}`);
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function group(text, size) {
  const groups = [];
  for (let i = 0; i < text.length; i += size) groups.push(text.slice(i, i + size));
  return groups.join('-');
}

function dayNumber(ms) {
  return Math.floor(ms / MS_PER_DAY);
}

/** Context, then the installation reference, then the expiry day. Must match the app exactly. */
function codeMessage(installRef, expiresAtDays) {
  if (installRef.length !== INSTALL_REF_BYTES) {
    throw new Error(`install ref must be ${INSTALL_REF_BYTES} bytes, got ${installRef.length}`);
  }
  const out = Buffer.alloc(CONTEXT.length + INSTALL_REF_BYTES + 2);
  out.write(CONTEXT, 0, 'ascii');
  installRef.copy(out, CONTEXT.length);
  out.writeUInt16BE(expiresAtDays, CONTEXT.length + INSTALL_REF_BYTES);
  return out;
}

function keygen() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey: privateDer.subarray(privateDer.length - KEY_BYTES).toString('base64'),
    publicKey: publicDer.subarray(publicDer.length - KEY_BYTES).toString('base64'),
  };
}

function privateKeyFrom(rawBase64) {
  const seed = Buffer.from(String(rawBase64).trim(), 'base64');
  if (seed.length !== KEY_BYTES) {
    throw new Error(`private key must be ${KEY_BYTES} bytes of base64, got ${seed.length}`);
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyFrom(rawBase64) {
  const raw = Buffer.from(String(rawBase64).trim(), 'base64');
  if (raw.length !== KEY_BYTES) {
    throw new Error(`public key must be ${KEY_BYTES} bytes of base64, got ${raw.length}`);
  }
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Signs a code for one installation.
 *
 * `nowMs` is injectable so the tests can mint an already-expired code without touching the clock.
 */
function signCode({ ref, privateKey, days = DEFAULT_TTL_DAYS, nowMs = Date.now() }) {
  const installRef = base32Decode(ref);
  const expiresAtDays = dayNumber(nowMs) + Number(days);
  if (!Number.isInteger(expiresAtDays) || expiresAtDays < 0 || expiresAtDays > 0xffff) {
    throw new Error('expiry is out of range');
  }
  const signature = crypto.sign(null, codeMessage(installRef, expiresAtDays), privateKey);
  if (signature.length !== SIGNATURE_BYTES) {
    throw new Error(`unexpected signature length ${signature.length}`);
  }
  const payload = Buffer.alloc(2 + SIGNATURE_BYTES);
  payload.writeUInt16BE(expiresAtDays, 0);
  signature.copy(payload, 2);
  return {
    code: group(base32Encode(payload), 6),
    expiresAt: new Date(expiresAtDays * MS_PER_DAY).toISOString().slice(0, 10),
  };
}

function verifyCode({ code, ref, publicKey }) {
  const payload = base32Decode(code);
  if (payload.length !== 2 + SIGNATURE_BYTES) return false;
  const expiresAtDays = payload.readUInt16BE(0);
  return crypto.verify(
    null,
    codeMessage(base32Decode(ref), expiresAtDays),
    publicKey,
    payload.subarray(2),
  );
}

function arg(argv, name) {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
}

const USAGE = `Usage:
  node scripts/recovery-code.js keygen
  node scripts/recovery-code.js sign --ref <install ref> (--key <base64> | --key-file <path>) [--days ${DEFAULT_TTL_DAYS}]
  node scripts/recovery-code.js verify --ref <install ref> --code <code> --public-key <base64>`;

function main(argv) {
  const command = argv[0];

  if (command === 'keygen') {
    const pair = keygen();
    process.stdout.write(
      [
        '',
        'PUBLIC KEY  -- set RECOVERY_PUBLIC_KEY to this, and rebuild the app:',
        `  ${pair.publicKey}`,
        '',
        'PRIVATE KEY -- store this somewhere safe and offline. It is shown once, it is never',
        '               recoverable, and anyone who has it can mint a code for any installation:',
        `  ${pair.privateKey}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (command === 'sign') {
    const ref = arg(argv, 'ref');
    const keyFile = arg(argv, 'key-file');
    const key = keyFile === undefined ? arg(argv, 'key') : fs.readFileSync(keyFile, 'utf8');
    if (ref === undefined || key === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const days = arg(argv, 'days') ?? DEFAULT_TTL_DAYS;
    const result = signCode({ ref, privateKey: privateKeyFrom(key), days });
    process.stdout.write(
      [
        '',
        `Recovery code for installation ${ref}`,
        `Expires ${result.expiresAt}. Single use.`,
        '',
        `  ${result.code}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (command === 'verify') {
    const ref = arg(argv, 'ref');
    const code = arg(argv, 'code');
    const publicKey = arg(argv, 'public-key');
    if (ref === undefined || code === undefined || publicKey === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const ok = verifyCode({ code, ref, publicKey: publicKeyFrom(publicKey) });
    process.stdout.write(`${ok ? 'valid signature' : 'REJECTED'}\n`);
    return ok ? 0 : 1;
  }

  process.stderr.write(`${USAGE}\n`);
  return 2;
}

module.exports = {
  DEFAULT_TTL_DAYS,
  base32Decode,
  base32Encode,
  codeMessage,
  dayNumber,
  keygen,
  main,
  privateKeyFrom,
  publicKeyFrom,
  signCode,
  verifyCode,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
