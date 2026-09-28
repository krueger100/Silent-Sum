/**
 * The column count is the one piece of the grid that is pure arithmetic, and the one that is easy
 * to regress: the failure it exists to prevent -- three thumbnails inflating to 420dp apiece on a
 * tablet -- is invisible on the phone anyone develops against.
 *
 * The phone cases are the ones that must not move. The grids were three columns before this
 * function existed, and every phone should keep exactly that.
 */
import { gridColumns, MIN_COLUMNS } from '@/gallery/gridColumns';

describe('gridColumns', () => {
  it.each([
    ['small phone', 320],
    ['common phone', 360],
    ['Pixel-class phone', 411],
    ['large phone', 480],
    ['just under the breakpoint', 599],
  ])('keeps %s at three columns', (_label, width) => {
    expect(gridColumns(width)).toBe(MIN_COLUMNS);
  });

  it.each([
    ['7-inch portrait', 600, 4],
    ['10-inch portrait', 800, 5],
    ['10-inch landscape', 1280, 8],
  ])('opens %s out to more columns', (_label, width, expected) => {
    expect(gridColumns(width)).toBe(expected);
  });

  it('never returns fewer than three, whatever the width', () => {
    for (const width of [0, 1, 100, 320, 600, 2400]) {
      expect(gridColumns(width)).toBeGreaterThanOrEqual(MIN_COLUMNS);
    }
  });

  it('holds the tile within a sensible size on every width it is given', () => {
    // What the count is actually for: the tile must not balloon just because the screen did.
    for (let width = 600; width <= 2400; width += 20) {
      expect(width / gridColumns(width)).toBeLessThanOrEqual(180);
    }
  });

  it('survives a width that has not been measured yet', () => {
    // useWindowDimensions can hand back 0, and NaN is one subtraction away from a missing inset.
    expect(gridColumns(0)).toBe(MIN_COLUMNS);
    expect(gridColumns(Number.NaN)).toBe(MIN_COLUMNS);
  });
});
