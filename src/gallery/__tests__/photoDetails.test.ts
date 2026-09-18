import {
  formatDimensions,
  formatSizeBytes,
  formatSource,
  formatTaken,
} from '@/gallery/photoDetails';

describe('photo details formatting', () => {
  it('scales byte sizes the way the reference build does', () => {
    expect(formatSizeBytes(0)).toBe('0 B');
    expect(formatSizeBytes(1023)).toBe('1023 B');
    expect(formatSizeBytes(1024)).toBe('1 KB');
    expect(formatSizeBytes(1024 * 1024 - 1)).toBe('1024 KB');
    expect(formatSizeBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(formatSizeBytes(-1)).toBe('0 B');
  });

  it('uses a multiplication sign between dimensions', () => {
    expect(formatDimensions({ width: 4032, height: 3024 })).toBe('4032 × 3024');
  });

  it('names the source, with the original file name when there is one', () => {
    expect(formatSource({ source: 'camera', originalName: null })).toBe('Camera');
    expect(formatSource({ source: 'import', originalName: null })).toBe('Imported');
    expect(formatSource({ source: 'import', originalName: 'beach.jpg' })).toBe(
      'Imported (beach.jpg)',
    );
    expect(formatSource({ source: 'restore', originalName: null })).toBe('Restored from backup');
  });

  it('formats the capture time in local time', () => {
    // Midday UTC, so the calendar year is the same in every timezone.
    expect(formatTaken(Date.UTC(2026, 0, 1, 12, 0, 0))).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, 2026 \d{1,2}:\d{2} (AM|PM)$/,
    );
    expect(formatTaken(Number.NaN)).toBe('Unknown');
  });
});
