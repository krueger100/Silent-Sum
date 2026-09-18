/**
 * Rules for the cloud recovery passphrase.
 *
 * This is a different secret from the PIN and protects a key that lives off-device, where an
 * attacker can grind offline without any throttle, so it is a passphrase rather than four digits
 * and it is stretched with a heavier Argon2id preset.
 */
import { InvalidPassphraseError, PASSPHRASE_MIN_LENGTH } from '@/backup/types';

export function validatePassphrase(passphrase: string): string | null {
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) {
    return `Use at least ${String(PASSPHRASE_MIN_LENGTH)} characters.`;
  }
  if (passphrase.trim() !== passphrase) {
    return 'Remove leading or trailing spaces.';
  }
  return null;
}

export function assertValidPassphrase(passphrase: string): void {
  const problem = validatePassphrase(passphrase);
  if (problem !== null) throw new InvalidPassphraseError(problem);
}
