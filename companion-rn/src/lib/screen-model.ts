// What the box's screen shows, as the box describes it (GET /api/ui, built by
// renderer/js/remote/companion-control.js), and the helpers the SCREEN tab
// draws it with. Pure: no React Native imports, so node tests cover it.

export type ItemKind =
  | 'button' | 'tab' | 'option' | 'link' | 'checkbox' | 'switch' | 'radio'
  | 'select' | 'range' | 'number' | 'text' | 'textarea' | 'password';

export interface ScreenItem {
  index: number;
  kind: ItemKind;
  label: string;
  group: string;
  disabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  /** Why the phone may not press or change this (a host-only setting). */
  locked?: string;
  checked?: boolean;
  value?: string | number | null;
  options?: { value: string; label: string; disabled?: boolean }[];
  min?: number;
  max?: number;
  step?: number;
  /** A credential: the box never sends its value. */
  secret?: boolean;
  placeholder?: string;
}

export interface ScreenSnapshot {
  id: number;
  screen: 'tv' | 'setup';
  mode: 'tv' | 'desktop';
  kind: 'dialog' | 'setup' | 'tv';
  title: string;
  trail: string[];
  locked?: string;
  focusedIndex: number | null;
  items: ScreenItem[];
  truncated: boolean;
}

export interface ItemGroup {
  title: string;
  items: ScreenItem[];
}

/**
 * Checks a reply looks like a screen snapshot.
 * @param value The parsed reply.
 * @returns True when it has the fields the SCREEN tab reads.
 */
export function isSnapshot(value: unknown): value is ScreenSnapshot {
  const v = value as ScreenSnapshot | null;
  return !!v && typeof v === 'object' && Number.isInteger(v.id) && Array.isArray(v.items) && typeof v.title === 'string';
}

/**
 * Splits the controls into runs that share a group heading, in screen order,
 * keeping only those whose label, group or value matches the search.
 * @param items The snapshot's controls.
 * @param query A search, or ''.
 * @returns The groups; a control with no group joins an untitled one.
 */
export function groupItems(items: ScreenItem[], query = ''): ItemGroup[] {
  const q = query.trim().toLowerCase();
  const groups: ItemGroup[] = [];
  for (const item of items) {
    if (q) {
      const haystack = `${item.label} ${item.group} ${item.value ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.title === item.group) last.items.push(item);
    else groups.push({ title: item.group, items: [item] });
  }
  return groups;
}

/**
 * The short value shown at the end of a control's row.
 * @param item The control.
 * @returns ON/OFF, the chosen option, the number or text, or ''.
 */
export function itemValueText(item: ScreenItem): string {
  if (item.kind === 'checkbox' || item.kind === 'switch' || item.kind === 'radio') return item.checked ? 'ON' : 'OFF';
  if (item.kind === 'select') {
    const option = (item.options ?? []).find((o) => o.value === item.value);
    return option ? option.label : String(item.value ?? '');
  }
  if (item.secret) return '••••';
  if (item.value == null || item.value === '') return '';
  return String(item.value);
}

/**
 * Whether a control is a field the phone types into.
 * @param item The control.
 * @returns True for text, number, password and text-area fields.
 */
export function isTextItem(item: ScreenItem | null | undefined): boolean {
  return !!item && (item.kind === 'text' || item.kind === 'textarea' || item.kind === 'password' || item.kind === 'number');
}

/**
 * What tapping a row does.
 * @param item The control.
 * @returns `press` (buttons, tabs, links, toggles), `pick` (a choice list),
 *   `adjust` (a slider or number), `type` (a text field) or `none` (locked or off).
 */
export function itemAction(item: ScreenItem): 'press' | 'pick' | 'adjust' | 'type' | 'none' {
  if (item.locked || item.disabled) return 'none';
  if (item.kind === 'select') return 'pick';
  if (item.kind === 'range') return 'adjust';
  if (item.kind === 'number') return 'adjust';
  if (isTextItem(item)) return 'type';
  return 'press';
}

/**
 * A number control's next value after a step, kept within its range.
 * @param item The control (`value`, `min`, `max`, `step`).
 * @param direction 1 to step up, -1 to step down.
 * @returns The new value.
 */
export function stepValue(item: ScreenItem, direction: 1 | -1): number {
  const step = item.step && item.step > 0 ? item.step : 1;
  const current = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : (item.min ?? 0);
  const next = current + direction * step;
  const min = item.min ?? -Infinity;
  const max = item.max ?? Infinity;
  // Round away float noise from fractional steps (0.1 + 0.2).
  return Math.min(max, Math.max(min, Math.round(next * 1e6) / 1e6));
}

/**
 * The heading over the screen readout: the setup breadcrumb, then the surface's title.
 * @param snapshot The snapshot.
 * @returns The trail joined with ›, with the title last when it adds something.
 */
export function screenHeading(snapshot: ScreenSnapshot): string {
  const trail = snapshot.trail.filter(Boolean);
  if (snapshot.kind === 'setup') return trail.length ? trail.join(' › ') : 'SETUP';
  if (snapshot.kind === 'dialog' && trail.length) return `${trail.join(' › ')} › ${snapshot.title}`;
  return snapshot.title;
}

/**
 * The surface kind in words.
 * @param snapshot The snapshot.
 * @returns e.g. "DIALOG · TV MODE".
 */
export function surfaceLabel(snapshot: ScreenSnapshot): string {
  const kind = snapshot.kind === 'dialog' ? 'ON SCREEN NOW' : snapshot.kind === 'setup' ? 'SETUP' : 'LIVE TV';
  return `${kind} · ${snapshot.mode === 'tv' ? 'TV MODE' : 'DESKTOP MODE'}`;
}

// The keyboard key for each remote button, for a box that predates
// POST /command { remote } (no 'remote-keys' in /state's features).
const FALLBACK_KEYS: Record<string, string> = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape',
  menu: '?', guide: 'g', info: 'i',
};

/**
 * The keyboard key an older box understands for a remote button.
 * @param button The RemoteKey name.
 * @returns The key, or null when there is none.
 */
export function fallbackKey(button: string): string | null {
  return FALLBACK_KEYS[button] ?? null;
}
