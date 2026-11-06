// Material 3 structure (tonal surface roles, shape scale, 48dp targets, state
// layers) wearing the paired box's colours: its theme's surfaces, text and
// accent (src/lib/palette.ts), or the app's own amber-on-black until a box
// reports one. Condensed all-caps labels and LED-style numerals either way.
//
// Screens read colours through useTheme() and build styles with makeStyles(),
// so a theme change on the box repaints the app. The last palette is kept in
// secure storage and read synchronously at launch, so the app opens in the
// box's colours instead of flashing the default first.
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, type TextStyle } from 'react-native';
import { useBox } from './lib/session';
import { DEFAULT_PALETTE, isDark, isPalette, nextPalette, type Palette } from './lib/palette';

export type { Palette } from './lib/palette';

// M3 shape scale.
export const shape = { xs: 4, sm: 8, md: 12, lg: 16, xl: 28, full: 999 } as const;

// 4dp grid.
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const TARGET = 48; // minimum touch target (dp)

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * The type scale in a palette's colours.
 * @param color The palette.
 * @returns Text styles by role.
 */
export function makeType(color: Palette) {
  return {
    display: { fontFamily: mono, fontSize: 44, fontWeight: '700', letterSpacing: 2, color: color.primary } as TextStyle,
    headline: { fontSize: 22, fontWeight: '800', letterSpacing: 1.5, color: color.onSurface } as TextStyle,
    title: { fontSize: 16, fontWeight: '800', letterSpacing: 1.2, color: color.onSurface } as TextStyle,
    body: { fontSize: 14, fontWeight: '600', letterSpacing: 0.4, color: color.onSurface } as TextStyle,
    label: { fontSize: 12, fontWeight: '800', letterSpacing: 1.4, color: color.onSurfaceVariant } as TextStyle,
    eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 2.2, color: color.tertiary } as TextStyle,
    led: { fontFamily: mono, fontSize: 14, fontWeight: '700', letterSpacing: 1, color: color.primary } as TextStyle,
  };
}

export type TypeScale = ReturnType<typeof makeType>;

export interface Theme {
  color: Palette;
  type: TypeScale;
  /** Dark surfaces: light status-bar icons. */
  dark: boolean;
}

/**
 * Bundles a palette with its type scale.
 * @param color The palette.
 * @returns The theme.
 */
function themeOf(color: Palette): Theme {
  return { color, type: makeType(color), dark: isDark(color) };
}

const DEFAULT_THEME = themeOf(DEFAULT_PALETTE);

// ---------- Remembered palette ----------

const STORE_KEY = 'reruntv_palette';

/**
 * Reads the last palette synchronously (secure storage on a phone, localStorage on the web build).
 * @returns The palette, or null when none is stored or it does not read.
 */
function readStoredPalette(): Palette | null {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(STORE_KEY) : SecureStore.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPalette(parsed) ? parsed : null;
  } catch {
    return null; // no storage (or a corrupt entry): start from the default
  }
}

/**
 * Remembers a palette, or forgets it when given null. Failures only cost the next launch its colours.
 * @param palette The palette to keep, or null.
 */
function storePalette(palette: Palette | null): void {
  const raw = palette ? JSON.stringify(palette) : null;
  try {
    if (Platform.OS === 'web') {
      if (raw) globalThis.localStorage?.setItem(STORE_KEY, raw);
      else globalThis.localStorage?.removeItem(STORE_KEY);
      return;
    }
    const done = raw ? SecureStore.setItemAsync(STORE_KEY, raw) : SecureStore.deleteItemAsync(STORE_KEY);
    done.catch((e) => { if (__DEV__) console.warn('[theme] could not remember the palette', e); });
  } catch (e) {
    if (__DEV__) console.warn('[theme] could not remember the palette', e);
  }
}

// ---------- Provider ----------

const ThemeContext = createContext<Theme>(DEFAULT_THEME);

/**
 * The current theme: the paired box's colours, or the app default.
 * @returns The theme.
 */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Follows the paired box's theme (its /state `theme` field). Must sit inside SessionProvider.
 * @param props.children The app.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { loaded, session, state } = useBox();
  const [palette, setPalette] = useState<Palette>(() => readStoredPalette() ?? DEFAULT_PALETTE);
  const stored = useRef(JSON.stringify(palette));

  useEffect(() => {
    if (!loaded) return; // the saved pairing is still being read
    // Unpaired: back to the app's own look, so another box doesn't open in this one's colours.
    const next = session ? nextPalette(palette, state != null, state?.theme) : DEFAULT_PALETTE;
    const key = JSON.stringify(next);
    if (key === JSON.stringify(palette)) return;
    setPalette(next);
    if (key !== stored.current) {
      stored.current = key;
      storePalette(session ? next : null);
    }
  }, [loaded, session, state, palette]);

  const theme = useMemo(() => (palette === DEFAULT_PALETTE ? DEFAULT_THEME : themeOf(palette)), [palette]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

// The constraint StyleSheet.create puts on its argument, so style literals keep
// their exact types ('row', not string) when they come out of a factory.
type AnyStyles = Parameters<typeof StyleSheet.create>[0];

/**
 * Makes a hook that builds a component's StyleSheet for the current theme, once per theme.
 * @param factory Builds the style object from the palette (and the full theme).
 * @returns A hook returning the styles.
 * @example
 * const useStyles = makeStyles((color) => ({ card: { backgroundColor: color.surfaceContainer } }));
 */
export function makeStyles<T extends AnyStyles>(factory: (color: Palette, theme: Theme) => T & AnyStyles): () => Readonly<T> {
  const cache = new WeakMap<Theme, Readonly<T>>();
  return function useStyles(): Readonly<T> {
    const theme = useTheme();
    const cached = cache.get(theme);
    if (cached) return cached;
    const styles = StyleSheet.create(factory(theme.color, theme));
    cache.set(theme, styles);
    return styles;
  };
}
