// Screen-size rules, kept pure so they can be unit tested. Widths are in dp
// (iPhone SE 320-375, most phones 360-430, tablets and landscape 600+).

export type SizeClass = 'compact' | 'regular' | 'large' | 'wide';

export const BREAKPOINTS = { compact: 360, large: 430, wide: 700 } as const;

export function sizeClass(width: number): SizeClass {
  if (width < BREAKPOINTS.compact) return 'compact';
  if (width < BREAKPOINTS.large) return 'regular';
  if (width < BREAKPOINTS.wide) return 'large';
  return 'wide';
}

// How many equal columns of at least `minCell` dp fit in `available`, within [min, max].
export function columnsFor(available: number, minCell: number, gap: number, min = 1, max = 6): number {
  const fit = Math.floor((available + gap) / (minCell + gap));
  return Math.max(min, Math.min(max, fit));
}

// Readable content width: phones use everything, bigger screens stay in a
// centered column so buttons do not stretch across a tablet.
export const MAX_CONTENT_WIDTH = 560;
export const MAX_WIDE_CONTENT_WIDTH = 1040;

export interface LayoutInfo {
  width: number;
  height: number;
  sizeClass: SizeClass;
  isCompact: boolean;
  isWide: boolean;
  landscape: boolean;
  /** Side-by-side Remote layout: tablets and landscape phones. */
  twoColumn: boolean;
  /** Width the page content gets after side insets and the readable-width cap. */
  contentWidth: number;
  /** Keys for the D-pad and similar, shrunk on small screens. */
  padKey: number;
  /** Columns for quick channel buttons. */
  quickColumns: number;
}

export function computeLayout(width: number, height: number, insetLeft = 0, insetRight = 0, gutter = 16): LayoutInfo {
  const cls = sizeClass(width);
  const landscape = width > height;
  const twoColumn = width >= BREAKPOINTS.wide;
  const usable = Math.max(0, width - insetLeft - insetRight - gutter * 2);
  const contentWidth = Math.min(usable, twoColumn ? MAX_WIDE_CONTENT_WIDTH : MAX_CONTENT_WIDTH);
  const columnWidth = twoColumn ? (contentWidth - gutter) / 2 : contentWidth;
  return {
    width,
    height,
    sizeClass: cls,
    isCompact: cls === 'compact',
    isWide: cls === 'wide',
    landscape,
    twoColumn,
    contentWidth,
    padKey: cls === 'compact' ? 68 : 84,
    quickColumns: columnsFor(columnWidth - 32, 92, 8, 2, 4),
  };
}
