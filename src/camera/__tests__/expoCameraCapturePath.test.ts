/**
 * The camera has to be the camera.
 *
 * `expo-camera` 57.0.5 answers `takePicture` on any Android emulator without going near CameraX:
 * `CameraViewModule` calls `CameraViewHelper.generateSimulatorPhoto(view.width, view.height)`,
 * which paints a black rectangle the size of the preview view, stamps a small yellow timestamp in
 * the bottom-left corner and returns it as a PNG. The preview stays live throughout, so the app
 * looks like it is taking photographs while every still is a placeholder -- and for a vault that
 * holds the only copy of an image, storing one is a silently lost photo.
 *
 * `patches/expo-camera+57.0.5.patch` removes that substitution so the emulator captures through
 * the same CameraX `ImageCapture` path as a phone, and rejects the promise (instead of leaving it
 * unsettled) when no camera is bound. `postinstall` reapplies it; this test fails if an install
 * ever silently drops it, which would put the placeholder back without any visible error.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

function moduleSource(file: string): string {
  const root = dirname(require.resolve('expo-camera/package.json'));
  return readFileSync(join(root, 'android/src/main/java/expo/modules/camera', file), 'utf8');
}

describe('the patched expo-camera capture path', () => {
  it('never substitutes a generated image for a capture', () => {
    const source = moduleSource('CameraViewModule.kt');
    const block = /AsyncFunction\("takePicture"\)[\s\S]*?\}\.runOnQueue/.exec(source)?.[0];
    // Comments are free to name what was removed; only the code is asserted on.
    const code = block?.replace(/\/\/.*/g, '');

    expect(block).toBeDefined();
    expect(code).toContain('view.takePicture(options, promise, cacheDirectory');
    // The two halves of the upstream substitution, either of which brings the placeholder back.
    expect(code).not.toContain('isRunningOnEmulator');
    expect(code).not.toContain('generateSimulatorPhoto');
  });

  it('settles the promise when there is no camera to capture from', () => {
    const source = moduleSource('ExpoCameraView.kt');
    // `imageCaptureUseCase?.takePicture(...)` does nothing at all when the use case is null, and
    // the shutter would hang forever rather than report a failure.
    expect(source).not.toContain('imageCaptureUseCase?.takePicture(');
    expect(source).toContain('promise.reject(CameraExceptions.ImageCaptureFailed())');
  });
});
