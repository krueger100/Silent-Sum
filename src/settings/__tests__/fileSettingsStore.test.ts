/**
 * The expo-file-system native module is replaced by an in-memory fake; no real file is ever
 * touched. `mockFiles` maps a file URI to its contents, `mockFailures` lets a test make a read or
 * a write blow up the way a damaged file or a full disk would.
 */
import { FileSettingsStore, SETTINGS_FILE_NAME } from '@/settings/fileSettingsStore';
import { DEFAULT_SETTINGS, type AppSettings } from '@/settings/settingsStore';

const mockFiles = new Map<string, string>();
const mockFailures: { read: Error | null; write: Error | null } = { read: null, write: null };

// Hoisted above the imports by babel-plugin-jest-hoist. The factory only closes over `mockFiles`
// and `mockFailures` from inside methods, so their initialisation order does not matter.
jest.mock('expo-file-system', () => {
  const documentUri = 'file:///documents';

  class MockFile {
    readonly uri: string;

    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }

    get exists(): boolean {
      return mockFiles.has(this.uri);
    }

    create(_options?: unknown): void {
      if (mockFailures.write) throw mockFailures.write;
      mockFiles.set(this.uri, '');
    }

    write(content: string): void {
      if (mockFailures.write) throw mockFailures.write;
      mockFiles.set(this.uri, content);
    }

    async text(): Promise<string> {
      if (mockFailures.read) throw mockFailures.read;
      const value = mockFiles.get(this.uri);
      if (value === undefined) throw new Error('file not found');
      return value;
    }

    delete(): void {
      if (!mockFiles.delete(this.uri)) throw new Error('file not found');
    }

    moveSync(destination: { uri: string }, _options?: unknown): void {
      const value = mockFiles.get(this.uri);
      if (value === undefined) throw new Error('file not found');
      mockFiles.delete(this.uri);
      mockFiles.set(destination.uri, value);
    }
  }

  return {
    File: MockFile,
    Paths: {
      get document() {
        return { uri: documentUri };
      },
    },
  };
});

const SETTINGS_URI = `file:///documents/${SETTINGS_FILE_NAME}`;
const TEMP_URI = `${SETTINGS_URI}.tmp`;

const CUSTOM: AppSettings = {
  autoLockTimeout: 'fiveMinutes',
  screenProtection: false,
  superSecure: true,
  theme: 'day',
  analyticsEnabled: true,
  crashReportsEnabled: false,
  onboardingDone: true,
  backupEnabled: true,
  lastBackupAt: Date.UTC(2026, 8, 14, 9, 0, 0, 0),
};

describe('FileSettingsStore', () => {
  let store: FileSettingsStore;

  beforeEach(() => {
    mockFiles.clear();
    mockFailures.read = null;
    mockFailures.write = null;
    store = new FileSettingsStore();
  });

  it('stores one small JSON file named after the storage key', async () => {
    expect(SETTINGS_FILE_NAME).toBe('silentsum.settings.v1.json');
    await store.save(CUSTOM);
    expect([...mockFiles.keys()]).toEqual([SETTINGS_URI]);
  });

  it('round-trips every field through the file', async () => {
    await store.save(CUSTOM);
    await expect(store.load()).resolves.toEqual(CUSTOM);
  });

  it('round-trips repeated saves, overwriting the previous record', async () => {
    await store.save(CUSTOM);
    await store.save(DEFAULT_SETTINGS);
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
    expect([...mockFiles.keys()]).toEqual([SETTINGS_URI]);
  });

  it('leaves no temp file behind', async () => {
    await store.save(CUSTOM);
    expect(mockFiles.has(TEMP_URI)).toBe(false);
  });

  it('loads the defaults when no file was ever written', async () => {
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ['an empty file', ''],
    ['truncated JSON', '{"autoLockTimeout":"fiveMinut'],
    ['not JSON at all', 'PNG garbage'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON null', 'null'],
  ])('loads the defaults when the file holds %s', async (_label, contents) => {
    mockFiles.set(SETTINGS_URI, contents);
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('never rejects when the file cannot be read at all', async () => {
    mockFiles.set(SETTINGS_URI, JSON.stringify({ onboardingDone: true }));
    mockFailures.read = new Error('EACCES: permission denied');
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('never rejects when the native module is unavailable', async () => {
    mockFailures.read = new Error('Cannot find native module ExpoFileSystem');
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the previous record when a write fails mid-save', async () => {
    await store.save(CUSTOM);
    mockFailures.write = new Error('ENOSPC: no space left on device');
    await expect(store.save(DEFAULT_SETTINGS)).rejects.toThrow('ENOSPC');
    mockFailures.write = null;
    await expect(store.load()).resolves.toEqual(CUSTOM);
  });

  it('returns to the defaults after clear', async () => {
    await store.save(CUSTOM);
    await store.clear();
    expect(mockFiles.size).toBe(0);
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('treats clearing an absent record as a no-op', async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('removes a stray temp file on clear', async () => {
    mockFiles.set(TEMP_URI, '{"onboardingDone":true}');
    await store.clear();
    expect(mockFiles.size).toBe(0);
  });
});
