import { describeCloudError } from '@/backup/screens/cloudErrors';
import { BackupNotEnabledError, InvalidPassphraseError, WrongPassphraseError } from '@/backup/types';
import { CLOUD_ERROR_CODES } from '@/firebase/cloudBackend';
import { CloudError } from '@/firebase/types';

describe('describeCloudError', () => {
  it.each([
    [CLOUD_ERROR_CODES.wrongPassword, /Wrong email or password/],
    [CLOUD_ERROR_CODES.emailAlreadyInUse, /already exists/],
    [CLOUD_ERROR_CODES.unauthenticated, /Sign in/],
    [CLOUD_ERROR_CODES.permissionDenied, /refused/],
    [CLOUD_ERROR_CODES.objectNotFound, /no longer in the cloud/],
    ['network-request-failed', /No network connection/],
  ])('maps %s to friendly copy', (code, expected) => {
    expect(describeCloudError(new CloudError(code))).toMatch(expected);
  });

  it('falls back to a generic sentence for an unknown code', () => {
    expect(describeCloudError(new CloudError('something-new'))).toBe(
      'The backup service reported a problem. Try again.',
    );
    expect(describeCloudError(new Error('boom'))).toBe('Something went wrong. Nothing was changed.');
  });

  it('never leaks the SDK message, which can carry identifiers and paths', () => {
    const error = new CloudError(CLOUD_ERROR_CODES.permissionDenied, 'users/uid_deadbeef/vault');
    expect(describeCloudError(error)).not.toContain('uid_deadbeef');
  });

  it('describes the backup-specific failures', () => {
    expect(describeCloudError(new WrongPassphraseError())).toMatch(/Wrong recovery passphrase/);
    expect(describeCloudError(new BackupNotEnabledError())).toMatch(/no backup yet/);
    expect(describeCloudError(new InvalidPassphraseError('Use at least 12 characters.'))).toBe(
      'Use at least 12 characters.',
    );
  });
});
