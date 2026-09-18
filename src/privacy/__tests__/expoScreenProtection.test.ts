/**
 * expo-screen-capture is replaced by a mutable fake so a test can make it throw, reject, or lose
 * its functions entirely (which is what `require`ing the module looks like when the native side is
 * missing from the running binary).
 */
import { ExpoScreenProtection, SCREEN_CAPTURE_KEY } from '@/privacy/expoScreenProtection';
import type { ScreenProtection } from '@/privacy/types';

const mockPrevent = jest.fn(async (_key?: string): Promise<void> => {});
const mockAllow = jest.fn(async (_key?: string): Promise<void> => {});
const mockScreenCapture: {
  preventScreenCaptureAsync?: (key?: string) => Promise<void>;
  allowScreenCaptureAsync?: (key?: string) => Promise<void>;
} = {};

jest.mock('expo-screen-capture', () => mockScreenCapture);

describe('ExpoScreenProtection', () => {
  let protection: ScreenProtection;

  beforeEach(() => {
    mockPrevent.mockReset();
    mockAllow.mockReset();
    mockPrevent.mockImplementation(async () => {});
    mockAllow.mockImplementation(async () => {});
    mockScreenCapture.preventScreenCaptureAsync = mockPrevent;
    mockScreenCapture.allowScreenCaptureAsync = mockAllow;
    protection = new ExpoScreenProtection();
  });

  it('prevents capture when secured', async () => {
    await protection.setSecure(true);
    expect(mockPrevent).toHaveBeenCalledWith(SCREEN_CAPTURE_KEY);
    expect(mockAllow).not.toHaveBeenCalled();
  });

  it('allows capture again when unsecured', async () => {
    await protection.setSecure(false);
    expect(mockAllow).toHaveBeenCalledWith(SCREEN_CAPTURE_KEY);
    expect(mockPrevent).not.toHaveBeenCalled();
  });

  it('uses one reservation key for both directions, so the pair cancels out', async () => {
    await protection.setSecure(true);
    await protection.setSecure(false);
    expect(mockPrevent.mock.calls).toEqual(mockAllow.mock.calls);
  });

  it('swallows a native module that throws synchronously', async () => {
    mockPrevent.mockImplementation(() => {
      throw new Error('Cannot find native module ExpoScreenCapture');
    });
    await expect(protection.setSecure(true)).resolves.toBeUndefined();
  });

  it('swallows a native module that rejects', async () => {
    mockPrevent.mockImplementation(() =>
      Promise.reject(new Error('UnavailabilityError: ScreenCapture.preventScreenCaptureAsync')),
    );
    await expect(protection.setSecure(true)).resolves.toBeUndefined();
  });

  it('swallows a failure on the way back out of secure mode', async () => {
    mockAllow.mockImplementation(() => Promise.reject(new Error('nope')));
    await expect(protection.setSecure(false)).resolves.toBeUndefined();
  });

  it.each([true, false])('swallows a module with no such function (secure=%s)', async (enabled) => {
    delete mockScreenCapture.preventScreenCaptureAsync;
    delete mockScreenCapture.allowScreenCaptureAsync;
    await expect(protection.setSecure(enabled)).resolves.toBeUndefined();
  });

  it('keeps working after a failure', async () => {
    mockPrevent.mockImplementationOnce(() => Promise.reject(new Error('transient')));
    await protection.setSecure(true);
    await protection.setSecure(true);
    expect(mockPrevent).toHaveBeenCalledTimes(2);
  });
});
