/**
 * What a calculated result means for the vault.
 *
 * The calculator stays a calculator: the user types any expression, presses `=`, and the RESULT is
 * what is offered to the authenticator. A result that is a contiguous run inside the PIN covers
 * the digits it spells; the vault opens once the covered digits account for the WHOLE PIN. Until
 * then the user is told how many digits are still missing. With PIN `12142907`:
 *
 *   2 - 1      = 1      covers "1"        -> "1 is correct, but there are 7 more"
 *   6 + 6      = 12     covers "12"       -> "12 is correct, but there are 6 more"
 *   1000 + 214 = 1214   covers "1214"     -> "1214 is correct, but there are 4 more"
 *   2900 + 7   = 2907   covers the rest   -> the vault opens
 *   7 * 7      = 49     is not in the PIN -> nothing happens at all
 *
 * Typing the whole PIN in one calculation covers all of it at once, so it opens the vault on the
 * first press, exactly as it always did.
 *
 * A run that occurs more than once in the PIN is credited to the occurrence that covers the most
 * NEW digits, leftmost first. That is what makes `1`, `12`, `1214` count 7, 6 and 4 digits missing
 * rather than crediting both of the `1`s in `12142907` at once, and it lets a repeated digit be
 * entered twice to cover both of its positions.
 *
 * Only a non-negative whole number can be offered: a negative or fractional result is not a run of
 * digits and is rejected outright rather than being coerced into one.
 *
 * SECURITY NOTE. Assembling the PIN from parts is far weaker than requiring it in one piece, and
 * the missing-digit count is an oracle on top of that: it confirms that a guess belongs to the PIN,
 * and confirmed guesses accumulate. Someone holding the phone can work through the ten digits and
 * be inside in well under a hundred presses. What is left of the brake is that results which are
 * NOT in the PIN still count as failed attempts and still trigger the escalating lockout, and that
 * nothing is confirmed while a lockout is running. Progress itself is held in memory only, so it
 * dies with the process and on every successful unlock. Recognising a part of the PIN also means
 * the app must be able to read the PIN, which is why it is stored (see `vaultCredentials.ts`).
 * docs/security.md says all of this plainly.
 */

const DIGITS_ONLY = /^[0-9]+$/;

/** How much of the PIN the current run of calculations has spelled out. Never persisted. */
export interface PinProgress {
  readonly pin: string;
  /** One flag per PIN digit; true once some result has spelled that position. */
  readonly covered: readonly boolean[];
}

export type PinProgressResult =
  /** The result is not in the PIN. Progress is untouched. */
  | { readonly kind: 'none'; readonly progress: PinProgress }
  /** The result is in the PIN; `missingDigits` are still uncovered. */
  | { readonly kind: 'partial'; readonly progress: PinProgress; readonly missingDigits: number }
  /** The covered digits now account for the whole PIN. */
  | { readonly kind: 'complete'; readonly progress: PinProgress };

/**
 * Formats an evaluated calculator result as the digit string to match against the PIN, or null
 * when the result cannot be one (negative, fractional, non-finite, or wider than a float can
 * represent exactly).
 */
export function unlockDigitsOf(value: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < 0 || !Number.isSafeInteger(value)) return null;
  return String(value);
}

/** Nothing covered yet. */
export function emptyProgress(pin: string): PinProgress {
  return { pin, covered: new Array<boolean>(pin.length).fill(false) };
}

/** The occurrence of `digits` in the PIN that would cover the most new digits, or -1 for none. */
function bestOccurrence(progress: PinProgress, digits: string): number {
  const { pin, covered } = progress;
  let best = -1;
  let bestGain = -1;
  for (let start = 0; start + digits.length <= pin.length; start++) {
    if (pin.slice(start, start + digits.length) !== digits) continue;
    let gain = 0;
    for (let i = start; i < start + digits.length; i++) {
      if (covered[i] !== true) gain++;
    }
    // Strictly greater, so equal gains keep the leftmost occurrence.
    if (gain > bestGain) {
      bestGain = gain;
      best = start;
    }
  }
  return best;
}

/** Credits `digits` against the PIN and reports what is left. Pure: returns the next progress. */
export function coverWith(progress: PinProgress, digits: string): PinProgressResult {
  if (digits.length === 0 || progress.pin.length === 0) return { kind: 'none', progress };
  if (!DIGITS_ONLY.test(digits) || !DIGITS_ONLY.test(progress.pin)) return { kind: 'none', progress };

  const start = bestOccurrence(progress, digits);
  if (start < 0) return { kind: 'none', progress };

  const covered = [...progress.covered];
  for (let i = start; i < start + digits.length; i++) covered[i] = true;
  const next: PinProgress = { pin: progress.pin, covered };

  const missingDigits = covered.reduce((count, flag) => (flag ? count : count + 1), 0);
  if (missingDigits === 0) return { kind: 'complete', progress: next };
  return { kind: 'partial', progress: next, missingDigits };
}

/** The sentence shown for a partial match, e.g. "1 is correct, but there are 7 more". */
export function describePartialMatch(digits: string, missingDigits: number): string {
  const verb = missingDigits === 1 ? 'is' : 'are';
  return `${digits} is correct, but there ${verb} ${String(missingDigits)} more`;
}
