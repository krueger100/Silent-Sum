/**
 * Last line of defence for free text that is about to leave the device.
 *
 * The vault's two most damaging leaks are the PIN and an absolute path that proves a vault exists,
 * so both are removed unconditionally — a caller cannot opt out and cannot forget. This is a
 * port of `CrashReporter.scrub` in the Flutter app; the four rules and their order are identical
 * so that reports from both apps read the same way.
 *
 *   1. runs of 4-8 digits          -> `[redacted]`  (a PIN is 4-8 digits; 1-3 and 9+ runs survive
 *                                                    so that error codes, ports, years-in-context
 *                                                    and timestamps stay useful)
 *   2. `C:\...` up to whitespace   -> `[path]`
 *   3. POSIX paths under the roots an app's private storage actually lives in -> `[path]`
 *   4. any slash-path containing `vault` -> `[path]`
 *
 * Scrubbing is lossy on purpose. It is never applied to stack traces: RN frames carry bundle paths
 * under `/data/...` and source paths under `src/vault/...`, and rewriting them would destroy
 * symbolication without protecting anything the user typed.
 */

/** A PIN is between 4 and 8 digits, so a digit run of that length is treated as one. */
export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 8;

/**
 * Maximal digit runs. Matching every run and filtering by length is equivalent to
 * `(?<!\d)\d{4,8}(?!\d)` but needs no lookbehind, which not every JS engine we ship on supports.
 */
const DIGIT_RUN = /\d+/g;

/** Windows absolute path, up to the first whitespace. */
const WINDOWS_PATH = /[A-Za-z]:\\[^\s]+/g;

/** POSIX absolute path under a root that app-private or user storage lives in, up to whitespace/quote. */
const POSIX_PATH = /\/(?:data|private|var|storage|sdcard|tmp|Users|home)\/[^\s'"]*/g;

/** Any slash-path mentioning the vault, wherever it is rooted. */
const VAULT_PATH = /\/[^\s]*vault[^\s]*/g;

/** Removes anything that could identify a PIN or a vault location from `text`. */
export function scrub(text: string): string {
  return text
    .replace(DIGIT_RUN, (run) =>
      run.length >= PIN_MIN_DIGITS && run.length <= PIN_MAX_DIGITS ? '[redacted]' : run,
    )
    .replace(WINDOWS_PATH, '[path]')
    .replace(POSIX_PATH, '[path]')
    .replace(VAULT_PATH, '[path]');
}
