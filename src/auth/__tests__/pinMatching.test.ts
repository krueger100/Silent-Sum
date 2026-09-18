import {
  coverWith,
  describePartialMatch,
  emptyProgress,
  unlockDigitsOf,
  type PinProgress,
} from '@/auth/pinMatching';

const PIN = '12142907';

describe('unlockDigitsOf', () => {
  it('turns a whole non-negative result into digits', () => {
    expect(unlockDigitsOf(1)).toBe('1');
    expect(unlockDigitsOf(12)).toBe('12');
    expect(unlockDigitsOf(1214)).toBe('1214');
    expect(unlockDigitsOf(0)).toBe('0');
    expect(unlockDigitsOf(12142907)).toBe('12142907');
  });

  it('rejects anything that is not a run of digits', () => {
    expect(unlockDigitsOf(-1)).toBeNull();
    expect(unlockDigitsOf(1.5)).toBeNull();
    expect(unlockDigitsOf(Number.NaN)).toBeNull();
    expect(unlockDigitsOf(Number.POSITIVE_INFINITY)).toBeNull();
    // Beyond 2^53 the decimal expansion is no longer the number that was calculated.
    expect(unlockDigitsOf(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});

describe('coverWith', () => {
  /** The three examples from the spec, each from a standing start. */
  it.each<[string, string, number]>([
    ['2 - 1 = 1', '1', 7],
    ['6 + 6 = 12', '12', 6],
    ['1000 + 214 = 1214', '1214', 4],
  ])('counts what is still missing after %s', (_label, digits, missingDigits) => {
    expect(coverWith(emptyProgress(PIN), digits)).toMatchObject({ kind: 'partial', missingDigits });
  });

  it('completes on the whole PIN in one calculation', () => {
    expect(coverWith(emptyProgress(PIN), PIN).kind).toBe('complete');
  });

  it('adds the parts up until they account for the whole PIN', () => {
    const counted: number[] = [];
    let progress: PinProgress = emptyProgress(PIN);
    for (const digits of ['1', '12', '1214']) {
      const step = coverWith(progress, digits);
      expect(step.kind).toBe('partial');
      if (step.kind !== 'partial') throw new Error('unreachable');
      counted.push(step.missingDigits);
      progress = step.progress;
    }
    expect(counted).toEqual([7, 6, 4]);

    expect(coverWith(progress, '2907').kind).toBe('complete');
  });

  it('credits a repeated run to a position it has not covered yet', () => {
    // "1" sits at both ends of "1214": entering it twice covers both.
    const first = coverWith(emptyProgress(PIN), '1');
    expect(first).toMatchObject({ kind: 'partial', missingDigits: 7 });
    expect(coverWith(first.progress, '1')).toMatchObject({ kind: 'partial', missingDigits: 6 });
  });

  it('accepts a part that covers nothing new without losing ground', () => {
    const wide = coverWith(emptyProgress(PIN), '1214');
    expect(coverWith(wide.progress, '12')).toMatchObject({ kind: 'partial', missingDigits: 4 });
  });

  it.each<[string, string]>([
    ['a digit that is not in the PIN', '3'],
    ['a result that is not in the PIN', '49'],
    ['a subsequence that is not contiguous', '1227'],
    ['digits of the PIN that are not adjacent', '1249'],
    ['a result longer than the PIN', '121429070'],
  ])('leaves progress alone for %s', (_label, digits) => {
    const started = coverWith(emptyProgress(PIN), '12');
    const step = coverWith(started.progress, digits);
    expect(step.kind).toBe('none');
    expect(step.progress).toBe(started.progress);
  });

  it('never matches anything that is not a digit string', () => {
    for (const digits of ['', '1e3', '-1', '1.2']) {
      expect(coverWith(emptyProgress(PIN), digits).kind).toBe('none');
    }
    expect(coverWith(emptyProgress(''), '1').kind).toBe('none');
  });
});

describe('describePartialMatch', () => {
  it('reads the way the spec says', () => {
    expect(describePartialMatch('1', 7)).toBe('1 is correct, but there are 7 more');
    expect(describePartialMatch('12', 6)).toBe('12 is correct, but there are 6 more');
    expect(describePartialMatch('1214', 4)).toBe('1214 is correct, but there are 4 more');
  });

  it('stays grammatical for a single missing digit', () => {
    expect(describePartialMatch('1214290', 1)).toBe('1214290 is correct, but there is 1 more');
  });
});
