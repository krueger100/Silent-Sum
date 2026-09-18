/**
 * Keypad vocabulary and the immutable state the calculator engine moves between.
 *
 * Ported from the Flutter reference (lib/features/calculator/calculator_engine.dart);
 * the display glyphs, the entry cap and every transition rule are deliberately identical,
 * because the calculator is the app's cover UI and must behave the same on both platforms.
 */

/** Digit keys, ordered so the index is the digit itself. */
export const CALC_DIGIT_KEYS = [
  'digit0',
  'digit1',
  'digit2',
  'digit3',
  'digit4',
  'digit5',
  'digit6',
  'digit7',
  'digit8',
  'digit9',
] as const;

export type CalcDigitKey = (typeof CALC_DIGIT_KEYS)[number];

/** The four binary operators. Also valid [CalcKey]s, so a keypad can pass them straight through. */
export type CalcOp = 'add' | 'subtract' | 'multiply' | 'divide';

/** Every key on the calculator keypad. */
export type CalcKey =
  CalcDigitKey | CalcOp | 'point' | 'equals' | 'clear' | 'backspace' | 'percent' | 'negate';

/** Glyphs shown on the keypad and in the expression line: U+2212, U+00D7, U+00F7. */
export const CALC_OP_SYMBOL: Readonly<Record<CalcOp, string>> = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
};

/** A committed expression element: a number, or the operator that follows it. */
export type CalcToken = number | CalcOp;

/** Digits a single entry may hold. `-` and `.` do not count towards it. */
export const MAX_ENTRY_DIGITS = 15;

export function isCalcOp(value: unknown): value is CalcOp {
  return value === 'add' || value === 'subtract' || value === 'multiply' || value === 'divide';
}

export function isCalcDigitKey(key: CalcKey): key is CalcDigitKey {
  return (CALC_DIGIT_KEYS as readonly string[]).includes(key);
}

/** The character a digit key types, e.g. `digit7` -> `'7'`. */
export function digitOf(key: CalcDigitKey): string {
  return key.slice('digit'.length);
}

/** The key for a single digit. Throws for anything outside 0..9 (a programmer error). */
export function digitKey(digit: number): CalcDigitKey {
  const key = CALC_DIGIT_KEYS[digit];
  if (key === undefined) throw new RangeError(`not a single digit: ${String(digit)}`);
  return key;
}

/**
 * Immutable calculator state. `tokens` holds the committed part of the expression
 * (numbers and operators alternating, always starting with a number); `entry` is the
 * number currently being typed.
 */
export interface CalculatorState {
  /** Alternating numbers and operators. A trailing operator means one is pending. */
  readonly tokens: readonly CalcToken[];
  /** The number being typed, exactly as shown (may be `''`, `'0.'`, `'-4'`). */
  readonly entry: string;
  /** Set after `=`; the value the next operator continues from. */
  readonly resultValue: number | null;
  /** The expression that produced `resultValue`, shown above the result. */
  readonly lastExpression: string | null;
  /** True after a division by zero or a non-finite result: the display reads `Error`. */
  readonly error: boolean;
  /**
   * Digits the user "evaluated" as a bare integer on the last `=` press.
   * Non-null for exactly one state transition; the controller consumes it and every
   * following press clears it again.
   */
  readonly unlockCandidate: string | null;
}
