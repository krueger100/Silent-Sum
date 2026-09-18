import { PIN_MAX_DIGITS, PIN_MIN_DIGITS, scrub } from '@/utils/scrub';

describe('scrub', () => {
  it.each([
    ['unlock failed for 123456', 'unlock failed for [redacted]'],
    ['year 2026 ok', 'year [redacted] ok'],
    ['C:\\Users\\x\\vault\\photos\\a.enc failed', '[path] failed'],
    ['/data/user/0/app/vault/index.enc bad', '[path] bad'],
    ['read /data/user/0/app/cache/picker/IMG_holiday.jpg', 'read [path]'],
    ['read /private/var/mobile/tmp/x.jpg', 'read [path]'],
  ])('rewrites %j', (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it('redacts every PIN length the app accepts, wherever it appears', () => {
    for (let length = PIN_MIN_DIGITS; length <= PIN_MAX_DIGITS; length++) {
      const pin = '9081726354'.slice(0, length);
      for (const message of [
        pin,
        `pin=${pin}`,
        `wrong pin ${pin} after 3 tries`,
        `"${pin}"`,
        `[${pin}]`,
      ]) {
        const scrubbed = scrub(message);
        expect(scrubbed).not.toContain(pin);
        expect(scrubbed).toContain('[redacted]');
      }
    }
  });

  it('leaves digit runs that cannot be a PIN alone', () => {
    expect(scrub('id 123')).toBe('id 123');
    expect(scrub('attempt 1 of 3')).toBe('attempt 1 of 3');
    expect(scrub('handle 123456789')).toBe('handle 123456789');
    expect(scrub('epoch 1789123456789 ms')).toBe('epoch 1789123456789 ms');
  });

  it('does not let a digit run inside a longer run be redacted piecemeal', () => {
    const scrubbed = scrub('0123456789012345');
    expect(scrubbed).toBe('0123456789012345');
    expect(scrubbed).not.toContain('[redacted]');
  });

  it('removes paths that would prove a vault exists', () => {
    expect(scrub('open /storage/emulated/0/vault.db')).toBe('open [path]');
    expect(scrub('open /sdcard/Android/data/app/files')).toBe('open [path]');
    expect(scrub('stat /home/carlo/notes.txt')).toBe('stat [path]');
    expect(scrub('stat /Users/carlo/notes.txt')).toBe('stat [path]');
    // Rooted anywhere, as long as it mentions the vault.
    expect(scrub('missing /srv/backup/vault/photos/9.enc')).toBe('missing [path]');
  });

  it('stops a path at whitespace and at quotes so surrounding prose survives', () => {
    expect(scrub("failed on '/data/app/x.enc' twice")).toBe("failed on '[path]' twice");
    expect(scrub('a /var/tmp/b c')).toBe('a [path] c');
  });

  it('is a no-op for text with nothing to hide', () => {
    expect(scrub('vault locked')).toBe('vault locked');
    expect(scrub('')).toBe('');
  });

  it('never leaves both a PIN and a path when they appear together', () => {
    const scrubbed = scrub('pin 4821 wrote /data/user/0/com.kruegerco.silentsum/vault/1.enc');
    expect(scrubbed).not.toContain('4821');
    expect(scrubbed).not.toContain('/data');
    expect(scrubbed).toBe('pin [redacted] wrote [path]');
  });
});
