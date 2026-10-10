/**
 * Which builds print recovery diagnostics, and which stay silent.
 *
 * The gate used to be `__DEV__`, which is false in the one artifact this project actually tests
 * recovery with: a dev-environment RELEASE apk, built with `SILENTSUM_ENV=dev ./gradlew
 * assembleRelease` and installed on the emulator so it talks to real Firebase. The logging was
 * therefore present in Metro, where recovery against a real account is awkward to exercise, and
 * stripped from the build it was written for. These tests pin the replacement: the build's own
 * environment flag decides, and the debug/release distinction does not enter into it.
 *
 * Nothing here asserts on message text beyond the prefix. The secret-safety rule for this module
 * is enforced by what callers pass -- literals and codes -- and is stated in its docstring; a test
 * that asserted the absence of a secret from a string would be testing the test.
 */
import type * as RecoveryTraceNamespace from '@/messaging/recoveryTrace';
import { keyFingerprint, recoveryTracingEnabled } from '@/messaging/recoveryTrace';

type Trace = typeof RecoveryTraceNamespace;

/** Re-imports the module so the `extra` installed here is the one it reads. */
function loadTraceWith(extra: Record<string, unknown>): Trace {
  jest.resetModules();
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { extra } },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/messaging/recoveryTrace') as Trace;
}

const warn = jest.spyOn(console, 'warn');

beforeEach(() => {
  warn.mockReset();
  warn.mockImplementation(() => undefined);
});

afterAll(() => {
  warn.mockRestore();
});

describe('recoveryTracingEnabled', () => {
  /**
   * `app.config.ts` writes this flag from `SILENTSUM_ENV` and knows nothing about whether the
   * artifact is debug or release. That is exactly why it is the right gate.
   */
  it('traces a dev build', () => {
    expect(recoveryTracingEnabled('dev')).toBe(true);
  });

  it('is silent in prod', () => {
    expect(recoveryTracingEnabled('prod')).toBe(false);
  });

  /** Fail closed: a build whose flag cannot be read is treated as the one that must not talk. */
  it('is silent for anything it does not recognise', () => {
    for (const raw of [undefined, null, '', 'DEV', 'Dev', 'development', 0, 1, true, {}, ['dev']]) {
      expect(recoveryTracingEnabled(raw)).toBe(false);
    }
  });
});

describe('traceRecovery', () => {
  it('writes one prefixed line per stage in a dev build', () => {
    const trace = loadTraceWith({ silentsumEnv: 'dev' });

    trace.traceRecovery('escrow-absent');
    trace.traceRecovery('key-mismatched', 'permission-denied');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, '[silentsum/recovery] escrow-absent');
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[silentsum/recovery] key-mismatched: permission-denied',
    );
  });

  /**
   * THE REGRESSION. A dev-environment release apk has `__DEV__` false, and under the old gate
   * printed nothing at all. If this test fails, the diagnostics are missing from the only build
   * that can reach a real account.
   */
  it('still traces a dev build when __DEV__ is false, which is the release apk', () => {
    const globals = globalThis as { __DEV__?: boolean };
    const before = globals.__DEV__;
    globals.__DEV__ = false;
    try {
      loadTraceWith({ silentsumEnv: 'dev' }).traceRecovery('applied');
      expect(warn).toHaveBeenCalledWith('[silentsum/recovery] applied');
    } finally {
      globals.__DEV__ = before;
    }
  });

  /** And the converse: a prod build stays silent even where `__DEV__` would have said yes. */
  it('stays silent in a prod build whatever __DEV__ says', () => {
    const globals = globalThis as { __DEV__?: boolean };
    const before = globals.__DEV__;
    globals.__DEV__ = true;
    try {
      loadTraceWith({ silentsumEnv: 'prod' }).traceRecovery('applied');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      globals.__DEV__ = before;
    }
  });

  it('stays silent when the build has no environment flag at all', () => {
    loadTraceWith({}).traceRecovery('escrow-read', 'abcd1234…');
    expect(warn).not.toHaveBeenCalled();
  });

  /** Reading the flag is not allowed to be the thing that breaks a recovery. */
  it('stays silent, rather than throwing, when the config cannot be read', () => {
    jest.resetModules();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: {
        get expoConfig(): never {
          throw new Error('no config');
        },
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const trace = require('@/messaging/recoveryTrace') as Trace;

    expect(() => {
      trace.traceRecovery('applied');
    }).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('keyFingerprint', () => {
  /** Short enough to be useless as key material, long enough to tell two published keys apart. */
  it('gives a short prefix of a public key', () => {
    expect(keyFingerprint('QUJDREVGR0hJSktMTU5PUA==')).toBe('QUJDREVG…');
  });

  it('names the absence of a key instead of printing an empty prefix', () => {
    expect(keyFingerprint(null)).toBe('(none)');
    expect(keyFingerprint('')).toBe('(none)');
  });
});
