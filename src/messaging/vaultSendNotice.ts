/**
 * Which conversations have already been told what sending from the vault means.
 *
 * Sending a vault item to a conversation uploads a copy and ends the "never leaves this device"
 * property for that copy. The original is untouched, but it must not happen silently -- so the
 * first vault send in each conversation shows a short explanation first.
 *
 * Per conversation, deliberately:
 *
 *  - not per send, because a dialog seen on every send is one people learn to dismiss without
 *    reading, which is worse than showing none at all;
 *  - not once per install, because *who* the copy is going to is the part that matters, and
 *    somebody who understood it for one correspondent has not thereby decided it for every
 *    other one.
 *
 * Every read is wrapped: an unreadable record reads as "nothing seen", so a corrupt row makes the
 * app ask again rather than making it send silently. Failing toward the explanation is the only
 * safe direction here.
 */
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';

interface NoticeRecord {
  readonly v: 1;
  readonly conversations: readonly string[];
}

export class VaultSendNotice {
  constructor(private readonly store: SecureStore) {}

  async hasSeen(conversationId: string): Promise<boolean> {
    return (await this.read()).includes(conversationId);
  }

  async markSeen(conversationId: string): Promise<void> {
    const seen = await this.read();
    if (seen.includes(conversationId)) return;
    const record: NoticeRecord = { v: 1, conversations: [...seen, conversationId] };
    try {
      await this.store.write(SECURE_STORE_KEYS.vaultSendNotice, JSON.stringify(record));
    } catch {
      // Worst case the explanation is shown again next time, which is the harmless direction.
    }
  }

  private async read(): Promise<readonly string[]> {
    let raw: string | null;
    try {
      raw = await this.store.read(SECURE_STORE_KEYS.vaultSendNotice);
    } catch {
      return [];
    }
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return [];
      const record = parsed as Partial<NoticeRecord>;
      if (record.v !== 1 || !Array.isArray(record.conversations)) return [];
      return record.conversations.filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }
}
