import { describeTransfer } from '@/messaging/mediaProgress';

describe('what the viewer says while a chat video is being fetched', () => {
  it('counts the download as a percentage once the size is known', () => {
    expect(describeTransfer({ transferred: 0, total: 1000 })).toBe('Downloading… 0%');
    expect(describeTransfer({ transferred: 500, total: 1000 })).toBe('Downloading… 50%');
    expect(describeTransfer({ transferred: 1000, total: 1000 })).toBe('Downloading… 100%');
  });

  it('rounds down, so it never claims to be finished before it is', () => {
    expect(describeTransfer({ transferred: 999, total: 1000 })).toBe('Downloading… 99%');
    expect(describeTransfer({ transferred: 1, total: 1000 })).toBe('Downloading… 0%');
  });

  it('says plainly that it is downloading when the size is unknown', () => {
    // Some providers report a total of zero until the first chunk lands; a percentage of an
    // unknown total is worse than no percentage.
    expect(describeTransfer({})).toBe('Downloading…');
    expect(describeTransfer({ transferred: 400, total: 0 })).toBe('Downloading…');
    expect(describeTransfer({ transferred: 400 })).toBe('Downloading…');
  });

  it('survives nonsense from the transfer rather than showing it', () => {
    expect(describeTransfer({ transferred: 2000, total: 1000 })).toBe('Downloading… 100%');
    expect(describeTransfer({ transferred: -5, total: 1000 })).toBe('Downloading… 0%');
    expect(describeTransfer({ transferred: Number.NaN, total: 1000 })).toBe('Downloading…');
    expect(describeTransfer({ transferred: 500, total: Number.NaN })).toBe('Downloading…');
  });

  it('names the second phase, which is the one with no percentage to give', () => {
    // The object is a single sealed box: it opens in one go or not at all, so there is no
    // fraction to report. Saying which phase it is in is the whole point -- forty seconds of the
    // same spinner is what made this look broken.
    expect(describeTransfer({ opening: true })).toBe('Decrypting…');
    expect(describeTransfer({ opening: true, transferred: 1000, total: 1000 })).toBe('Decrypting…');
  });
});
