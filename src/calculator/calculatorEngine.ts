/**
 * Pure state machine for a standard calculator with operator precedence
 * (x / before + -), decimals, percent, sign toggle, backspace and clear.
 *
 * Every function here is total and side-effect free: `press` maps a state and a key to the
 * next state, and nothing mutates the state it was given. The engine is also the app's front
 * door - `=` publishes the RESULT it just computed as `unlockCandidate` whenever that result is
 * a non-negative whole number, and the controller consumes it to attempt an unlock. The engine
 * knows nothing about the PIN; it only reports what was calculated. That candidate survives
 * exactly one transition.
 */
import {
  CALC_OP_SYMBOL,
  MAX_ENTRY_DIGITS,
  digitOf,
  type CalcKey,
  type CalcOp,
  type CalcToken,
  type CalculatorState,
} from '@/calculator/types';
import { unlockDigitsOf } from '@/calculator/pinMatching';

export const INITIAL_STATE: CalculatorState = {
  tokens: [],
  entry: '',
  resultValue: null,
  lastExpression: null,
  error: false,
  unlockCandidate: null,
};

interface StatePatch {
  tokens?: readonly CalcToken[];
  entry?: string;
  resultValue?: number | null;
  lastExpression?: string | null;
  error?: boolean;
  unlockCandidate?: string | null;
}

/** Copies a state, always replacing `unlockCandidate` so it cannot outlive one transition. */
function copyWith(state: CalculatorState, patch: StatePatch = {}): CalculatorState {
  return { ...state, ...patch, unlockCandidate: patch.unlockCandidate ?? null };
}

/** True once `=` produced a result or an error; the next digit then starts from scratch. */
export function justEvaluated(state: CalculatorState): boolean {
  return state.resultValue !== null || state.error;
}

/** Drops the trailing zeros (and then a bare trailing point) of a fixed-notation number. */
function stripTrailingZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Renders a number the way the display shows it: plain integers where possible, otherwise
 * 10 significant digits with the padding stripped, and `1e16` rather than `1.000000000e+16`.
 */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return 'Error';
  if (v === 0) return '0'; // also catches -0
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);

  const text = v.toPrecision(10);
  const e = text.indexOf('e');
  if (e >= 0) {
    // 1.000000000e+16 -> 1e16
    const mantissa = stripTrailingZeros(text.slice(0, e));
    const exponent = text.slice(e + 1).replace('+', '');
    return `${mantissa}e${exponent}`;
  }
  return stripTrailingZeros(text);
}

/**
 * Evaluates alternating number/operator tokens with x / precedence, then + - left to right.
 * Returns null for division by zero, and for a malformed token list (see the note in the
 * module tests): both surface as `Error` rather than throwing at the caller.
 */
export function evaluate(tokens: readonly CalcToken[]): number | null {
  if (tokens.length === 0) return 0;

  // Pass 1: multiplication and division.
  const pass1: CalcToken[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) return null;
    if (t === 'multiply' || t === 'divide') {
      const left = pass1.pop();
      const right = tokens[i + 1];
      if (typeof left !== 'number' || typeof right !== 'number') return null;
      if (t === 'divide' && right === 0) return null;
      pass1.push(t === 'multiply' ? left * right : left / right);
      i += 2;
    } else {
      pass1.push(t);
      i += 1;
    }
  }

  // Pass 2: addition and subtraction, left to right.
  const first = pass1[0];
  if (typeof first !== 'number') return null;
  let acc = first;
  for (let j = 1; j < pass1.length; j += 2) {
    const op = pass1[j];
    const right = pass1[j + 1];
    if (typeof op !== 'string' || typeof right !== 'number') return null;
    acc = op === 'add' ? acc + right : acc - right;
  }
  return acc;
}

/** The large primary line: the result, what is being typed, or the last committed number. */
export function displayText(state: CalculatorState): string {
  if (state.error) return 'Error';
  if (state.resultValue !== null) return formatNumber(state.resultValue);
  if (state.entry !== '') return state.entry;

  const last = state.tokens[state.tokens.length - 1];
  if (typeof last === 'number') return formatNumber(last);
  if (last !== undefined && state.tokens.length >= 2) {
    // Trailing operator: show the number before it.
    const previous = state.tokens[state.tokens.length - 2];
    if (typeof previous === 'number') return formatNumber(previous);
  }
  return '0';
}

/** The small secondary line: the pending expression, or the one that produced the result. */
export function expressionLine(state: CalculatorState): string {
  if (state.lastExpression !== null) return state.lastExpression;
  const parts = state.tokens.map((t) =>
    typeof t === 'number' ? formatNumber(t) : CALC_OP_SYMBOL[t],
  );
  if (state.entry !== '') parts.push(state.entry);
  return parts.join(' ');
}

/** Reads an entry as typed. `''`, `'-'`, `'-0'` and `'0.'` all mean zero. */
function parseEntry(entry: string): number {
  if (entry === '' || entry === '-') return 0;
  const text = entry.endsWith('.') ? entry.slice(0, -1) : entry;
  if (text === '-0') return 0;
  return Number(text);
}

/** A press after `=` starts over; anything else continues, minus the spent unlock candidate. */
function fresh(state: CalculatorState): CalculatorState {
  return justEvaluated(state) ? INITIAL_STATE : copyWith(state);
}

function pressDigit(state: CalculatorState, digit: string): CalculatorState {
  const base = fresh(state);
  let entry = base.entry;
  if (entry === '0') entry = digit;
  else if (entry === '-0') entry = `-${digit}`;
  else entry = `${entry}${digit}`;

  const digitCount = entry.replace(/[-.]/g, '').length;
  if (digitCount > MAX_ENTRY_DIGITS) return base;
  return copyWith(base, { entry });
}

function pressPoint(state: CalculatorState): CalculatorState {
  const base = fresh(state);
  let entry = base.entry;
  if (entry.includes('.')) return base;
  if (entry === '') entry = '0';
  if (entry === '-') entry = '-0';
  return copyWith(base, { entry: `${entry}.` });
}

function pressBackspace(state: CalculatorState): CalculatorState {
  if (justEvaluated(state)) return INITIAL_STATE; // covers the error state too
  if (state.entry === '') return copyWith(state);
  let entry = state.entry.slice(0, -1);
  if (entry === '-') entry = '';
  return copyWith(state, { entry });
}

function pressNegate(state: CalculatorState): CalculatorState {
  if (state.error) return INITIAL_STATE;
  if (state.resultValue !== null) {
    return { ...INITIAL_STATE, entry: formatNumber(-state.resultValue) };
  }
  if (state.entry !== '') {
    const entry = state.entry.startsWith('-') ? state.entry.slice(1) : `-${state.entry}`;
    return copyWith(state, { entry });
  }
  const last = state.tokens[state.tokens.length - 1];
  if (typeof last === 'number') {
    const tokens = [...state.tokens];
    tokens[tokens.length - 1] = -last;
    return copyWith(state, { tokens });
  }
  return copyWith(state);
}

function pressPercent(state: CalculatorState): CalculatorState {
  if (state.error) return INITIAL_STATE;
  if (state.resultValue !== null) {
    return { ...INITIAL_STATE, entry: formatNumber(state.resultValue / 100) };
  }
  if (state.entry !== '') {
    return copyWith(state, { entry: formatNumber(parseEntry(state.entry) / 100) });
  }
  const last = state.tokens[state.tokens.length - 1];
  if (typeof last === 'number') {
    const tokens = [...state.tokens];
    tokens[tokens.length - 1] = last / 100;
    return copyWith(state, { tokens });
  }
  return copyWith(state);
}

function pressOperator(state: CalculatorState, op: CalcOp): CalculatorState {
  if (state.error) return INITIAL_STATE;
  let tokens: CalcToken[] = [...state.tokens];
  if (state.resultValue !== null) {
    tokens = [state.resultValue]; // continue from the result
  } else if (state.entry !== '') {
    tokens.push(parseEntry(state.entry));
  }
  if (tokens.length === 0) tokens.push(0);

  const last = tokens[tokens.length - 1];
  if (typeof last === 'string')
    tokens[tokens.length - 1] = op; // replace the pending operator
  else tokens.push(op);
  return { ...INITIAL_STATE, tokens };
}

function pressEquals(state: CalculatorState): CalculatorState {
  if (state.error) return INITIAL_STATE;
  if (justEvaluated(state)) return copyWith(state); // a second `=` does nothing

  const tokens: CalcToken[] = [...state.tokens];
  if (state.entry !== '') tokens.push(parseEntry(state.entry));
  if (typeof tokens[tokens.length - 1] === 'string') tokens.pop(); // drop a dangling operator
  // `=` with nothing typed computes nothing, so there is no result to offer.
  if (tokens.length === 0) return copyWith(state);

  const expression = expressionLine({ ...INITIAL_STATE, tokens });
  const value = evaluate(tokens);
  if (value === null || !Number.isFinite(value)) {
    return {
      ...INITIAL_STATE,
      error: true,
      lastExpression: `${expression} =`,
      unlockCandidate: null,
    };
  }
  return {
    ...INITIAL_STATE,
    resultValue: value,
    lastExpression: `${expression} =`,
    unlockCandidate: unlockDigitsOf(value),
  };
}

/** Applies one key press. Returns a new state; `state` is never mutated. */
export function press(state: CalculatorState, key: CalcKey): CalculatorState {
  switch (key) {
    case 'clear':
      return INITIAL_STATE;
    case 'equals':
      return pressEquals(state);
    case 'backspace':
      return pressBackspace(state);
    case 'point':
      return pressPoint(state);
    case 'negate':
      return pressNegate(state);
    case 'percent':
      return pressPercent(state);
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide':
      return pressOperator(state, key);
    default:
      return pressDigit(state, digitOf(key));
  }
}
