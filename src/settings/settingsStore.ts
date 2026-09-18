/**
 * Canonical import path for the settings persistence contract.
 *
 * The `SettingsStore` interface and its in-memory implementation are *declared* in
 * `@/settings/appSettings` next to the `AppSettings` type and codec they operate on, and are
 * re-exported here rather than redeclared: two structurally identical `InMemorySettingsStore`
 * classes in two modules would break `instanceof` for whoever imported the other one.
 *
 * Contract, restated for the backends in this directory:
 *
 * - `load()`   never rejects. An absent, unreadable, truncated or otherwise corrupt record
 *              yields `DEFAULT_SETTINGS`. That is safe because the defaults are the strict end
 *              of every setting (auto-lock after one minute, screen protection on, analytics
 *              off, onboarding not done), so losing the stored preferences degrades towards
 *              more privacy, never less.
 * - `save()`   rejects if the settings could not be persisted, so a failed toggle can be
 *              surfaced instead of silently reverting on the next launch.
 * - `clear()`  removes the record; a record that is already absent is not an error.
 *
 * Nothing security-critical may depend on these values being untampered -- they are policy
 * inputs, not secrets. Secrets live behind `@/secure-storage/secureStore`, which deliberately
 * fails closed instead of falling back to a default.
 */
export {
  DEFAULT_SETTINGS,
  InMemorySettingsStore,
  SETTINGS_STORAGE_KEY,
  decodeSettings,
  encodeSettings,
  type AppSettings,
  type SettingsStore,
} from '@/settings/appSettings';
