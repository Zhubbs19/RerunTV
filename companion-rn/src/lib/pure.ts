// Pure helpers (no React Native imports) so they can be unit tested with plain
// node: address parsing, time formatting and the box's mode labels.

export const DEFAULT_PORT = 8725;

export interface ParsedTarget {
  baseUrl: string;
  /** The pairing code, when the input was a pairing URL that carried one. */
  code: string | null;
}

// Accepts what a person might paste or a QR code might hold:
//   "192.168.1.20", "192.168.1.20:8725", "http://host:8725/?pair=12345678"
// Returns null when no usable host can be found.
export function parseTarget(input: string): ParsedTarget | null {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  const port = url.port || (url.protocol === 'http:' ? String(DEFAULT_PORT) : '');
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  const baseUrl = `${url.protocol}//${host}${port ? `:${port}` : ''}`;
  const pair = url.searchParams.get('pair');
  return { baseUrl, code: pair ? normalizeCode(pair) : null };
}

// The box prints its 8-digit code with spaces or dashes; keep digits only.
export function normalizeCode(text: string): string {
  return String(text ?? '').replace(/[^0-9a-z]/gi, '');
}

export function minutesLeft(endsAtMs: number | null | undefined, now: number): number | null {
  if (typeof endsAtMs !== 'number' || !(endsAtMs > now)) return null;
  return Math.max(1, Math.round((endsAtMs - now) / 60000));
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatChannelNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
  const main = String(Math.trunc(Math.abs(n))).padStart(2, '0');
  if (Number.isInteger(n)) return main;
  return `${main}.${Math.round(Math.abs(n) * 10) % 10}`;
}

export const MODE_LABELS = {
  pictureMode: { standard: 'STANDARD', vivid: 'VIVID', cinema: 'CINEMA' } as Record<string, string>,
  aspectMode: { contain: 'STANDARD', stretch: 'STRETCH', fill: 'FILL' } as Record<string, string>,
  audioMode: { stereo: 'STEREO', sap: 'SAP', mono: 'MONO' } as Record<string, string>,
};

export function modeLabel(kind: keyof typeof MODE_LABELS, value: string | null | undefined): string {
  if (value == null) return '';
  return MODE_LABELS[kind][value] ?? String(value).toUpperCase();
}

export interface LineupRow {
  number: number;
  name: string;
  favorite: boolean;
  quickAccess: boolean;
  now: string;
  next: string;
  endsAtMs: number | null;
}

// Search by number or name, case-insensitive; "7" also finds 7.1.
export function filterChannels<T extends { number: number; name?: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => String(row.number).startsWith(q) || (row.name ?? '').toLowerCase().includes(q));
}

// Whether the box would skip the break on screen if asked (its BREAKS ›
// Skipping a break rule), so the phone only offers SKIP where it works.
export function canSkipBreak(state: { skipBreaks?: string; timeMachineOn?: boolean } | null | undefined): boolean {
  const rule = state?.skipBreaks ?? 'always';
  return rule === 'always' || (rule === 'timeMachine' && !!state?.timeMachineOn);
}

/** What a box reply turned out to be once read. */
export type BoxReply =
  | { kind: 'json'; value: unknown }
  | { kind: 'page' }
  | { kind: 'unreadable'; detail: string };

/**
 * A reply's size in words a person can read.
 * @param length Its length in characters.
 * @returns For example "1.5 MB", "12 KB" or "40 bytes".
 */
function describeSize(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MB`;
  if (length >= 1024) return `${Math.round(length / 1024)} KB`;
  return `${length} bytes`;
}

/**
 * Reads the body of a box reply the app expects to be JSON.
 * A web page is what the box sends a phone it no longer has a session for
 * (older boxes do so with a 200), so it means "pair again", not a parse error.
 * @param contentType The reply's Content-Type header, if any.
 * @param text The reply body.
 * @returns The parsed value, `page` for HTML, or `unreadable` with a short description of what came back.
 */
export function readBoxReply(contentType: string | null, text: string): BoxReply {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('text/html') || /^\s*<(!doctype|html)\b/i.test(text)) return { kind: 'page' };
  try {
    return { kind: 'json', value: JSON.parse(text) };
  } catch {
    const kind = type ? `, ${type.split(';')[0].trim()}` : '';
    return { kind: 'unreadable', detail: text.length ? `${describeSize(text.length)}${kind}` : `an empty reply${kind}` };
  }
}
