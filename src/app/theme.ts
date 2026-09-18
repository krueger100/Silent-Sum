/**
 * Visual tokens, in two palettes.
 *
 * The app presents itself as an ordinary calculator, so both palettes are deliberately
 * unremarkable and the vault screens reuse the same tokens rather than announcing themselves with
 * a different identity. Night is the default: it is what the screens were designed against, and a
 * calculator that opens dark is the ordinary thing.
 *
 * Colours are read through `useTheme` / `useStyles` rather than imported directly, because a
 * `StyleSheet.create` at module scope copies the values it is given once, at import time - a
 * palette swapped afterwards would never reach it. Screens therefore declare a `makeStyles`
 * factory and call `useStyles(makeStyles)`, which builds the sheet once per palette and caches it.
 * Spacing, radius and typography do not change with the theme and stay plain imports.
 */
import { createContext, useContext, useMemo } from 'react';

export interface Palette {
  /** Whether this is the night palette. Drives the status bar and the navigator theme. */
  readonly dark: boolean;
  readonly background: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly accentText: string;
  readonly danger: string;
  readonly success: string;
  /** The app-switcher cover. Opaque by definition: it exists to hide the screen. */
  readonly curtain: string;
}

export const DARK_PALETTE: Palette = {
  dark: true,
  background: '#111827',
  surface: '#1F2937',
  surfaceAlt: '#374151',
  border: '#4B5563',
  text: '#F9FAFB',
  textMuted: '#9CA3AF',
  accent: '#3D5AFE',
  accentText: '#FFFFFF',
  danger: '#EF4444',
  success: '#10B981',
  curtain: '#0B1220',
};

export const LIGHT_PALETTE: Palette = {
  dark: false,
  background: '#F3F4F6',
  surface: '#FFFFFF',
  surfaceAlt: '#E5E7EB',
  border: '#D1D5DB',
  text: '#111827',
  textMuted: '#6B7280',
  accent: '#3D5AFE',
  accentText: '#FFFFFF',
  danger: '#DC2626',
  success: '#047857',
  curtain: '#E5E7EB',
};

export type ThemeMode = 'night' | 'day';

export function paletteFor(mode: ThemeMode): Palette {
  return mode === 'day' ? LIGHT_PALETTE : DARK_PALETTE;
}

/** Dark by default, so a component rendered outside the provider still looks like the app. */
export const ThemeContext = createContext<Palette>(DARK_PALETTE);

export function useTheme(): Palette {
  return useContext(ThemeContext);
}

/**
 * The stylesheet for the current palette.
 *
 * `factory` must be defined at module scope: it is the cache key, so one sheet is built per
 * factory per palette and reused afterwards. A factory declared inside a component would build a
 * new sheet on every render.
 */
export function useStyles<T>(factory: (colors: Palette) => T): T {
  const palette = useTheme();
  return useMemo(() => sheetFor(factory, palette), [factory, palette]);
}

const SHEETS = new WeakMap<(colors: Palette) => unknown, Map<Palette, unknown>>();

function sheetFor<T>(factory: (colors: Palette) => T, palette: Palette): T {
  let byPalette = SHEETS.get(factory);
  if (byPalette === undefined) {
    byPalette = new Map<Palette, unknown>();
    SHEETS.set(factory, byPalette);
  }
  let sheet = byPalette.get(palette);
  if (sheet === undefined) {
    sheet = factory(palette);
    byPalette.set(palette, sheet);
  }
  return sheet as T;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 56, fontWeight: '300' },
  title: { fontSize: 22, fontWeight: '600' },
  body: { fontSize: 16, fontWeight: '400' },
  label: { fontSize: 14, fontWeight: '500' },
  caption: { fontSize: 12, fontWeight: '400' },
} as const;

/** Human text for a duration, used by the throttle notice and the backup timestamps. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) {
    return `${String(totalSeconds)} second${totalSeconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
}
