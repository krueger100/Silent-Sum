/**
 * The calculator's view of the unlock rule.
 *
 * Re-exported so the calculator never reaches into `@/auth` for it: the engine only needs to turn
 * a computed number into the digits that get offered to the authenticator, and the screen only
 * needs the sentence to show. What those digits mean is decided in `@/auth/pinMatching`.
 */
export { describePartialMatch, unlockDigitsOf } from '@/auth/pinMatching';
