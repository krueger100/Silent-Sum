#!/usr/bin/env node
/**
 * Puts the build configuration that git deliberately does not carry into EAS.
 *
 * EAS decides what to upload from git, so `.env` and `config/firebase/google-services.prod.json` --
 * both git-ignored on purpose -- are absent from a cloud build. `app.config.ts` decides whether
 * Firebase is compiled in at all by `existsSync` on that file, so a build without it SUCCEEDS and
 * produces an app with no cloud backup, billing, messaging or support. Nothing warns you. That is
 * the failure this script exists to prevent.
 *
 *   npm run eas:env            # show what would be set, and check every source is present
 *   npm run eas:env -- --apply # actually set them
 *
 * Why a script and not a list of commands to paste: `SUPPORT_FROM` is of the form
 * `Calculator <name@example.com>`, and `<` and `>` are shell redirection. Pasting it unquoted
 * silently truncates the value and creates a file called `name@example.com>`. Passing argv directly
 * cannot go wrong that way.
 *
 * Values come from the files that already hold them, so there is no transcription step and nothing
 * to keep in step by hand. Anything declared `sensitive` is redacted in the output.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

/**
 * What a production build needs and cannot get from git.
 *
 * Deliberately a closed list rather than "push whatever is in .env": `eas env:push` would upload
 * every key the file grows later, including ones that should stay local.
 *
 *   from  'env'  -> the value of that key in .env
 *         'file' -> the contents of that path, stored by EAS and materialised at build time, with
 *                   the variable set to the path it wrote. `app.config.ts` resolves it with
 *                   `resolve(__dirname, value)`, which returns an absolute path unchanged, so no app
 *                   code has to change for this to work.
 */
const VARIABLES = [
  {
    name: 'GOOGLE_SERVICES_JSON',
    from: 'file',
    source: path.join('config', 'firebase', 'google-services.prod.json'),
    type: 'file',
    visibility: 'sensitive',
    why: 'without it the build has no Firebase at all',
  },
  {
    name: 'FIREBASE_STORAGE_BUCKET',
    from: 'env',
    type: 'string',
    visibility: 'plaintext',
    why: 'empty means cloud backup is not offered',
  },
  {
    name: 'SUPPORT_ENDPOINT',
    from: 'env',
    type: 'string',
    visibility: 'plaintext',
    why: 'the support relay function; not a mail provider',
  },
  {
    name: 'SUPPORT_FROM',
    from: 'env',
    type: 'string',
    visibility: 'plaintext',
    why: 'shown by the About screen',
  },
  {
    name: 'SUPPORT_TO',
    from: 'env',
    type: 'string',
    visibility: 'plaintext',
    why: 'shown by the About screen; the relay sends using its own copy',
  },
];

const ENVIRONMENT = 'production';

/** `KEY=value` lines, `#` comments, no quote handling -- which is all this project's .env uses. */
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

/**
 * Turns the declaration above into one `eas env:set` argv per variable, or throws listing every
 * source that is missing. Pure apart from `exists`, so the plan can be tested without the files.
 */
function plan({ variables = VARIABLES, env = {}, root = ROOT, exists = fs.existsSync } = {}) {
  const missing = [];
  const steps = [];

  for (const variable of variables) {
    let value = null;
    if (variable.from === 'env') {
      const found = env[variable.name];
      if (typeof found === 'string' && found.trim() !== '') value = found.trim();
      else missing.push(`${variable.name} (no value in .env)`);
    } else {
      const absolute = path.isAbsolute(variable.source)
        ? variable.source
        : path.join(root, variable.source);
      if (exists(absolute)) value = absolute;
      else missing.push(`${variable.name} (no file at ${variable.source})`);
    }
    if (value === null) continue;

    steps.push({
      name: variable.name,
      value,
      visibility: variable.visibility,
      why: variable.why,
      // --force is deliberately absent: overwriting a variable someone set by hand should be a
      // decision, not a side effect of re-running this.
      argv: [
        'env:set',
        '--name',
        variable.name,
        '--value',
        value,
        '--type',
        variable.type,
        '--visibility',
        variable.visibility,
        '--scope',
        'project',
        '--environment',
        ENVIRONMENT,
        '--non-interactive',
      ],
    });
  }

  if (missing.length > 0) {
    throw new Error(`cannot configure EAS: missing ${missing.join('; ')}`);
  }
  return steps;
}

/** Plaintext values are configuration and worth showing; anything else is not. */
function display(step) {
  return step.visibility === 'plaintext' ? step.value : '<redacted>';
}

/**
 * How to run eas-cli without a shell.
 *
 * `execFileSync('npx', ...)` fails with ENOENT on Windows, where npx is `npx.cmd`, and Node refuses
 * to spawn `.cmd` without `shell: true` (CVE-2024-27980). Using a shell would put these values back
 * on a command line, which is the one thing this script exists to avoid -- `SUPPORT_FROM` contains
 * `<` and `>`. So npm's own `npx-cli.js` is run with this process's node binary instead: no shell,
 * argv passed through untouched.
 */
function npxCommand() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { file: process.execPath, prefix: [candidate] };
  }
  // No npx-cli.js to be found. `npx` itself may still work where it is not a .cmd shim.
  return { file: 'npx', prefix: [] };
}

module.exports = { parseEnv, plan, VARIABLES, ENVIRONMENT };

if (require.main === module) {
  const apply = process.argv.includes('--apply');

  const env = fs.existsSync(ENV_FILE) ? parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) : {};
  let steps;
  try {
    steps = plan({ env });
  } catch (error) {
    console.error(`eas-env: ${error instanceof Error ? error.message : String(error)}`);
    console.error('');
    console.error('  Every value comes from .env or config/firebase/. Fill those in first;');
    console.error('  see docs/building.md and docs/firebase-setup.md.');
    process.exit(1);
  }

  console.log(`${apply ? 'setting' : 'would set'} ${String(steps.length)} variables in the`);
  console.log(`EAS "${ENVIRONMENT}" environment, project scope:\n`);
  for (const step of steps) {
    console.log(`  ${step.name.padEnd(24)} ${display(step)}`);
    console.log(`  ${''.padEnd(24)} ${step.visibility} -- ${step.why}`);
  }
  console.log('');

  if (!apply) {
    console.log('Nothing was changed. Re-run with --apply once `eas whoami` can read the project:');
    console.log('  npm run eas:env -- --apply');
    process.exit(0);
  }

  const npx = npxCommand();
  let done = 0;
  for (const step of steps) {
    process.stdout.write(`${step.name} ... `);
    try {
      // Both streams are captured and shown only on failure: eas-cli puts the substance of an error
      // ("Entity not authorized: AppEntity[...]") on stdout and only "GraphQL request failed" on
      // stderr, so discarding stdout loses the one line that says what went wrong.
      execFileSync(npx.file, [...npx.prefix, '--yes', 'eas-cli@latest', ...step.argv], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      console.log('set');
      done += 1;
    } catch (error) {
      console.log('FAILED');
      // stderr carries EAS's own wording, which is worth seeing, and cannot contain the value: that
      // went in as argv and EAS does not echo it back. A spawn failure has no stderr at all, so the
      // error's own message stands in -- otherwise this printed `undefined` and said nothing.
      const streams = [String((error && error.stdout) || ''), String((error && error.stderr) || '')]
        .join('\n')
        .trim();
      // A spawn failure has neither stream, so the error's own message stands in -- otherwise this
      // printed `undefined` and said nothing at all.
      const detail = streams !== '' ? streams : String((error && error.message) || error);
      console.error(
        detail
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line !== '')
          .slice(0, 8)
          .join('\n'),
      );
      console.error('');
      console.error(
        done === 0
          ? `eas-env: stopped at ${step.name}. Nothing was set.`
          : `eas-env: stopped at ${step.name}. The ${String(done)} before it were set.`,
      );
      process.exit(1);
    }
  }
  console.log('\nDone. `eas env:list production` shows what the project now has.');
}
