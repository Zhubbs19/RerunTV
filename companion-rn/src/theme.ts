// Material 3 structure (tonal surface roles, shape scale, 48dp targets, state
// layers) wearing the cable box's colours: amber primary, cyan tertiary, near-
// black surfaces, condensed all-caps labels and LED-style numerals.
import { Platform, type TextStyle } from 'react-native';

export const color = {
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
} as const;

// M3 shape scale.
export const shape = { xs: 4, sm: 8, md: 12, lg: 16, xl: 28, full: 999 } as const;

// 4dp grid.
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const TARGET = 48; // minimum touch target (dp)

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const type = {
  display: { fontFamily: mono, fontSize: 44, fontWeight: '700', letterSpacing: 2, color: color.primary } as TextStyle,
  headline: { fontSize: 22, fontWeight: '800', letterSpacing: 1.5, color: color.onSurface } as TextStyle,
  title: { fontSize: 16, fontWeight: '800', letterSpacing: 1.2, color: color.onSurface } as TextStyle,
  body: { fontSize: 14, fontWeight: '600', letterSpacing: 0.4, color: color.onSurface } as TextStyle,
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 1.4, color: color.onSurfaceVariant } as TextStyle,
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 2.2, color: color.tertiary } as TextStyle,
  led: { fontFamily: mono, fontSize: 14, fontWeight: '700', letterSpacing: 1, color: color.primary } as TextStyle,
};
