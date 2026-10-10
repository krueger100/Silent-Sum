/**
 * Turning what the user typed into the email that is actually sent.
 *
 * Two rules matter here and both are enforced for the caller, not left to it:
 *
 *   1. The free text is scrubbed. A support inbox must never receive a PIN, and the likeliest way
 *      it ever would is a user writing "my code 12142907 stopped working". `scrub` removes digit
 *      runs of PIN length and anything path-shaped, exactly as it does for crash reports.
 *   2. The subject says "Calculator", not the product name. The reply lands in the user's own
 *      inbox, where a message headed with the name of a hidden-photo-vault app would undo the
 *      thing the app exists to do. The operator's inbox already knows what the mail is about.
 */
import { scrub } from '@/utils/scrub';

import { SUPPORT_TOPIC_LABEL, type SupportFailure, type SupportMessage } from '@/support/types';

/**
 * Why a send failed, in words. Shared by the two screens that can send: the full one inside the
 * vault, and the small composer on About that a locked-out user can still reach.
 */
export const SUPPORT_FAILURE_COPY: Readonly<Record<SupportFailure, string>> = {
  unreachable:
    'Could not reach the support service. Check your connection and send again - your message is still here.',
  configuration:
    'This build cannot send support messages: the service refused its credentials. Sending again will not help; please report this another way.',
  missing:
    'Support is not switched on for this build - the address it sends to has nothing behind it. There is nothing wrong with your message, and sending it again will not help.',
  rejected: 'The support service refused the message. Try shortening it, or check the reply address.',
  rateLimited: 'Too many messages have been sent just now. Please try again in a few minutes.',
  server: 'The support service is having trouble right now. Please try again later.',
  unknown: 'The message could not be sent. Please try again.',
};

/** The most a user can type. Long enough for a real description, short enough to bound a request. */
export const SUPPORT_BODY_MAX = 2000;

/** The disguise holds in the reply too: see the note above. */
export const SUPPORT_SUBJECT_PREFIX = 'Calculator support';

export interface SupportEmail {
  readonly subject: string;
  readonly text: string;
}

/**
 * Deliberately loose. This only decides whether to attach the address as a reply-to, and a real
 * address that this rejected would cost the user a reply they were expecting.
 */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return /^[^\s@,;]+@[^\s@,;.]+(?:\.[^\s@,;.]+)+$/.test(trimmed);
}

export function subjectFor(message: SupportMessage): string {
  return `${SUPPORT_SUBJECT_PREFIX}: ${SUPPORT_TOPIC_LABEL[message.topic]}`;
}

/** The body, exactly as the support inbox will receive it. */
export function bodyFor(message: SupportMessage): string {
  const sections = [scrub(message.body.trim().slice(0, SUPPORT_BODY_MAX))];
  sections.push(
    message.replyTo === null
      ? 'The sender did not leave a reply address.'
      : `Reply to: ${message.replyTo}`,
  );
  if (message.diagnostics !== null) sections.push(message.diagnostics);
  return sections.join('\n\n---\n\n');
}

export function buildSupportEmail(message: SupportMessage): SupportEmail {
  return { subject: subjectFor(message), text: bodyFor(message) };
}
