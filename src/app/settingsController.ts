/**
 * Observable user settings backed by the persistent store.
 *
 * Nothing here is secret, and the vault never consults it for a security decision: turning off
 * screen protection or lengthening the auto-lock timeout changes convenience, never whether the
 * PIN is required. Writes are fire-and-forget so a failing disk cannot wedge a settings toggle.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import { DEFAULT_SETTINGS, type AppSettings, type SettingsStore } from '@/settings/appSettings';

export class SettingsController {
  readonly store: StoreApi<AppSettings>;

  private loaded = false;

  constructor(
    private readonly persistence: SettingsStore,
    initial: AppSettings = DEFAULT_SETTINGS,
  ) {
    this.store = createStore<AppSettings>()(() => initial);
  }

  get current(): AppSettings {
    return this.store.getState();
  }

  /** Reads the persisted settings once at startup. Failures leave the defaults in place. */
  async load(): Promise<AppSettings> {
    if (this.loaded) return this.current;
    this.loaded = true;
    try {
      this.store.setState(await this.persistence.load(), true);
    } catch {
      // Defaults already in the store; a broken settings file must not block the app.
    }
    return this.current;
  }

  async update(patch: Partial<AppSettings>): Promise<void> {
    const next: AppSettings = { ...this.current, ...patch };
    this.store.setState(next, true);
    try {
      await this.persistence.save(next);
    } catch {
      // The in-memory value still applies for this session.
    }
  }

  /** Used by vault erase: forget every preference along with the data. */
  async reset(): Promise<void> {
    this.store.setState(DEFAULT_SETTINGS, true);
    try {
      await this.persistence.clear();
    } catch {
      // Nothing more to do.
    }
  }
}
