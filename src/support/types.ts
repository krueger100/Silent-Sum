/**
 * Customer service: the one place a user can deliberately send something off this device.
 *
 * Everything else in this app is offline by construction. A support message is the exception, so
 * it is modelled explicitly rather than hidden behind a helper: the user writes the text, sees the
 * diagnostics that will travel with it, and presses Send. Nothing is sent in the background, on a
 * schedule, or as a side effect of any other action.
 *
 * The transport is described by `SupportService` alone, so the app never depends on which provider
 * is behind it. `src/support/resendSupportService.ts` implements it against the Resend HTTP API
 * (or a relay that speaks the same shape).
 */

export type SupportTopic = 'unlock' | 'photos' | 'backup' | 'bug' | 'other';

export const SUPPORT_TOPICS: readonly SupportTopic[] = [
  'unlock',
  'photos',
  'backup',
  'bug',
  'other',
];

export const SUPPORT_TOPIC_LABEL: Readonly<Record<SupportTopic, string>> = {
  unlock: 'Unlocking and PIN',
  photos: 'Photos and the gallery',
  backup: 'Cloud backup and restore',
  bug: 'Something is broken',
  other: 'Something else',
};

export interface SupportMessage {
  readonly topic: SupportTopic;
  /** What the user typed. Scrubbed by the service before it is sent; never pre-trusted. */
  readonly body: string;
  /** Where a reply should go, or null when the user chose not to give an address. */
  readonly replyTo: string | null;
  /** The exact diagnostics block shown on screen, or null when the user excluded it. */
  readonly diagnostics: string | null;
}

/**
 * Why a send failed, in terms the screen can turn into copy.
 *
 * `configuration` means this build cannot send at all (bad or rejected credentials) - a user
 * retrying will never succeed, so the screen says so instead of offering a retry.
 */
export type SupportFailure =
  | 'unreachable'
  | 'configuration'
  | 'rejected'
  | 'rateLimited'
  | 'server'
  | 'unknown';

export type SupportSendResult =
  | { readonly kind: 'sent'; readonly reference: string | null }
  | { readonly kind: 'failed'; readonly reason: SupportFailure };

export interface SupportService {
  /** Never throws: transport and provider failures come back as a `failed` result. */
  send(message: SupportMessage): Promise<SupportSendResult>;
  /**
   * The support inbox this build was configured with, for screens that only need to SHOW it --
   * About, which is reachable while the vault is locked and cannot offer a send form.
   *
   * Optional so a test double does not have to invent one. It is build configuration, never a
   * credential and never anything the user typed.
   */
  readonly contact?: string;
}
