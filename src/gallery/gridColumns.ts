/**
 * How many columns a thumbnail grid should use for the width it has been given.
 *
 * The grids used to be a fixed three. Tile SIZE was already computed from the window, so nothing
 * ever clipped, but the count never moved: a 10-inch tablet in landscape has around 1280dp of
 * content width, which made three thumbnails of roughly 420dp each -- photographs, not thumbnails.
 *
 * Below Android's own large-screen breakpoint the answer stays three, so every phone keeps exactly
 * the layout it already had. Above it, columns are added to hold the tile near MAX_TILE instead of
 * letting a fixed count inflate it.
 *
 * Callers pass the width their grid actually gets to draw in -- the window less any horizontal safe
 * area -- not the window width, or the last column lands under the navigation bar in landscape.
 */

/** Phones keep three, whatever their width. */
export const MIN_COLUMNS = 3;

/** Android's large-screen breakpoint (sw600dp): the conventional phone/tablet divide. */
const TABLET_WIDTH = 600;

/** Above the breakpoint, enough columns to keep a tile no wider than this. */
const MAX_TILE = 180;

export function gridColumns(contentWidth: number): number {
  if (!Number.isFinite(contentWidth) || contentWidth < TABLET_WIDTH) return MIN_COLUMNS;
  return Math.max(MIN_COLUMNS, Math.ceil(contentWidth / MAX_TILE));
}
