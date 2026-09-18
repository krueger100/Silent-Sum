/**
 * Non-secret preferences. Nothing security-relevant may depend on these values being untampered;
 * they are policy inputs, not secrets. Persisted as compact JSON under `silentsum.settings.v1`.
 */
import type { ThemeMode } from '@/app/theme';
import { tryParseIso8601, toIso8601Utc } from '@/utils/iso8601';

export type AutoLockTimeout =
  'immediately' | 'thirtySeconds' | 'oneMinute' | 'fiveMinutes' | 'fifteenMinutes';

export const AUTO_LOCK_TIMEOUTS: readonly AutoLockTimeout[] = [
  'immediately',
  'thirtySeconds',
  'oneMinute',
  'fiveMinutes',
  'fifteenMinutes',
];

export const AUTO_LOCK_DURATION_MS: Readonly<Record<AutoLockTimeout, number>> = {
  immediately: 0,
  thirtySeconds: 30_000,
  oneMinute: 60_000,
  fiveMinutes: 5 * 60_000,
  fifteenMinutes: 15 * 60_000,
};

export const AUTO_LOCK_LABEL: Readonly<Record<AutoLockTimeout, string>> = {
  immediately: 'Immediately',
  thirtySeconds: 'After 30 seconds',
  oneMinute: 'After 1 minute',
  fiveMinutes: 'After 5 minutes',
  fifteenMinutes: 'After 15 minutes',
};

export function autoLockTimeoutFromName(name: unknown): AutoLockTimeout {
  return typeof name === 'string' && (AUTO_LOCK_TIMEOUTS as readonly string[]).includes(name)
    ? (name as AutoLockTimeout)
    : 'oneMinute';
}

export interface AppSettings {
  readonly autoLockTimeout: AutoLockTimeout;
  readonly screenProtection: boolean;
  /** Night is the default: it is what the screens were designed against. */
  readonly theme: ThemeMode;
  /**
   * "Super secure": takes the ⋮ menu off the calculator, so nothing on that screen hints that
   * a vault exists and the only way in is a calculation that spells the PIN.
   *
   * Ignored while no vault is configured, and while the credential record is unreadable: the
   * menu is the only route to setup and to erase, and hiding it then would strand the user
   * with an app they cannot set up or recover.
   */
  readonly superSecure: boolean;
  readonly analyticsEnabled: boolean;
  readonly crashReportsEnabled: boolean;
  readonly onboardingDone: boolean;
  readonly backupEnabled: boolean;
  /** Epoch ms UTC or null. */
  readonly lastBackupAt: number | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoLockTimeout: 'oneMinute',
  screenProtection: true,
  theme: 'night',
  superSecure: false,
  analyticsEnabled: false,
  crashReportsEnabled: true,
  onboardingDone: false,
  backupEnabled: false,
  lastBackupAt: null,
};

export const SETTINGS_STORAGE_KEY = 'silentsum.settings.v1';

export function settingsToJson(s: AppSettings): Record<string, unknown> {
  return {
    autoLockTimeout: s.autoLockTimeout,
    screenProtection: s.screenProtection,
    theme: s.theme,
    superSecure: s.superSecure,
    analyticsEnabled: s.analyticsEnabled,
    crashReportsEnabled: s.crashReportsEnabled,
    onboardingDone: s.onboardingDone,
    backupEnabled: s.backupEnabled,
    lastBackupAt: s.lastBackupAt === null ? null : toIso8601Utc(s.lastBackupAt),
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Lenient: unknown or malformed fields fall back to defaults; never throws for object input. */
export function settingsFromJson(json: unknown): AppSettings {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return DEFAULT_SETTINGS;
  const o = json as Record<string, unknown>;
  return {
    autoLockTimeout: autoLockTimeoutFromName(o.autoLockTimeout),
    screenProtection: bool(o.screenProtection, DEFAULT_SETTINGS.screenProtection),
    theme: o.theme === 'day' ? 'day' : DEFAULT_SETTINGS.theme,
    superSecure: bool(o.superSecure, DEFAULT_SETTINGS.superSecure),
    analyticsEnabled: bool(o.analyticsEnabled, DEFAULT_SETTINGS.analyticsEnabled),
    crashReportsEnabled: bool(o.crashReportsEnabled, DEFAULT_SETTINGS.crashReportsEnabled),
    onboardingDone: bool(o.onboardingDone, DEFAULT_SETTINGS.onboardingDone),
    backupEnabled: bool(o.backupEnabled, DEFAULT_SETTINGS.backupEnabled),
    lastBackupAt: typeof o.lastBackupAt === 'string' ? tryParseIso8601(o.lastBackupAt) : null,
  };
}

export function encodeSettings(s: AppSettings): string {
  return JSON.stringify(settingsToJson(s));
}

export function decodeSettings(raw: string | null): AppSettings {
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    return settingsFromJson(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface SettingsStore {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
  clear(): Promise<void>;
}

export class InMemorySettingsStore implements SettingsStore {
  private value: AppSettings | null;

  constructor(initial?: AppSettings) {
    this.value = initial ?? null;
  }

  async load(): Promise<AppSettings> {
    return this.value ?? DEFAULT_SETTINGS;
  }

  async save(settings: AppSettings): Promise<void> {
    this.value = settings;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}
