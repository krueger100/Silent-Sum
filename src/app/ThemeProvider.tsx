/**
 * Publishes the palette the user chose, so `useTheme` and `useStyles` resolve to it.
 *
 * It sits inside `ServicesProvider` (it reads the stored preference) and outside everything that
 * draws, so flipping night/day re-renders the whole tree without remounting it - no screen is lost
 * and no navigation state is reset. `paletteFor` returns one of two constants, so the context
 * value is referentially stable and the stylesheet cache in `theme.ts` keeps hitting.
 */
import React, { type ReactNode } from 'react';

import { useSettings } from '@/app/ServicesProvider';
import { ThemeContext, paletteFor } from '@/app/theme';

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { theme } = useSettings();
  return <ThemeContext.Provider value={paletteFor(theme)}>{children}</ThemeContext.Provider>;
}
