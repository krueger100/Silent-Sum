/**
 * What a vault PIN may look like.
 *
 * The PIN is typed on a calculator keypad and must survive being displayed there verbatim, so it
 * is a plain integer: digits only, 4 to 8 of them, and no leading zero because a calculator drops
 * it. Those rules are also what lets the calculator recognise an unlock attempt without any
 * dedicated UI.
 */
import { PIN_POLICY, type PinValidationError } from '@/auth/types';

const DIGITS = /^[0-9]+$/;

export function validatePin(pin: string): PinValidationError | null {
  if (pin.length === 0 || !DIGITS.test(pin)) return 'notDigits';
  if (pin.length < PIN_POLICY.minLength) return 'tooShort';
  if (pin.length > PIN_POLICY.maxLength) return 'tooLong';
  if (pin.startsWith('0')) return 'leadingZero';
  return null;
}

export function isValidPin(pin: string): boolean {
  return validatePin(pin) === null;
}

/**
 * Whether a piece of calculator input has the shape of a PIN, and therefore whether pressing `=`
 * on it should be treated as an unlock attempt. Same rules as {@link validatePin}.
 */
export function looksLikePin(text: string): boolean {
  return isValidPin(text);
}

export function describePinError(error: PinValidationError): string {
  switch (error) {
    case 'tooShort':
      return `Use at least ${String(PIN_POLICY.minLength)} digits.`;
    case 'tooLong':
      return `Use at most ${String(PIN_POLICY.maxLength)} digits.`;
    case 'notDigits':
      return 'Use digits only.';
    case 'leadingZero':
      return 'The PIN cannot start with 0, because the calculator drops leading zeros.';
    case 'sameAsVaultPin':
      return 'That is your vault PIN. The wipe PIN has to be a different number.';
    case 'partOfVaultPin':
      return (
        'That overlaps your vault PIN. Because the vault opens on a part of the PIN, this one ' +
        'could fire while you were unlocking. Choose a number that shares no run of digits with it.'
      );
    case 'clashesWithWipePin':
      return (
        'That clashes with your wipe PIN, so it could destroy the vault instead of opening it. ' +
        'Choose a number that shares no run of digits with your wipe PIN.'
      );
    default:
      return 'That PIN cannot be used.';
  }
}
