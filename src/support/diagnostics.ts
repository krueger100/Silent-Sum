/**
 * The "app details" block that can travel with a support message.
 *
 * Short on purpose, and shown to the user verbatim before anything is sent. It answers the two
 * questions a support reply actually needs - which build, which platform - and deliberately
 * carries no identifier: no device id, no install id, no account, no photo count, nothing derived
 * from the vault. There is nothing in here that could link two messages to the same person.
 */
export interface DiagnosticsInput {
  readonly appVersion: string;
  /** `Platform.OS`. */
  readonly platform: string;
  /** `Platform.Version`, already stringified. */
  readonly osVersion: string;
  /** Whether this build has any cloud configuration at all. */
  readonly cloudConfigured: boolean;
  readonly backupEnabled: boolean;
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const cloud = !input.cloudConfigured
    ? 'not available in this build'
    : input.backupEnabled
      ? 'on'
      : 'off';
  return [
    'App details',
    `App version: ${input.appVersion}`,
    `System: ${input.platform} ${input.osVersion}`,
    `Cloud backup: ${cloud}`,
  ].join('\n');
}
