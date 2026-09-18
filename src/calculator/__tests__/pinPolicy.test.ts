import { describePinError, isValidPin, looksLikePin, validatePin } from '@/calculator/pinPolicy';
import { PIN_POLICY, type PinValidationError } from '@/auth/types';

describe('validatePin', () => {
  it.each(['1234', '12345', '123456', '1234567', '12345678', '9999', '1000'])(
    'accepts %p',
    (pin) => {
      expect(validatePin(pin)).toBeNull();
      expect(isValidPin(pin)).toBe(true);
    },
  );

  it('accepts exactly the configured length range', () => {
    expect(PIN_POLICY.minLength).toBe(4);
    expect(PIN_POLICY.maxLength).toBe(8);
    expect(validatePin('1'.repeat(PIN_POLICY.minLength))).toBeNull();
    expect(validatePin('1'.repeat(PIN_POLICY.maxLength))).toBeNull();
    expect(validatePin('1'.repeat(PIN_POLICY.minLength - 1))).toBe('tooShort');
    expect(validatePin('1'.repeat(PIN_POLICY.maxLength + 1))).toBe('tooLong');
  });

  it.each<[string, PinValidationError]>([
    ['', 'notDigits'],
    ['abcd', 'notDigits'],
    ['12a4', 'notDigits'],
    ['12.34', 'notDigits'],
    ['-1234', 'notDigits'],
    ['1 234', 'notDigits'],
    [' 1234', 'notDigits'],
    ['1234 ', 'notDigits'],
    ['1234\n', 'notDigits'],
    ['1234٠', 'notDigits'],
    ['１２３４', 'notDigits'],
    ['1e5', 'notDigits'],
    ['123', 'tooShort'],
    ['1', 'tooShort'],
    ['123456789', 'tooLong'],
    ['1234567890123', 'tooLong'],
    ['0123', 'leadingZero'],
    ['0000', 'leadingZero'],
    ['00000000', 'leadingZero'],
  ])('rejects %p as %s', (pin, expected) => {
    expect(validatePin(pin)).toBe(expected);
    expect(isValidPin(pin)).toBe(false);
  });

  it('checks the digits rule before the length rules', () => {
    // '01' is short AND starts with zero, but it is the shortness that is reported.
    expect(validatePin('01')).toBe('tooShort');
    expect(validatePin('0')).toBe('tooShort');
    expect(validatePin('a')).toBe('notDigits');
    expect(validatePin('000000000')).toBe('tooLong');
  });
});

describe('looksLikePin', () => {
  it('is the same rule the calculator uses to spot an unlock attempt', () => {
    for (const text of ['1234', '99999999', '0123', '123', '12.34', '-1234', '']) {
      expect(looksLikePin(text)).toBe(isValidPin(text));
    }
    expect(looksLikePin('1234')).toBe(true);
    expect(looksLikePin('12.34')).toBe(false);
  });
});

describe('describePinError', () => {
  it.each<[PinValidationError, string]>([
    ['tooShort', 'Use at least 4 digits.'],
    ['tooLong', 'Use at most 8 digits.'],
    ['notDigits', 'Use digits only.'],
    ['leadingZero', 'The PIN cannot start with 0, because the calculator drops leading zeros.'],
  ])('describes %s', (error, message) => {
    expect(describePinError(error)).toBe(message);
  });
});
