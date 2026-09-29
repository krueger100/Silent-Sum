/**
 * Messages this device has been told to hide: "delete for me".
 *
 * Deliberately local, and deliberately NOT a server record. Hiding a message is a decision about
 * what this person wants to look at, not a fact about the conversation -- the other side is not
 * told, and nothing about it needs to survive a reinstall. Writing it to Firestore would hand the
 * server a list of exactly which messages somebody chose not to look at any more, which is
 * metadata the rest of this feature is careful not to create. `VaultSendNotice` keeps its own
 * per-conversation state the same way and for the same reason.
 *
 * The consequence, and it is a real one: this does not follow the account to another device or
 * survive clearing app data. "Delete for everyone" does, because that one IS a fact about the
 * conversation.
 *
 * Ids are namespaced by conversation so a message id can never hide a message in another thread.
 * Every read is wrapped: an unreadable record reads as "nothing hidden", which shows a message
 * that should have been hidden rather than hiding one that should not have been. That is the
 * recoverable direction -- the user can hide it again, whereas a wrongly hidden message looks
 * like data loss.
 */
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';

/** Bounded so a long-lived install cannot grow this without limit. Oldest entries fall off. */
export const MAX_HIDDEN_MESSAGES = 2000;

interface HiddenRecord {
  readonly v: 1;
  /** `<conversationId>/<messageId>`, oldest first. */
  readonly hidden: readonly string[];
}

export function hiddenKey(conversationId: string, messageId: string): string {
  return `${conversationId}/${messageId}`;
}

export class HiddenMessages {
  constructor(private readonly store: SecureStore) {}

  /** Every hidden id in one conversation, as a set the caller can test cheaply per message. */
  async forConversation(conversationId: string): Promise<ReadonlySet<string>> {
    const prefix = `${conversationId}/`;
    const ids = new Set<string>();
    for (const entry of await this.read()) {
      if (entry.startsWith(prefix)) ids.add(entry.slice(prefix.length));
    }
    return ids;
  }

  async hide(conversationId: string, messageId: string): Promise<void> {
    const key = hiddenKey(conversationId, messageId);
    const current = await this.read();
    if (current.includes(key)) return;
    const next = [...current, key].slice(-MAX_HIDDEN_MESSAGES);
    const record: HiddenRecord = { v: 1, hidden: next };
    try {
      await this.store.write(SECURE_STORE_KEYS.hiddenMessages, JSON.stringify(record));
    } catch {
      // The message stays visible and can be hidden again. Losing the write is survivable;
      // throwing here would fail an action the user has already seen succeed on screen.
    }
  }

  private async read(): Promise<readonly string[]> {
    let raw: string | null;
    try {
      raw = await this.store.read(SECURE_STORE_KEYS.hiddenMessages);
    } catch {
      return [];
    }
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return [];
      const record = parsed as Partial<HiddenRecord>;
      if (record.v !== 1 || !Array.isArray(record.hidden)) return [];
      return record.hidden.filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }
}
