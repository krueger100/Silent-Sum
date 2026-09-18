import {
  AUTO_LOCK_DURATION_MS,
  AUTO_LOCK_TIMEOUTS,
  autoLockTimeoutFromName,
} from '@/settings/appSettings';
import {
  DEFAULT_SETTINGS,
  InMemorySettingsStore,
  SETTINGS_STORAGE_KEY,
  decodeSettings,
  encodeSettings,
  type AppSettings,
} from '@/settings/settingsStore';

describe('default settings', () => {
  it('are the strict end of every setting', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      autoLockTimeout: 'oneMinute',
      screenProtection: true,
      // Off: a first-run user has to be able to find the vault at all.
      superSecure: false,
      // Night: it is what every screen was designed against.
      theme: 'night',
      analyticsEnabled: false,
      crashReportsEnabled: true,
      onboardingDone: false,
      backupEnabled: false,
      lastBackupAt: null,
    });
  });

  it('auto-locks after one minute', () => {
    expect(AUTO_LOCK_DURATION_MS[DEFAULT_SETTINGS.autoLockTimeout]).toBe(60_000);
  });

  it('keeps the storage key stable across versions', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('silentsum.settings.v1');
  });
});

describe('settings codec', () => {
  const stored: AppSettings = {
    autoLockTimeout: 'fifteenMinutes',
    screenProtection: false,
    superSecure: true,
    theme: 'day',
    analyticsEnabled: true,
    crashReportsEnabled: false,
    onboardingDone: true,
    backupEnabled: true,
    lastBackupAt: Date.UTC(2026, 8, 14, 10, 30, 0, 123),
  };

  it('round-trips every field', () => {
    expect(decodeSettings(encodeSettings(stored))).toEqual(stored);
  });

  it('round-trips the defaults', () => {
    expect(decodeSettings(encodeSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  it('writes lastBackupAt as ISO-8601 UTC so the Flutter build can read it', () => {
    const json: unknown = JSON.parse(encodeSettings(stored));
    expect(json).toMatchObject({ lastBackupAt: '2026-09-14T10:30:00.123Z' });
  });

  it.each([
    ['a missing record', null],
    ['an empty string', ''],
    ['truncated JSON', '{"screenProtection":'],
    ['not JSON at all', 'not json'],
    ['a JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"oneMinute"'],
    ['a JSON number', '42'],
    ['an empty object', '{}'],
    ['a half-written file', '{"autoLockTimeout":"fifteenMinut'],
  ])('falls back to the defaults for %s', (_label, raw) => {
    expect(decodeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back field by field when the types are wrong', () => {
    const raw = JSON.stringify({
      autoLockTimeout: 17,
      screenProtection: 'yes',
      analyticsEnabled: 1,
      crashReportsEnabled: null,
      onboardingDone: [],
      backupEnabled: {},
      lastBackupAt: 'the day before yesterday',
    });
    expect(decodeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the valid fields of a partly corrupt record', () => {
    const raw = JSON.stringify({
      autoLockTimeout: 'immediately',
      screenProtection: 'definitely',
      onboardingDone: true,
      somethingFromAFutureVersion: { nested: true },
    });
    expect(decodeSettings(raw)).toEqual({
      ...DEFAULT_SETTINGS,
      autoLockTimeout: 'immediately',
      onboardingDone: true,
    });
  });

  it('ignores unknown auto-lock names instead of throwing', () => {
    expect(autoLockTimeoutFromName('neverEver')).toBe('oneMinute');
    expect(autoLockTimeoutFromName(undefined)).toBe('oneMinute');
    expect(autoLockTimeoutFromName(null)).toBe('oneMinute');
    expect(autoLockTimeoutFromName(30_000)).toBe('oneMinute');
  });

  it.each(AUTO_LOCK_TIMEOUTS)('accepts the known auto-lock name %s', (timeout) => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, autoLockTimeout: timeout };
    expect(decodeSettings(encodeSettings(settings))).toEqual(settings);
  });
});

describe('InMemorySettingsStore', () => {
  it('loads the defaults when nothing was saved', async () => {
    await expect(new InMemorySettingsStore().load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('loads what it was seeded with', async () => {
    const seeded: AppSettings = { ...DEFAULT_SETTINGS, onboardingDone: true };
    await expect(new InMemorySettingsStore(seeded).load()).resolves.toEqual(seeded);
  });

  it('round-trips a save', async () => {
    const store = new InMemorySettingsStore();
    const next: AppSettings = { ...DEFAULT_SETTINGS, autoLockTimeout: 'immediately' };
    await store.save(next);
    await expect(store.load()).resolves.toEqual(next);
  });

  it('returns to the defaults after clear', async () => {
    const store = new InMemorySettingsStore({ ...DEFAULT_SETTINGS, analyticsEnabled: true });
    await store.clear();
    await expect(store.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });
});
