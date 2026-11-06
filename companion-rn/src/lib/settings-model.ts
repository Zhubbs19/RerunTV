// The box's settings as a tree the app can render: curated groups, nested
// objects, and one control kind per leaf. Pure, so it is tested; mirrors the
// web remote's editor (plugins/companion-app/remote/remote.js) so both
// surfaces read and write the same config through POST /api/settings.
import { ENUMS, EXCLUDED, GROUPS, HELP, LABELS, RANGES, type EnumChoice, type RangeBounds } from './settings-meta.ts';

export type Json = unknown;
export interface Theme { id: string; label: string }

export type Kind = 'boolean' | 'enum' | 'range' | 'number' | 'text' | 'secret' | 'stringList' | 'json';

interface Base { key: string; path: string[]; dotted: string; label: string; help: string; search: string }
export interface ObjectNode extends Base { kind: 'object'; children: SettingNode[] }
export interface LeafNode extends Base {
  kind: Kind; value: Json; choices?: EnumChoice[]; bounds?: RangeBounds;
  /** From the box's settings registry: saved with $set, may be unset (shows fallback). */
  registry?: true; fallback?: Json;
  /** A parent switch; off leaves this field dimmed. */
  dependsOn?: { path: string[]; fallback: Json };
}
export type SettingNode = ObjectNode | LeafNode;
export interface SettingGroup { title: string; nodes: SettingNode[]; search: string }

export function labelFor(key: string): string {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toUpperCase();
}

export function isSensitiveKey(key: string): boolean {
  return /(?:api.?key|token|secret|password|credential|auth)/i.test(key);
}

function isPlainObject(value: Json): value is Record<string, Json> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function base(key: string, path: string[]): Base {
  const dotted = path.join('.');
  const label = LABELS[dotted] || labelFor(key);
  const help = HELP[dotted] || '';
  return { key, path, dotted, label, help, search: `${labelFor(key)} ${LABELS[dotted] || ''} ${help} ${dotted}`.toLowerCase() };
}

export function buildNode(key: string, value: Json, path: string[], themes: Theme[]): SettingNode {
  const b = base(key, path);
  if (isPlainObject(value)) {
    const children = Object.keys(value).sort()
      // The TV interface size is offered up front under TV APPEARANCE.
      .filter((child) => !(b.dotted === 'display' && child === 'uiScale'))
      .map((child) => buildNode(child, value[child], [...path, child], themes));
    return { ...b, kind: 'object', children, search: `${labelFor(key)} ${b.dotted}`.toLowerCase() };
  }
  if (Array.isArray(value)) {
    const strings = value.length > 0 && value.every((item) => typeof item === 'string');
    return { ...b, kind: strings ? 'stringList' : 'json', value };
  }
  if (typeof value === 'boolean') return { ...b, kind: 'boolean', value };
  let choices: EnumChoice[] | undefined = b.dotted === 'theme' ? themes.map((t) => [t.id, t.label] as EnumChoice) : ENUMS[b.dotted];
  if (choices) {
    // Keep an unknown or custom current value selectable until a replacement is picked.
    if (!choices.some((c) => String(c[0]) === String(value))) choices = [[String(value), `${labelFor(String(value))} (CURRENT)`], ...choices];
    return { ...b, kind: 'enum', value, choices };
  }
  const bounds = RANGES[b.dotted];
  if (bounds && typeof value === 'number') return { ...b, kind: 'range', value, bounds };
  if (isSensitiveKey(key)) return { ...b, kind: 'secret', value };
  return { ...b, kind: typeof value === 'number' ? 'number' : 'text', value };
}

// TV APPEARANCE first, then the curated groups, then whatever else the config
// carries (plugin and channel feature sections), sorted.
export function buildGroups(config: Record<string, Json>, themes: Theme[]): SettingGroup[] {
  const groups: SettingGroup[] = [];
  const appearance: SettingNode[] = [];
  if (config.theme != null) appearance.push(buildNode('theme', config.theme, ['theme'], themes));
  const display = config.display;
  if (isPlainObject(display) && display.uiScale != null) appearance.push(buildNode('uiScale', display.uiScale, ['display', 'uiScale'], themes));
  if (appearance.length) groups.push({ title: 'TV APPEARANCE', nodes: appearance, search: 'tv appearance' });

  const known = new Set<string>();
  GROUPS.forEach(([, keys]) => keys.forEach((k) => known.add(k)));
  const leftovers = Object.keys(config).filter((k) => !known.has(k) && !EXCLUDED.has(k)).sort();
  [...GROUPS, ['PLUGIN & CHANNEL FEATURES', leftovers] as [string, string[]]].forEach(([title, keys]) => {
    const present = keys.filter((k) => Object.prototype.hasOwnProperty.call(config, k) && !EXCLUDED.has(k));
    if (!present.length) return;
    groups.push({ title, nodes: present.map((k) => buildNode(k, config[k], [k], themes)), search: title.toLowerCase() });
  });
  return groups;
}

// Keep a node when it, or something under it, matches. Parents match on their
// own name too, in which case everything under them stays.
function filterNode(node: SettingNode, q: string): SettingNode | null {
  if (node.kind !== 'object') return node.search.includes(q) ? node : null;
  if (node.search.includes(q)) return node;
  const children = node.children.map((c) => filterNode(c, q)).filter((c): c is SettingNode => c !== null);
  return children.length ? { ...node, children } : null;
}

export function filterGroups(groups: SettingGroup[], query: string): SettingGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => (g.search.includes(q) ? g : { ...g, nodes: g.nodes.map((n) => filterNode(n, q)).filter((n): n is SettingNode => n !== null) }))
    .filter((g) => g.nodes.length > 0);
}

export function countLeaves(nodes: SettingNode[]): number {
  return nodes.reduce((n, node) => n + (node.kind === 'object' ? countLeaves(node.children) : 1), 0);
}

// Immutable set at a path, creating objects as needed.
export function setIn(target: Record<string, Json>, path: string[], value: Json): Record<string, Json> {
  const [head, ...rest] = path;
  if (rest.length === 0) return { ...target, [head]: value };
  const child = isPlainObject(target[head]) ? (target[head] as Record<string, Json>) : {};
  return { ...target, [head]: setIn(child, rest, value) };
}

export function getIn(target: Record<string, Json>, path: string[]): Json {
  let node: Json = target;
  for (const segment of path) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

export function hasPatch(patch: Record<string, Json>): boolean {
  return Object.keys(patch).length > 0;
}

// What a text box produced, converted back to the type the setting had.
export function parseTyped(original: Json, text: string): Json {
  if (typeof original === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : original;
  }
  return text;
}

// Range controls show a scaled value (0.6 volume = 60%) and store the multiplied one.
export function toDisplay(stored: number, bounds: RangeBounds): number {
  return Number((stored / bounds[4]).toFixed(2));
}
export function toStored(shown: number, bounds: RangeBounds): number {
  return Number((shown * bounds[4]).toFixed(6));
}

// A JSON list typed by hand: returns the array, or null when it is not a valid list.
export function parseJsonList(text: string): Json[] | null {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface SettingsResult {
  at: number;
  applied?: string[];
  rejected?: { section: string; reason: string }[];
}

// One sentence for the box's verdict on a save.
export function describeResult(result: SettingsResult): { ok: boolean; text: string } {
  const applied = result.applied ?? [];
  const rejected = result.rejected ?? [];
  if (!rejected.length) {
    return { ok: true, text: applied.length ? `Applied: ${applied.join(', ')}.` : 'Nothing changed. Those values already matched the box.' };
  }
  const reasons = rejected.map((r) => `${r.section} (${r.reason})`).join('; ');
  return { ok: false, text: `${applied.length ? `Applied: ${applied.join(', ')}. ` : ''}The box refused ${rejected.length}: ${reasons}.` };
}

// ---------- The box's settings registry (GET /api/settings/registry) ----------
// A box that serves its registry (RerunTV with docs/design/14) gets the same
// sections, pages, labels, help, ranges and defaults as its own setup screen,
// including settings that were never saved (they show their default). Those
// are saved as { $set: [{ path, value }] }, which the box checks and clamps.

export interface RegistrySetting {
  id: string;
  path: string[];
  label: string;
  help: string;
  type: 'switch' | 'choice' | 'number' | 'text';
  home: string;
  level: 'basic' | 'advanced';
  choices?: [string | number, string][];
  choicesFrom?: 'themes' | 'channels';
  range?: { min?: number; max?: number; step?: number; unit?: string };
  scale?: number;
  default?: Json;
  dependsOn?: string;
  synonyms?: string;
}
export interface Catalogue {
  version: number;
  sections: { id: string; label: string; pages: { id: string; label: string }[] }[];
  settings: RegistrySetting[];
}
export type Level = 'basic' | 'advanced';

// Sections a phone never edits (the box refuses them too).
export const HOST_ONLY_SECTIONS = new Set(['network', 'updates', 'pinLock', 'pcPower']);

export function isCatalogue(value: Json): value is Catalogue {
  return isPlainObject(value) && value.version === 1 && Array.isArray(value.sections) && Array.isArray(value.settings);
}

// Sentence case from the registry, all caps in this app.
const caps = (s: string) => s.toUpperCase();

export function registryLeaf(entry: RegistrySetting, themes: Theme[], channels: { number: number; name: string }[] = []): LeafNode {
  const path = entry.path;
  const dotted = path.join('.');
  const base: Base = { key: path[path.length - 1], path, dotted, label: caps(entry.label), help: entry.help || '', search: `${entry.label} ${entry.help || ''} ${entry.synonyms || ''} ${dotted}`.toLowerCase() };
  const extra = { registry: true as const, fallback: entry.default };
  if (entry.type === 'switch') return { ...base, ...extra, kind: 'boolean', value: entry.default };
  if (entry.type === 'choice') {
    let choices: EnumChoice[] = (entry.choices || []).map(([v, l]) => [String(v), caps(l)]);
    if (entry.choicesFrom === 'themes') choices = themes.map((th) => [th.id, th.label]);
    if (entry.choicesFrom === 'channels') choices = [['last', 'LAST CHANNEL WATCHED'], ['first', 'FIRST CHANNEL'], ...channels.map((c) => [String(c.number), `CH ${c.number} · ${caps(c.name || '')}`] as EnumChoice)];
    return { ...base, ...extra, kind: 'enum', value: entry.default, choices };
  }
  if (entry.type === 'number') {
    const r = entry.range || {};
    // A blank-means-automatic number (no default) stays a text box, so it can be cleared.
    if (typeof r.min === 'number' && typeof r.max === 'number' && typeof entry.default === 'number') {
      const bounds: RangeBounds = [r.min, r.max, r.step || 1, r.unit ? ` ${r.unit}` : '', entry.scale || 1];
      return { ...base, ...extra, kind: 'range', value: entry.default, bounds };
    }
    return { ...base, ...extra, kind: 'number', value: entry.default };
  }
  return { ...base, ...extra, kind: 'text', value: entry.default };
}

// Sections in the box's order, each holding its pages, each page its settings.
// `level` 'basic' keeps the everyday ones (the box's Simple view). Whatever
// the registry doesn't cover (plugin sections) follows from the generic tree.
export function buildRegistryGroups(
  catalogue: Catalogue,
  config: Record<string, Json>,
  opts: { themes?: Theme[]; channels?: { number: number; name: string }[]; level?: Level } = {},
): SettingGroup[] {
  const themes = opts.themes ?? [];
  const byId = new Map(catalogue.settings.map((e) => [e.id, e]));
  const wanted = catalogue.settings.filter((e) => opts.level !== 'basic' || e.level === 'basic');
  const groups: SettingGroup[] = [];
  for (const section of catalogue.sections) {
    const inSection = wanted.filter((e) => e.home.split('/')[0] === section.id);
    if (!inSection.length) continue;
    const leaf = (e: RegistrySetting): LeafNode => {
      const node = registryLeaf(e, themes, opts.channels);
      const parent = e.dependsOn ? byId.get(e.dependsOn) : undefined;
      return parent ? { ...node, dependsOn: { path: parent.path, fallback: parent.default } } : node;
    };
    const nodes: SettingNode[] = inSection.filter((e) => !e.home.split('/')[1]).map(leaf);
    for (const page of section.pages) {
      const children = inSection.filter((e) => e.home.split('/')[1] === page.id).map(leaf);
      if (!children.length) continue;
      const dotted = `${section.id}/${page.id}`;
      nodes.push({ key: page.id, path: [dotted], dotted, label: caps(page.label), help: '', kind: 'object', children, search: `${page.label} ${section.label}`.toLowerCase() });
    }
    groups.push({ title: caps(section.label), nodes, search: section.label.toLowerCase() });
  }
  if (opts.level !== 'basic') {
    const covered = new Set(catalogue.settings.map((e) => e.path[0]));
    const rest = Object.fromEntries(Object.entries(config).filter(([k]) => !covered.has(k) && !HOST_ONLY_SECTIONS.has(k)));
    const extra = buildGroups(rest, themes).filter((g) => g.title !== 'TV APPEARANCE').map((g) => ({ ...g, title: g.title === 'PLUGIN & CHANNEL FEATURES' ? g.title : `MORE ${g.title}` }));
    groups.push(...extra);
  }
  return groups;
}

// The value a field shows: what is saved, else the setting's default.
export function shownValue(node: LeafNode, draft: Record<string, Json>): Json {
  const v = getIn(draft, node.path);
  return v === undefined || v === null ? node.fallback : v;
}

// Whether a field's parent switch is off (it is shown dimmed and can't change).
export function isDisabled(node: LeafNode, draft: Record<string, Json>): boolean {
  if (!node.dependsOn) return false;
  const v = getIn(draft, node.dependsOn.path);
  return !(v === undefined || v === null ? node.dependsOn.fallback : v);
}

// The body POST /api/settings gets: registry fields as $set, the rest as a patch.
// registryEdits is keyed by dotted path, so a field changed twice is sent once.
export function buildSaveBody(pending: Record<string, Json>, registryEdits: Record<string, { path: string[]; value: Json }>): Record<string, Json> {
  const body: Record<string, Json> = { ...pending };
  const edits = Object.values(registryEdits);
  if (edits.length) body.$set = edits.map(({ path, value }) => ({ path, value: value === undefined ? null : value }));
  return body;
}
