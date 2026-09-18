/**
 * `SettingsStore` backed by a single small JSON file in the app's document directory.
 *
 * `@react-native-async-storage/async-storage` is NOT a dependency of this project (checked in
 * package.json), so the non-secret preferences are kept in
 * `<Paths.document>/silentsum.settings.v1.json` through the class-based expo-file-system API
 * (`File` / `Paths`) that SDK 57 ships. The document directory is app-private and excluded from
 * cloud backup by the same app config that protects the vault, which is where a preferences file
 * belongs: it is not a secret, but it is nobody else's business either.
 *
 * Writes go to a sibling `.tmp` file that is then moved onto the target, so a process death
 * mid-write leaves the previous settings intact rather than a truncated file. `save` and `clear`
 * surface real I/O failures; `load` never rejects -- see the contract in
 * `@/settings/settingsStore` for why falling back to `DEFAULT_SETTINGS` is the safe direction.
 *
 * `Paths.document` is a native getter, so it is only touched inside the methods, never at module
 * scope: importing this file must not reach into native code.
 */
import { File, Paths } from 'expo-file-system';

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  decodeSettings,
  encodeSettings,
  type AppSettings,
  type SettingsStore,
} from '@/settings/settingsStore';

/** `silentsum.settings.v1.json` -- the storage key the Flutter build uses, as a file name. */
export const SETTINGS_FILE_NAME = `${SETTINGS_STORAGE_KEY}.json`;
const TEMP_FILE_NAME = `${SETTINGS_FILE_NAME}.tmp`;

export class FileSettingsStore implements SettingsStore {
  /** Never rejects: anything short of a readable, parseable record yields `DEFAULT_SETTINGS`. */
  async load(): Promise<AppSettings> {
    let raw: string;
    try {
      const file = new File(Paths.document, SETTINGS_FILE_NAME);
      if (!file.exists) return DEFAULT_SETTINGS;
      raw = await file.text();
    } catch {
      // Unreadable file, missing directory, native module unavailable: fall back to defaults.
      return DEFAULT_SETTINGS;
    }
    // `decodeSettings` is itself total: malformed JSON and unknown fields become defaults.
    return decodeSettings(raw);
  }

  async save(settings: AppSettings): Promise<void> {
    const temp = new File(Paths.document, TEMP_FILE_NAME);
    temp.create({ intermediates: true, overwrite: true });
    temp.write(encodeSettings(settings));
    temp.moveSync(new File(Paths.document, SETTINGS_FILE_NAME), { overwrite: true });
  }

  /** Deletes the record. A record that is already absent is not an error. */
  async clear(): Promise<void> {
    const file = new File(Paths.document, SETTINGS_FILE_NAME);
    if (file.exists) file.delete();
    const temp = new File(Paths.document, TEMP_FILE_NAME);
    if (temp.exists) temp.delete();
  }
}
