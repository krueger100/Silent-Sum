/**
 * A small LRU of decrypted image bytes with a byte budget.
 *
 * Decrypted pixels are the most sensitive thing the app holds, so the cache is bounded and is
 * wiped, not merely dropped, when the vault locks.
 *
 * Buffers evicted to make room are only unlinked: a component may still be rendering them, and
 * zeroing a buffer out from under a live `<Image>` would show a black square. Buffers removed
 * because the photo was deleted, or because the vault locked, are zeroed.
 */
import { zeroBytes, type Bytes } from '@/utils/bytes';

export class DecryptedImageCache {
  private readonly entries = new Map<string, Bytes>();
  private bytes = 0;

  constructor(readonly maxBytes: number) {}

  get size(): number {
    return this.entries.size;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  get(id: string): Bytes | null {
    const value = this.entries.get(id);
    if (value === undefined) return null;
    // Re-insert to move it to the most-recently-used end of the Map's iteration order.
    this.entries.delete(id);
    this.entries.set(id, value);
    return value;
  }

  put(id: string, value: Bytes): void {
    if (value.length > this.maxBytes) return;
    this.drop(id);
    this.entries.set(id, value);
    this.bytes += value.length;
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
    }
  }

  /** The photo is gone: wipe the plaintext rather than waiting for the collector. */
  remove(id: string): void {
    const value = this.entries.get(id);
    if (value === undefined) return;
    this.entries.delete(id);
    this.bytes -= value.length;
    zeroBytes(value);
  }

  /** The vault locked: wipe everything. */
  clear(): void {
    for (const value of this.entries.values()) zeroBytes(value);
    this.entries.clear();
    this.bytes = 0;
  }

  private drop(id: string): void {
    const value = this.entries.get(id);
    if (value === undefined) return;
    this.entries.delete(id);
    this.bytes -= value.length;
  }
}
