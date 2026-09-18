/**
 * The PIN rules live in the auth module, which owns them; the calculator only consumes them to
 * decide whether an `=` press on a bare number is an unlock attempt.
 *
 * This file exists so calculator code can import the rules without reaching into auth, and so
 * there is exactly one implementation of them. Do not fork it: a second copy that drifted would
 * mean the keypad and the authenticator disagreed about what counts as a PIN, which is how an
 * unlock attempt ends up being silently impossible to type.
 */
export { describePinError, isValidPin, looksLikePin, validatePin } from '@/auth/pinPolicy';
