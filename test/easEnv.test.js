/**
 * The EAS environment variables a production build needs but git does not carry.
 *
 * The thing worth testing is that the plan is a CLOSED list built from files that already hold the
 * values, and that a missing source stops it. The failure being prevented is quiet: a build with no
 * Firebase config succeeds and ships an app with no cloud features, so "it didn't complain" is not
 * evidence of anything.
 *
 * JavaScript because the subject is a CommonJS script; `tsconfig.json` only includes `.ts`/`.tsx`.
 */
const path = require('path');

const { ENVIRONMENT, VARIABLES, parseEnv, plan } = require('../scripts/eas-env');

const ROOT = '/project';
const GOOGLE_SERVICES = path.join(ROOT, 'config', 'firebase', 'google-services.prod.json');

const ENV = {
  FIREBASE_STORAGE_BUCKET: 'silentsum-vault-eevee-mate',
  SUPPORT_ENDPOINT: 'https://us-central1-example.cloudfunctions.net/silentsumSupportRelay',
  SUPPORT_FROM: 'Calculator <support@example.com>',
  SUPPORT_TO: 'support@example.com',
};

const exists = (file) => path.resolve(file) === path.resolve(GOOGLE_SERVICES);

function build(overrides = {}) {
  return plan({ env: ENV, root: ROOT, exists, ...overrides });
}

function stepFor(steps, name) {
  const step = steps.find((s) => s.name === name);
  if (step === undefined) throw new Error(`no step for ${name}`);
  return step;
}

describe('parseEnv', () => {
  it('reads KEY=value and ignores comments and blanks', () => {
    expect(parseEnv('# note\n\nA=1\n  B = two \n')).toEqual({ A: '1', B: 'two' });
  });

  it('keeps a value containing an equals sign', () => {
    expect(parseEnv('URL=https://x/y?a=b')).toEqual({ URL: 'https://x/y?a=b' });
  });
});

describe('plan', () => {
  it('covers every declared variable and nothing more', () => {
    const steps = build();
    expect(steps.map((s) => s.name).sort()).toEqual(VARIABLES.map((v) => v.name).sort());
  });

  it('targets the production environment at project scope, non-interactively', () => {
    for (const step of build()) {
      expect(step.argv[0]).toBe('env:set');
      expect(step.argv).toEqual(expect.arrayContaining(['--environment', ENVIRONMENT]));
      expect(step.argv).toEqual(expect.arrayContaining(['--scope', 'project']));
      expect(step.argv).toContain('--non-interactive');
    }
  });

  /**
   * `env:create` is deprecated in favour of `env:set`, and `--force` would overwrite a variable
   * someone set by hand as a side effect of re-running this.
   */
  it('uses env:set and never --force', () => {
    for (const step of build()) {
      expect(step.argv).not.toContain('env:create');
      expect(step.argv).not.toContain('--force');
    }
  });

  it('sends the Firebase config as a file, by absolute path', () => {
    const step = stepFor(build(), 'GOOGLE_SERVICES_JSON');
    expect(step.argv).toEqual(expect.arrayContaining(['--type', 'file']));
    expect(path.isAbsolute(step.value)).toBe(true);
    expect(path.resolve(step.value)).toBe(path.resolve(GOOGLE_SERVICES));
  });

  it('keeps the Firebase config out of plaintext, and the rest in it', () => {
    const steps = build();
    expect(stepFor(steps, 'GOOGLE_SERVICES_JSON').visibility).toBe('sensitive');
    for (const name of [
      'FIREBASE_STORAGE_BUCKET',
      'SUPPORT_ENDPOINT',
      'SUPPORT_FROM',
      'SUPPORT_TO',
    ]) {
      expect(stepFor(steps, name).visibility).toBe('plaintext');
    }
  });

  /**
   * The reason this is a script. `<` and `>` are shell redirection, so this value cannot be pasted
   * into a command line unquoted; passed as argv it needs no quoting at all.
   */
  it('passes an address-shaped value through untouched', () => {
    const step = stepFor(build(), 'SUPPORT_FROM');
    expect(step.value).toBe('Calculator <support@example.com>');
    expect(step.argv[step.argv.indexOf('--value') + 1]).toBe('Calculator <support@example.com>');
  });

  it('refuses when the Firebase config is not there, and says which file', () => {
    expect(() => build({ exists: () => false })).toThrow(/google-services\.prod\.json/);
  });

  it('refuses when a .env value is missing or blank, naming it', () => {
    expect(() => build({ env: { ...ENV, SUPPORT_TO: '' } })).toThrow(/SUPPORT_TO/);
    const { SUPPORT_ENDPOINT: _omitted, ...withoutEndpoint } = ENV;
    expect(() => build({ env: withoutEndpoint })).toThrow(/SUPPORT_ENDPOINT/);
  });

  it('reports every missing source at once, not one per run', () => {
    const error = (() => {
      try {
        build({ env: {}, exists: () => false });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).not.toBeNull();
    for (const variable of VARIABLES) expect(error.message).toContain(variable.name);
  });

  it('plans nothing at all when anything is missing', () => {
    // Half-configuring EAS is worse than not starting: the build would still be wrong, with fewer
    // clues about why.
    expect(() => build({ env: { ...ENV, SUPPORT_TO: '' } })).toThrow();
  });
});
