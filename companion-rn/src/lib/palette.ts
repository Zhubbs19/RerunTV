// The app's colour roles, and how they follow the paired box's theme. The box
// reports its box theme's colour tokens on /state (`theme`, see
// renderer/js/display/companion-theme.js); this file turns those few tokens
// into the full set of Material 3 roles the screens use, nudging any colour
// that would be hard to read. Pure, so it runs under node's test runner.

/** Every colour role a screen may use. */
export interface Palette {
  surface: string;
  surfaceDim: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
  outline: string;
  outlineVariant: string;
  onSurface: string;
  onSurfaceVariant: string;
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  success: string;
}

/** What the box says about its theme on /state. */
export interface BoxThemeReport {
  id: string;
  /** The box's on-screen layout: the two cable-guide skins, or every other pack. */
  ui?: 'cable-guide' | 'legacy';
  label?: string | null;
  /** Solid colours keyed by token name without the leading `--` (surface-0, accent, ...); null until known. */
  colors?: Record<string, string> | null;
}

/** The app's own look: amber primary, cyan tertiary, near-black surfaces. Used until a box reports a theme. */
export const DEFAULT_PALETTE: Palette = {
  surface: '#0E1114',
  surfaceDim: '#090B0D',
  surfaceContainerLow: '#12161A',
  surfaceContainer: '#171C21',
  surfaceContainerHigh: '#1E252B',
  surfaceContainerHighest: '#27303A',
  outline: '#5B6770',
  outlineVariant: '#39434B',
  onSurface: '#F0EEE6',
  onSurfaceVariant: '#A7B0B6',
  primary: '#F5B942',
  onPrimary: '#1F1500',
  primaryContainer: '#4A3300',
  onPrimaryContainer: '#FFDEA0',
  tertiary: '#65D7DD',
  onTertiary: '#00363A',
  tertiaryContainer: '#0B3F43',
  onTertiaryContainer: '#A5F2F7',
  error: '#FF8A7D',
  onError: '#3A0905',
  errorContainer: '#5E1B14',
  onErrorContainer: '#FFDAD5',
  success: '#50CE88',
};

const ROLES = Object.keys(DEFAULT_PALETTE) as (keyof Palette)[];

type Rgb = [number, number, number];

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/**
 * Reads a solid CSS colour: `#rgb`, `#rrggbb`, or `rgb()`/`rgba()` with full opacity.
 * @param value The colour text.
 * @returns The red, green and blue bytes, or null for anything else.
 */
export function parseColor(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(text);
  if (!fn) return null;
  if (fn[4] !== undefined) {
    const alpha = fn[4].endsWith('%') ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4]);
    if (alpha < 1) return null; // a see-through colour reads differently on every surface
  }
  const rgb = [fn[1], fn[2], fn[3]].map(Number);
  return rgb.every((n) => Number.isFinite(n)) ? (rgb.map(clampByte) as Rgb) : null;
}

/**
 * Writes bytes as `#RRGGBB`.
 * @param rgb The red, green and blue bytes.
 * @returns The hex colour.
 */
function toHex(rgb: Rgb): string {
  return `#${rgb.map((n) => clampByte(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * Blends two colours.
 * @param from The colour at `amount` 0.
 * @param to The colour at `amount` 1.
 * @param amount How far towards `to`, 0 to 1.
 * @returns The blend as `#RRGGBB`.
 */
export function mix(from: string, to: string, amount: number): string {
  const a = parseColor(from) ?? [0, 0, 0];
  const b = parseColor(to) ?? [0, 0, 0];
  return toHex(a.map((n, i) => n + (b[i] - n) * amount) as Rgb);
}

/**
 * WCAG relative luminance.
 * @param color A solid colour.
 * @returns 0 (black) to 1 (white).
 */
export function luminance(color: string): number {
  const rgb = parseColor(color) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colours.
 * @param a One colour.
 * @param b The other.
 * @returns 1 to 21.
 */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Moves a colour towards white or black (whichever reads better on `bg`) until it reaches a contrast ratio.
 * @param fg The colour wanted.
 * @param bg The colour it sits on.
 * @param min The ratio to reach.
 * @returns `fg` itself when it already reads, else the nearest blend that does.
 */
export function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return toHex(parseColor(fg) ?? [0, 0, 0]);
  const toward = contrast('#FFFFFF', bg) >= contrast('#000000', bg) ? '#FFFFFF' : '#000000';
  for (let step = 1; step <= 10; step++) {
    const candidate = mix(fg, toward, step / 10);
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return toward;
}

/**
 * The text colour for a filled background: the box's own choice when it reads, else black or white.
 * @param bg The background.
 * @param preferred The box's text colour for it, if any.
 * @returns A colour with at least 4.5:1 contrast where black or white can manage it.
 */
function textOn(bg: string, preferred: string | null): string {
  if (preferred && contrast(preferred, bg) >= 4.5) return preferred;
  return contrast('#FFFFFF', bg) >= contrast('#000000', bg) ? '#FFFFFF' : '#000000';
}

/**
 * Builds the app's palette from the box theme's colour tokens.
 * Needs at least a page surface, text and accent; every other role is derived when the box leaves it out.
 * @param report The `theme` field of the box's /state.
 * @returns The palette, or null when the report has too little to go on.
 */
export function paletteFromBoxTheme(report: BoxThemeReport | null | undefined): Palette | null {
  const colors = report && report.colors && typeof report.colors === 'object' ? report.colors : null;
  if (!colors) return null;
  const tok = (name: string): string | null => {
    const rgb = parseColor(colors[name]);
    return rgb ? toHex(rgb) : null;
  };
  const surface = tok('surface-0') ?? tok('surface-1');
  const text = tok('text');
  const accent = tok('accent');
  if (!surface || !text || !accent) return null;

  const s1 = tok('surface-1') ?? mix(surface, text, 0.04);
  const s2 = tok('surface-2') ?? mix(surface, text, 0.12);
  const surfaceContainer = mix(s1, s2, 0.45);
  const surfaceContainerHigh = mix(s1, s2, 0.8);
  // Tonal buttons: the box's own control colour, as long as its text still reads on it.
  const controlText = tok('control-text') ?? text;
  const control = tok('control-bg') ?? tok('surface-3') ?? mix(surface, text, 0.18);
  const surfaceContainerHighest = contrast(controlText, control) >= 4.5 || contrast(text, control) >= 4.5 ? control : (tok('surface-3') ?? s2);

  const onSurface = ensureContrast(text, surfaceContainerHighest, 4.5);
  const onSurfaceVariant = ensureContrast(tok('text-muted') ?? mix(text, surface, 0.35), surfaceContainerHigh, 4.5);
  const outline = ensureContrast(tok('border') ?? mix(surface, text, 0.35), surfaceContainer, 3);

  const primary = ensureContrast(accent, surfaceContainerHigh, 4.5);
  const primaryContainer = mix(surfaceContainer, primary, 0.3);
  const tertiary = ensureContrast(tok('accent-2') ?? accent, surfaceContainerHigh, 4.5);
  const tertiaryContainer = mix(surfaceContainer, tertiary, 0.28);
  const error = ensureContrast(tok('danger') ?? DEFAULT_PALETTE.error, surfaceContainerHigh, 4.5);
  const errorContainer = mix(surfaceContainer, error, 0.3);

  return {
    surface,
    surfaceDim: mix(surface, '#000000', 0.4),
    surfaceContainerLow: s1,
    surfaceContainer,
    surfaceContainerHigh,
    surfaceContainerHighest,
    outline,
    outlineVariant: mix(surfaceContainer, outline, 0.5),
    onSurface,
    onSurfaceVariant,
    primary,
    onPrimary: textOn(primary, tok('accent-text')),
    primaryContainer,
    onPrimaryContainer: ensureContrast(mix(primary, '#FFFFFF', 0.55), primaryContainer, 4.5),
    tertiary,
    onTertiary: textOn(tertiary, null),
    tertiaryContainer,
    onTertiaryContainer: ensureContrast(mix(tertiary, '#FFFFFF', 0.5), tertiaryContainer, 4.5),
    error,
    onError: textOn(error, null),
    errorContainer,
    onErrorContainer: ensureContrast(mix(error, '#FFFFFF', 0.7), errorContainer, 4.5),
    success: ensureContrast(DEFAULT_PALETTE.success, surfaceContainer, 3),
  };
}

/**
 * Checks a value read back from storage.
 * @param value Anything.
 * @returns Whether it has every role as a solid colour.
 */
export function isPalette(value: unknown): value is Palette {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ROLES.every((role) => parseColor(record[role]) !== null);
}

/**
 * Whether the screen is dark (light status-bar icons).
 * @param palette The palette.
 * @returns True for a dark surface.
 */
export function isDark(palette: Palette): boolean {
  return luminance(palette.surface) < 0.4;
}

/**
 * Picks the palette for what the box reported, keeping the current one while the answer is unknown.
 * @param current The palette on screen now.
 * @param stateLoaded Whether a /state answer has arrived.
 * @param report Its `theme` field: undefined from a box too old to send one, null or colourless while unknown.
 * @returns The palette to show.
 */
export function nextPalette(current: Palette, stateLoaded: boolean, report: BoxThemeReport | null | undefined): Palette {
  if (!stateLoaded) return current; // still connecting: keep the remembered look
  if (report === undefined) return DEFAULT_PALETTE; // an older box says nothing about its theme
  return paletteFromBoxTheme(report) ?? current;
}
