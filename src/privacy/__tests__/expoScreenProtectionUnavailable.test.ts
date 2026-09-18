/**
 * The extreme case, in its own file so it gets its own module registry: `require('expo-screen-capture')`
 * itself blows up. This is what proves the require is lazy AND inside the try -- a top-level import
 * would take the whole module down at import time, long before any try/catch could help.
 */
import { ExpoScreenProtection } from '@/privacy/expoScreenProtection';

jest.mock('expo-screen-capture', () => {
  throw new Error('Cannot find native module ExpoScreenCapture');
});

describe('ExpoScreenProtection with an unloadable native module', () => {
  it('really cannot load the module (guards against a vacuous suite)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(() => require('expo-screen-capture')).toThrow('Cannot find native module');
  });

  it('imports without throwing', () => {
    expect(() => new ExpoScreenProtection()).not.toThrow();
  });

  it.each([true, false])('resolves instead of rejecting (secure=%s)', async (enabled) => {
    await expect(new ExpoScreenProtection().setSecure(enabled)).resolves.toBeUndefined();
  });
});
