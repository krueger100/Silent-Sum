import {
  INITIAL_STATE,
  displayText,
  evaluate,
  expressionLine,
  formatNumber,
  justEvaluated,
  press,
} from '@/calculator/calculatorEngine';
import {
  CALC_DIGIT_KEYS,
  digitKey,
  digitOf,
  isCalcDigitKey,
  isCalcOp,
  type CalcKey,
  type CalculatorState,
} from '@/calculator/types';

const NON_DIGIT_KEYS: Readonly<Record<string, CalcKey>> = {
  '.': 'point',
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '=': 'equals',
  C: 'clear',
  '<': 'backspace',
  '%': 'percent',
  '~': 'negate',
};

const ALL_KEYS: readonly CalcKey[] = [
  ...CALC_DIGIT_KEYS,
  'point',
  'add',
  'subtract',
  'multiply',
  'divide',
  'equals',
  'clear',
  'backspace',
  'percent',
  'negate',
];

function keyFor(char: string): CalcKey {
  return NON_DIGIT_KEYS[char] ?? digitKey(Number(char));
}

/** Types a compact keystroke sequence, e.g. `type('12+3=')`. `<` backspace, `~` +/-, `C` clear. */
function type(sequence: string, from: CalculatorState = INITIAL_STATE): CalculatorState {
  let state = from;
  for (const char of sequence) state = press(state, keyFor(char));
  return state;
}

/** The primary display line after typing `sequence`. */
function shown(sequence: string): string {
  return displayText(type(sequence));
}

function stateWith(patch: Partial<CalculatorState>): CalculatorState {
  return { ...INITIAL_STATE, ...patch };
}

describe('keypad vocabulary', () => {
  it('maps digit keys to their characters and back', () => {
    for (let d = 0; d <= 9; d++) {
      const key = digitKey(d);
      expect(digitOf(key)).toBe(String(d));
      expect(isCalcDigitKey(key)).toBe(true);
      expect(isCalcOp(key)).toBe(false);
    }
    expect(isCalcDigitKey('point')).toBe(false);
    expect(isCalcOp('multiply')).toBe(true);
    expect(isCalcOp('equals')).toBe(false);
    expect(() => digitKey(10)).toThrow(RangeError);
    expect(() => digitKey(-1)).toThrow(RangeError);
  });
});

describe('formatNumber', () => {
  it.each<[number, string]>([
    [0, '0'],
    [-0, '0'],
    [5, '5'],
    [-5, '-5'],
    [2.5, '2.5'],
    [-2.5, '-2.5'],
    [1e14, '100000000000000'],
    [123456789012345, '123456789012345'],
    [1 / 3, '0.3333333333'],
    [2 / 3, '0.6666666667'],
    [0.1 + 0.2, '0.3'],
    [0.000001, '0.000001'],
    [1234567890.5, '1234567891'],
    [12345678901234.5, '1.23456789e13'],
  ])('renders %p as %p', (value, expected) => {
    expect(formatNumber(value)).toBe(expected);
  });

  it.each<[number, string]>([
    [1e15, '1e15'],
    [1e16, '1e16'],
    [-1e16, '-1e16'],
    [1e21, '1e21'],
    [1e100, '1e100'],
    [1e-7, '1e-7'],
    [1.5e-7, '1.5e-7'],
  ])('normalises the exponent form of %p to %p', (value, expected) => {
    expect(formatNumber(value)).toBe(expected);
  });

  it.each<[string, number]>([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('renders %s as Error', (_label, value) => {
    expect(formatNumber(value)).toBe('Error');
  });
});

describe('evaluate', () => {
  it('returns zero for no tokens and the value for a single number', () => {
    expect(evaluate([])).toBe(0);
    expect(evaluate([7])).toBe(7);
    expect(evaluate([-7])).toBe(-7);
  });

  it('applies multiplication and division before addition and subtraction', () => {
    expect(evaluate([2, 'add', 3, 'multiply', 4])).toBe(14);
    expect(evaluate([2, 'multiply', 3, 'add', 4])).toBe(10);
    expect(evaluate([1, 'add', 8, 'divide', 4, 'subtract', 1])).toBe(2);
    expect(evaluate([2, 'multiply', 3, 'multiply', 4])).toBe(24);
  });

  it('works left to right within each pass', () => {
    expect(evaluate([10, 'subtract', 2, 'subtract', 3])).toBe(5);
    expect(evaluate([8, 'divide', 4, 'divide', 2])).toBe(1);
    expect(evaluate([100, 'divide', 5, 'multiply', 2])).toBe(40);
  });

  it('returns null for division by zero, wherever it appears', () => {
    expect(evaluate([1, 'divide', 0])).toBeNull();
    expect(evaluate([1, 'add', 2, 'divide', 0])).toBeNull();
    expect(evaluate([1, 'divide', -0])).toBeNull();
    expect(evaluate([0, 'divide', 0])).toBeNull();
  });

  it('returns null rather than throwing on a malformed token list', () => {
    expect(evaluate(['add'])).toBeNull();
    expect(evaluate([1, 'add'])).toBeNull();
    expect(evaluate([1, 'multiply'])).toBeNull();
    expect(evaluate(['multiply', 2])).toBeNull();
  });
});

describe('typing numbers', () => {
  it('starts blank', () => {
    expect(displayText(INITIAL_STATE)).toBe('0');
    expect(expressionLine(INITIAL_STATE)).toBe('');
    expect(justEvaluated(INITIAL_STATE)).toBe(false);
  });

  it('appends digits', () => {
    expect(shown('1')).toBe('1');
    expect(shown('123')).toBe('123');
    expect(type('123').entry).toBe('123');
  });

  it('replaces a lone leading zero instead of growing it', () => {
    expect(shown('0')).toBe('0');
    expect(shown('05')).toBe('5');
    expect(shown('00')).toBe('0');
    expect(shown('0.5')).toBe('0.5');
  });

  it('replaces a lone negative zero', () => {
    expect(type('0~').entry).toBe('-0');
    expect(type('0~5').entry).toBe('-5');
  });

  it('starts a decimal from zero and accepts only one point', () => {
    expect(shown('.')).toBe('0.');
    expect(shown('.5')).toBe('0.5');
    expect(shown('1.')).toBe('1.');
    expect(shown('1..2')).toBe('1.2');
    expect(shown('1.2.3')).toBe('1.23');
  });

  it('turns a bare minus into "-0." when a point follows', () => {
    // Defensive path: a bare '-' entry is not reachable from the keypad alone.
    expect(press(stateWith({ entry: '-' }), 'point').entry).toBe('-0.');
  });

  it('caps the entry at 15 digits, not counting the sign or the point', () => {
    expect(shown('123456789012345')).toBe('123456789012345');
    expect(shown('1234567890123456')).toBe('123456789012345');
    expect(shown('1234567890.12345')).toBe('1234567890.12345');
    expect(shown('1234567890.123456')).toBe('1234567890.12345');
    expect(shown('123456789012345~6')).toBe('-123456789012345');
  });
});

describe('arithmetic', () => {
  it('evaluates with operator precedence', () => {
    expect(shown('2+3*4=')).toBe('14');
    expect(shown('2*3+4=')).toBe('10');
    expect(shown('10-2-3=')).toBe('5');
    expect(shown('10/4=')).toBe('2.5');
    expect(shown('1/3=')).toBe('0.3333333333');
    expect(shown('2+3*4-6/2=')).toBe('11');
  });

  it('replaces a pending operator instead of stacking one', () => {
    const state = type('5+*');
    expect(state.tokens).toEqual([5, 'multiply']);
    expect(expressionLine(state)).toBe('5 ×');
    expect(shown('5+*-/3=')).toBe('1.666666667');
    expect(shown('5+*2=')).toBe('10');
  });

  it('treats a leading operator as continuing from zero', () => {
    expect(type('+').tokens).toEqual([0, 'add']);
    expect(shown('+5=')).toBe('5');
    expect(shown('-5=')).toBe('-5');
  });

  it('drops a dangling operator at "="', () => {
    expect(shown('2+3+=')).toBe('5');
    expect(shown('2+=')).toBe('2');
  });

  it('continues from the result when an operator follows "="', () => {
    const state = type('2+3=*2');
    expect(state.tokens).toEqual([5, 'multiply']);
    expect(shown('2+3=*2=')).toBe('10');
  });

  it('starts over when a digit or point follows "="', () => {
    const state = type('2+3=7');
    expect(state).toEqual({ ...INITIAL_STATE, entry: '7' });
    expect(shown('2+3=.5')).toBe('0.5');
  });

  it('ignores a second "=" in a row', () => {
    const once = type('2+3=');
    const twice = press(once, 'equals');
    expect(twice).toEqual({ ...once, unlockCandidate: null });
    expect(displayText(twice)).toBe('5');
    expect(expressionLine(twice)).toBe('2 + 3 =');
  });

  it('does nothing when "=" has neither tokens nor an entry', () => {
    expect(press(INITIAL_STATE, 'equals')).toEqual(INITIAL_STATE);
  });

  it('parses an entry that ends in a point', () => {
    expect(shown('5.=')).toBe('5');
    expect(shown('5.+1=')).toBe('6');
  });

  it('clears everything on C', () => {
    expect(type('2+3*4C')).toEqual(INITIAL_STATE);
    expect(type('5/0=C')).toEqual(INITIAL_STATE);
  });
});

describe('division by zero', () => {
  it('produces an error state that displays "Error"', () => {
    const state = type('5/0=');
    expect(state.error).toBe(true);
    expect(state.resultValue).toBeNull();
    expect(justEvaluated(state)).toBe(true);
    expect(displayText(state)).toBe('Error');
    expect(expressionLine(state)).toBe('5 ÷ 0 =');
  });

  it('errors on a non-finite result too', () => {
    const overflow = press(stateWith({ tokens: [1e308, 'multiply'], entry: '10' }), 'equals');
    expect(overflow.error).toBe(true);
    expect(displayText(overflow)).toBe('Error');
  });

  it.each<[string, CalcKey]>([
    ['an operator', 'add'],
    ['negate', 'negate'],
    ['percent', 'percent'],
    ['backspace', 'backspace'],
    ['equals', 'equals'],
    ['clear', 'clear'],
  ])('resets the error state on %s', (_label, key) => {
    expect(press(type('5/0='), key)).toEqual(INITIAL_STATE);
  });

  it('starts a fresh entry when a digit follows the error', () => {
    expect(type('5/0=7')).toEqual({ ...INITIAL_STATE, entry: '7' });
  });
});

describe('display and expression lines', () => {
  it('shows the pending expression while typing', () => {
    expect(expressionLine(type('2'))).toBe('2');
    expect(expressionLine(type('2+'))).toBe('2 +');
    expect(expressionLine(type('2+3*4'))).toBe('2 + 3 × 4');
    expect(expressionLine(type('8/2'))).toBe('8 ÷ 2');
    expect(expressionLine(type('8-2'))).toBe('8 − 2');
  });

  it('keeps showing the last number while an operator is pending', () => {
    expect(shown('2+')).toBe('2');
    expect(shown('2+3*')).toBe('3');
  });

  it('falls back to "0" when there is nothing to show', () => {
    expect(displayText(stateWith({ tokens: ['add'] }))).toBe('0');
  });

  it('shows the committed number when the entry is emptied', () => {
    const state = type('2+3<');
    expect(state.tokens).toEqual([2, 'add']);
    expect(state.entry).toBe('');
    expect(displayText(state)).toBe('2');
  });

  it('shows the evaluated expression above the result', () => {
    expect(expressionLine(type('2+3='))).toBe('2 + 3 =');
    expect(expressionLine(type('1234='))).toBe('1234 =');
  });
});

describe('backspace', () => {
  it('removes one character at a time', () => {
    expect(shown('123<')).toBe('12');
    expect(shown('123<<')).toBe('1');
    expect(shown('1.5<')).toBe('1.');
  });

  it('empties the entry and then leaves the state alone', () => {
    const empty = type('5<');
    expect(empty).toEqual(INITIAL_STATE);
    expect(press(empty, 'backspace')).toEqual(INITIAL_STATE);
  });

  it('drops a lone minus sign with the last digit', () => {
    expect(type('5~<').entry).toBe('');
    expect(shown('5~<')).toBe('0');
  });

  it('resets to the initial state after "=" or an error', () => {
    expect(press(type('2+3='), 'backspace')).toEqual(INITIAL_STATE);
    expect(press(type('5/0='), 'backspace')).toEqual(INITIAL_STATE);
  });
});

describe('negate', () => {
  it('toggles the sign of the entry', () => {
    expect(type('5~').entry).toBe('-5');
    expect(type('5~~').entry).toBe('5');
    expect(shown('5~+3=')).toBe('-2');
  });

  it('turns a result into a fresh entry', () => {
    const state = press(type('2+3='), 'negate');
    expect(state).toEqual({ ...INITIAL_STATE, entry: '-5' });
    expect(displayText(state)).toBe('-5');
    expect(shown('2+3=~7')).toBe('-57');
  });

  it('negates the last committed number when the entry is empty', () => {
    const state = press(stateWith({ tokens: [5, 'add', 3] }), 'negate');
    expect(state.tokens).toEqual([5, 'add', -3]);
  });

  it('does nothing with nothing to negate', () => {
    expect(press(INITIAL_STATE, 'negate')).toEqual(INITIAL_STATE);
    expect(press(type('2+'), 'negate').tokens).toEqual([2, 'add']);
  });
});

describe('percent', () => {
  it('divides the entry by one hundred', () => {
    expect(type('50%').entry).toBe('0.5');
    expect(shown('50%')).toBe('0.5');
    expect(type('5.%').entry).toBe('0.05');
    expect(shown('200+10%=')).toBe('200.1');
  });

  it('divides a result by one hundred as a fresh entry', () => {
    const state = press(type('2+3='), 'percent');
    expect(state).toEqual({ ...INITIAL_STATE, entry: '0.05' });
  });

  it('divides the last committed number when the entry is empty', () => {
    const state = press(stateWith({ tokens: [5, 'add', 3] }), 'percent');
    expect(state.tokens).toEqual([5, 'add', 0.03]);
  });

  it('does nothing with nothing to scale', () => {
    expect(press(INITIAL_STATE, 'percent')).toEqual(INITIAL_STATE);
    expect(press(type('2+'), 'percent').tokens).toEqual([2, 'add']);
  });
});

describe('unlock candidate', () => {
  it('is the entry when "=" evaluates a bare integer', () => {
    const state = type('1234=');
    expect(state.unlockCandidate).toBe('1234');
    expect(state.resultValue).toBe(1234);
    expect(displayText(state)).toBe('1234');
    expect(type('12345678=').unlockCandidate).toBe('12345678');
  });

  it('is the COMPUTED result, not the digits that were typed', () => {
    expect(type('2-1=').unlockCandidate).toBe('1');
    expect(type('6+6=').unlockCandidate).toBe('12');
    expect(type('1000+214=').unlockCandidate).toBe('1214');
    expect(type('1230+4=').unlockCandidate).toBe('1234');
    expect(type('123=').unlockCandidate).toBe('123');
    expect(type('123456789=').unlockCandidate).toBe('123456789');
  });

  it.each<[string, string]>([
    ['not an integer', '12.34='],
    ['a negated result', '1234~='],
    ['a negative difference', '1-2='],
    ['nothing at all', '='],
    ['a division by zero', '5/0='],
  ])('is null for %s', (_label, sequence) => {
    expect(type(sequence).unlockCandidate).toBeNull();
  });

  it('is null for an entry that was never evaluated', () => {
    expect(type('1234').unlockCandidate).toBeNull();
  });

  it('survives exactly one transition', () => {
    const state = type('1234=');
    expect(state.unlockCandidate).toBe('1234');
    for (const key of ALL_KEYS) {
      expect(press(state, key).unlockCandidate).toBeNull();
    }
  });
});

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const states: CalculatorState[] = [
      INITIAL_STATE,
      type('12+34'),
      type('2+3='),
      type('5/0='),
      type('5+'),
    ];
    for (const state of states) {
      Object.freeze(state.tokens);
      Object.freeze(state);
      const before = JSON.stringify(state);
      for (const key of ALL_KEYS) expect(() => press(state, key)).not.toThrow();
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});
