import {
  exportToGallery,
  galleryFileExtension,
  galleryFileName,
  type GalleryExportDeps,
} from '@/gallery/galleryExport';
import type { PhotoEntry } from '@/vault/types';

function entry(overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  return {
    id: 'a'.repeat(32),
    createdAt: 1_700_000_000_000,
    width: 100,
    height: 200,
    sizeBytes: 4,
    source: 'camera',
    mimeType: 'image/jpeg',
    originalName: null,
    durationMs: null,
    ...overrides,
  };
}

interface Harness {
  deps: GalleryExportDeps;
  released: string[];
  allocated: string[];
  saved: string[];
  written: Map<string, Uint8Array>;
  streamed: string[];
}

function harness(
  overrides: {
    grant?: boolean;
    save?: (uri: string) => Promise<void>;
    readFullImage?: (id: string) => Promise<Uint8Array>;
  } = {},
): Harness {
  const released: string[] = [];
  const allocated: string[] = [];
  const saved: string[] = [];
  const written = new Map<string, Uint8Array>();
  const streamed: string[] = [];
  let counter = 0;

  const deps: GalleryExportDeps = {
    repository: {
      readFullImage:
        overrides.readFullImage ?? (() => Promise.resolve(new Uint8Array([1, 2, 3, 4]))),
      readVideoToFile: (id, target) => {
        streamed.push(`${id}->${target}`);
        return Promise.resolve();
      },
    },
    scratch: {
      // Mirrors the real one: a random directory, the caller's file name inside it.
      allocateNamed: (fileName: string) => {
        counter += 1;
        const uri = `file:///cache/playback/dir${String(counter)}/${fileName}`;
        allocated.push(uri);
        return Promise.resolve(uri);
      },
      release: (uri) => {
        released.push(uri);
        return Promise.resolve();
      },
    },
    fs: {
      writeBytes: (uri, bytes) => {
        written.set(uri, bytes);
        return Promise.resolve();
      },
    },
    writer: {
      requestWriteAccess: () => Promise.resolve(overrides.grant ?? true),
      save:
        overrides.save ??
        ((uri) => {
          saved.push(uri);
          return Promise.resolve();
        }),
    },
  };

  return { deps, released, allocated, saved, written, streamed };
}

describe('gallery file extension', () => {
  it('names the file after its media type, because MediaStore types the asset from the extension', () => {
    expect(galleryFileExtension('image/jpeg')).toBe('jpg');
    expect(galleryFileExtension('image/png')).toBe('png');
    expect(galleryFileExtension('video/mp4')).toBe('mp4');
  });

  it('falls back to the subtype rather than inventing one', () => {
    expect(galleryFileExtension('image/webp')).toBe('webp');
    expect(galleryFileExtension('video/quicktime')).toBe('quicktime');
  });

  it('never returns an empty or path-bearing extension', () => {
    expect(galleryFileExtension('')).toBe('bin');
    expect(galleryFileExtension('nonsense')).toBe('bin');
    expect(galleryFileExtension('image/svg+xml; charset=utf-8')).toBe('svg');
  });
});

describe('the name an exported item carries in the gallery', () => {
  it('gives the item back the name it arrived with', () => {
    expect(galleryFileName(entry({ originalName: 'beach-day.jpg' }))).toBe('beach-day.jpg');
  });

  it('re-extends from the media type rather than trusting the old extension', () => {
    expect(galleryFileName(entry({ originalName: 'holiday.HEIC' }))).toBe('holiday.jpg');
    expect(
      galleryFileName(entry({ originalName: 'clip.avi', mimeType: 'video/mp4' })),
    ).toBe('clip.mp4');
  });

  it('keeps a directory part from surviving as a path', () => {
    const name = galleryFileName(entry({ originalName: '../../etc/passwd.jpg' }));
    expect(name).toBe('passwd.jpg');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('replaces characters that have no business in a file name', () => {
    expect(galleryFileName(entry({ originalName: 'my photo*?:"<>|.jpg' }))).toBe('my_photo_.jpg');
  });

  it('falls back to a camera-style name when the vault never knew one', () => {
    expect(galleryFileName(entry({ originalName: null }))).toMatch(/^IMG_\d{8}_\d{6}\.jpg$/);
    expect(galleryFileName(entry({ originalName: '' }))).toMatch(/^IMG_\d{8}_\d{6}\.jpg$/);
    // A name made entirely of stripped characters is no name at all.
    expect(galleryFileName(entry({ originalName: '...jpg' }))).toMatch(/^IMG_\d{8}_\d{6}\.jpg$/);
  });

  it('uses the video extension in the fallback too', () => {
    expect(galleryFileName(entry({ mimeType: 'video/mp4', originalName: null }))).toMatch(
      /^IMG_\d{8}_\d{6}\.mp4$/,
    );
  });

  it('never names the app, which would undo the disguise from inside the gallery', () => {
    for (const original of [null, 'holiday.jpg', 'x'.repeat(200)]) {
      expect(galleryFileName(entry({ originalName: original })).toLowerCase()).not.toContain(
        'silentsum',
      );
    }
  });

  it('caps a pathological name instead of handing the filesystem a novel', () => {
    const name = galleryFileName(entry({ originalName: `${'a'.repeat(500)}.jpg` }));
    expect(name.length).toBeLessThanOrEqual(68);
    expect(name.endsWith('.jpg')).toBe(true);
  });
});

describe('exporting an item to the device gallery', () => {
  it('decrypts a photo to a scratch file and hands that file to the gallery', async () => {
    const h = harness();

    await expect(exportToGallery(entry({ originalName: 'beach.jpg' }), h.deps)).resolves.toBe(
      'saved',
    );

    expect(h.allocated).toEqual(['file:///cache/playback/dir1/beach.jpg']);
    expect(h.written.get('file:///cache/playback/dir1/beach.jpg')).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(h.saved).toEqual(['file:///cache/playback/dir1/beach.jpg']);
  });

  it('names an unnamed photo after its capture time, not after the vault id', async () => {
    const h = harness();

    await exportToGallery(entry(), h.deps);

    expect(h.saved[0]).toMatch(/\/IMG_\d{8}_\d{6}\.jpg$/);
    // The 32-character hex vault id must not reach the user's gallery.
    expect(h.saved[0]).not.toMatch(/[0-9a-f]{32}/);
  });

  it('streams a video to the scratch file instead of loading it into memory', async () => {
    const h = harness();
    const video = entry({ mimeType: 'video/mp4', durationMs: 5000, originalName: 'clip.mp4' });

    await expect(exportToGallery(video, h.deps)).resolves.toBe('saved');

    expect(h.streamed).toEqual([`${video.id}->file:///cache/playback/dir1/clip.mp4`]);
    expect(h.written.size).toBe(0);
    expect(h.saved).toEqual(['file:///cache/playback/dir1/clip.mp4']);
  });

  it('releases the plaintext once the gallery has it', async () => {
    const h = harness();

    await exportToGallery(entry(), h.deps);

    expect(h.released).toEqual(h.allocated);
  });

  it('releases the plaintext even when the save fails', async () => {
    const h = harness({ save: () => Promise.reject(new Error('no space')) });

    await expect(exportToGallery(entry(), h.deps)).resolves.toBe('failed');

    expect(h.released).toEqual(h.allocated);
  });

  it('releases the plaintext even when the decrypt fails', async () => {
    const h = harness({ readFullImage: () => Promise.reject(new Error('corrupt')) });

    await expect(exportToGallery(entry(), h.deps)).resolves.toBe('failed');

    expect(h.released).toEqual(h.allocated);
  });

  it('asks before decrypting, so a refusal never puts plaintext on disk', async () => {
    const h = harness({ grant: false });

    await expect(exportToGallery(entry(), h.deps)).resolves.toBe('denied');

    expect(h.allocated).toEqual([]);
    expect(h.written.size).toBe(0);
    expect(h.saved).toEqual([]);
  });
});
