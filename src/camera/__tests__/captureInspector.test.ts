import { encode } from 'jpeg-js';

import {
  isBlankFrame,
  measureFrame,
  readJpegFrameHeader,
  ScriptedCaptureInspector,
} from '@/camera/captureInspector';

/** A real JPEG of the given size, every pixel the same colour. */
function solidJpeg(width: number, height: number, value: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return new Uint8Array(encode({ data, width, height }, 90).data);
}

describe('readJpegFrameHeader', () => {
  it('reads the dimensions of a real JPEG', () => {
    expect(readJpegFrameHeader(solidJpeg(64, 48, 0))).toEqual({ width: 64, height: 48 });
  });

  it('rejects a file that is not a JPEG', () => {
    expect(readJpegFrameHeader(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
  });

  it('rejects a PNG, whatever its extension says', () => {
    // The shape of the placeholder expo-camera used to return from an emulator capture: a PNG
    // written to a .jpg in the plugin's cache. See src/camera/__tests__/expoCameraCapturePath.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x05, 0x40, 0x00, 0x00, 0x07, 0x7c, 0x08, 0x06,
    ]);
    expect(readJpegFrameHeader(png)).toBeNull();
  });

  it('rejects a truncated capture: the header survives, the end-of-image marker does not', () => {
    const whole = solidJpeg(64, 48, 128);
    expect(readJpegFrameHeader(whole.subarray(0, whole.length - 64))).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(readJpegFrameHeader(new Uint8Array(0))).toBeNull();
  });
});

describe('measureFrame', () => {
  it('reports nothing for an all-black frame', () => {
    expect(measureFrame(new Uint8Array(300), 3)).toEqual({ peak: 0, mean: 0, litFraction: 0 });
  });

  it('finds a single bright pixel in an otherwise black frame', () => {
    const pixels = new Uint8Array(300);
    pixels[150] = 200;
    pixels[151] = 200;
    pixels[152] = 200;
    const stats = measureFrame(pixels, 3);
    expect(stats.peak).toBeCloseTo(200, 0);
    expect(stats.litFraction).toBeCloseTo(0.01, 2);
  });
});

describe('isBlankFrame', () => {
  it('calls an all-black frame blank', () => {
    expect(isBlankFrame({ peak: 0, mean: 0, litFraction: 0 })).toBe(true);
  });

  it('calls a black frame with a few stray lit pixels blank', () => {
    // Measured from a capture taken on an Android 36 emulator: one bright speck over a frame with
    // no picture in it. A peak-only test would have let it through.
    expect(isBlankFrame({ peak: 226, mean: 0.06, litFraction: 0.0007 })).toBe(true);
  });

  it("calls expo-camera's emulator placeholder blank", () => {
    // Decoded on the host from the exact bytes takePictureAsync returned (1344x1916, 28122 B)
    // while the preview showed a live webcam image. It was not a capture at all: the plugin
    // painted black and stamped a yellow timestamp in the corner, which is the 0.10% that is lit.
    expect(isBlankFrame({ peak: 227, mean: 0.18, litFraction: 0.001 })).toBe(true);
  });

  it('keeps a real photograph', () => {
    // Measured from a still the stock camera app took on that same emulator.
    expect(isBlankFrame({ peak: 231, mean: 152.89, litFraction: 0.977 })).toBe(false);
  });

  it('keeps a genuinely dark photograph that is still lit', () => {
    expect(isBlankFrame({ peak: 120, mean: 9, litFraction: 0.2 })).toBe(false);
  });
});

describe('ScriptedCaptureInspector', () => {
  it('rejects the scripted number of captures and then accepts', async () => {
    const inspector = new ScriptedCaptureInspector(2);
    expect(await inspector.inspect()).toEqual({ ok: false, reason: 'blank' });
    expect(await inspector.inspect()).toEqual({ ok: false, reason: 'blank' });
    expect(await inspector.inspect()).toEqual({ ok: true });
  });
});
