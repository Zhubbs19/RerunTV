# 04 — Components and theme contract

Status: **in progress** — steps 1–2 and §5 built; steps 3–5 underway. Owns contract **C4**.
Consumed by: 01, 03, 06, 10, plugins.

Working-tree update (2026-09-15): contrast checking and theme-contract lint now exist
in `renderer/js/display/`. The converted-pack test currently lists only
`widescreen-grid-13`, rather than the originally planned `dual-tuner-dvr-05`.
The remaining pack migration, conversion guide and structural cleanup are open.
Current test imports need repair after the directory moves; see [the audit](12-remaining-work-audit-2026-09-15.md).

### Built (§6 step 1: semantic and density tokens, 7c63e55)

- `tokens.css` defines every §4.2 semantic token as an alias of the palette token it grew out of
  (`--accent: var(--gold)`, `--surface-1: var(--ink)`, `--guide-rail-bg: var(--guide-channel-bg)`…), plus
  a few the pair table needed: `--surface-panel`, `--control-bg/-text`, `--accent-2` (the old `--cyan`
  secondary accent), `--focus-halo`, `--guide-cell-alt-bg`, `--guide-rail-subtle`. A codemod moved all core
  CSS onto the semantic names; focus outlines read `--focus-ring`, guide cells `--guide-cell-text`.
- Density (§4.3): `--space-1..6`, `--control-h`, `--target-min`, `--font-size-body/-label`, `--safe-x/-y`,
  multiplied under `html[data-mode="tv"]` (24 px body, 64 px targets, spacing ×1.75, 5% safe area). The size
  tokens are `--font-size-*` because `--font-body` was already the body font family. They replace doc 01's
  `--tv-body/--tv-target/--tv-safe-*`. Radii stay theme tokens (a look choice, not density).
- Alias direction: semantic follows palette during migration, so unconverted packs are untouched. Step 3
  flips it (see there).
- Verified: `tests/theme-tokens.test.js` resolves var() chains for the default theme and all 25 packs (no
  cycles, each semantic token equals its source, no pack sets density, core CSS no longer reads aliased
  names). Nothing anywhere redefines a palette token below `html`, so identical resolution means identical
  pixels. Theme sweep (`tests/ui/sweep-doc04.mjs`, 26 themes × 26 screens at 1280×720, pinned view time): 635/676
  gated screenshots within 1%; each of the other 41 was inspected and is sweep state (viewing log growth,
  selected channel, video frame, now-line drift, hover/animation timing), not a token change.

### Built (§6 step 2: the kit, 28cd9f1; §5 plugin surface)

- `renderer/js/ui/` (≈1.4k lines with comments, ≈1.06k without — under the §2 revisit line):
  `kit-core.js` (`h`, `bindPress`, pure `rovingIndex`/`stepValue`), `focus.js` (FocusScope, SpatialFocus,
  `focusDefault`, and the **modal stack** — `renderer/js/tv/input.js`'s `registerTvModal` delegates to it; the module
  imports nothing, so cycles can't catch it mid-evaluation), `button.js` (Button, IconButton, EmptyState,
  Badge, Chip), `field.js` (Field, SettingRow), `controls.js` (Toggle, Slider, Select, Segmented,
  NumberStepper, ColorPick), `tabs.js` (Tabs, `enhanceTabs` for static bars), `menu.js` (Menu, MenuButton,
  pure `placePopup`/`menuMove`), `dialog.js` (Dialog, ModalSurface), `toast.js` (Toast, StatusBar),
  `list-detail.js` (ListDetail, `listDetailBehavior`, `reconcileList`). `renderer/css/kit.css` holds only
  what the kit adds; components keep established classes (`.btn`, `.setting-row`, `.row-menu`,
  `.guide-run-list`) so pages and themes look the same.
- Absorbed, files removed: `ui/spatial-focus.js`, `ui/row-menu.js`, `ui/setting-row.js`, `setup-narrow.js`.
- Adopted: setup dialogs (`renderer/js/setup/dialogs.js` API unchanged), empty states, the status bar's save state and
  task line, sidebar/sub-tab bars, row ⋯ menus, ON AIR's toolbar (Buttons, Segmented zoom), guide popover and
  banner hub actions (owner-driven Menus: the guide/banner route keys, the Menu highlights), on-screen
  keyboard, handoff, learn mode, first-run wizard (ModalSurfaces), the TV flash (Toast). TV guide rows take
  `--target-min`.
- **ListDetail is a behaviour, not a re-render of the six collections.** Keys, Esc/J/K/Enter and narrow
  mode were already one selector-based implementation; they now key on `data-ui-list-detail` /
  `data-ui-list` / `data-ui-detail` in `index.html`, with row selectors passed in. Rewriting ~6k lines of
  collection renderers for no visible change was judged not worth the regression risk; new lists use the
  `ListDetail()` builder.
- Desktop keys: the tab bars, row menus, guide popover and J/K/Enter/Esc keep their exact key tables
  (pinned in `tests/ui-kit.test.js`). Two deliberate changes: ON AIR's zoom is now a radio group (one Tab
  stop, ◀▶ choose) and TV Back on the setup screen cancels the top modal (it used to dispatch Escape on
  `window`, which the dialog never heard). In TV dialogs ◀▶ on a Slider/Segmented/NumberStepper step it
  (`data-ui-arrows="horizontal"`) instead of moving focus.
- Focus: one ring colour can't clear 3:1 on both a navy surface and a gold selection, so focus is a
  `--focus-ring` outline offset over `--focus-halo` (the surface behind); the theme check pairs
  ring/surface-0 and ring/halo, not ring/selected-bg.
- §5: `ctx.ui` (**CTX_VERSION 6**, not 4 as §5 said — v4/v5 were taken by search and input) exposes the kit,
  frozen. Settings sections may declare `fields` (toggle/slider/number/select/text/colour, dotted keys,
  `dependsOn`, `synonyms`) that core renders as kit SettingRows; each field is a setup search entry and a
  rejected `validate` shows inline (`renderer/js/plugin/settings-schema.js` `normalizeSettingsFields`,
  `settingPathPatch`, `coerceFieldValue`; `tests/plugin-settings-fields.test.js`). Plugin settings panels
  and the tuned plugin channel container carry `data-plugin="id"`; `PLUGIN_DEVELOPMENT.md` documents the
  kit, fields and CSS scoping.

## 1. Problem

The renderer builds UI by hand-assembling DOM in each `setup-*.js` file, with styling in one
4,500-line `setup.css` and 26 theme packs overriding broad selectors after it. Consequences
seen in the 2026-09-12 audit:
- Bugs that only exist in *some* themes. The guide's selected row lost a gradient background
  only where a theme's rail was a gradient.
- Specificity arms races. A hover rule carries eight `:not()`s and `!important` so themes
  can't break selected states.
- Near-duplicate controls: three kinds of "remove" button, several select styles, ad-hoc label
  rows.
- No density concept, so TV mode (01) would mean restyling everything again.

## 2. Decision: in-house kit, no framework

Keep the renderer's constraints: plain ES modules over `app://`, no bundler, offline, plugins
import nothing from core except through `ctx`. A small kit of functions that return DOM
elements, not a virtual DOM.

Reasons over Lit/Preact:
- zero build step;
- plugins already receive DOM containers;
- existing panel builders can adopt components incrementally;
- no second rendering model to teach plugin authors.

Revisit if the kit passes ~1.5k lines or if 03's list/detail needs keyed reconciliation
beyond a small `reconcileList` helper.

## 3. Kit (`renderer/js/ui/`)

| Component | Replaces | Notes |
|---|---|---|
| `Button({ label, variant: 'default'\|'primary'\|'danger'\|'quiet', icon, onPress })` | `.btn` variants, `.remove-btn`, `.titles-btn` | `onPress` fires on click, Enter, Space and the TV `ok` action |
| `IconButton({ icon, label })` | ◄ ► ✕ mini buttons | `label` required (aria + tooltip) |
| `Field({ label, help, control })` | label + input pairs | wires `for`/`id`, error text |
| `SettingRow({ label, help, control, dependsOn })` | panel-toggle + panel-status paragraphs | disables when dependency off (03 §5.1) |
| `Toggle`, `Slider({ format })`, `Select`, `Segmented`, `ColorPick`, `NumberStepper` | native controls restyled per page | Slider has readout and TV Left/Right stepping |
| `Tabs({ items, orientation })` | setup/edit/schedule tab bars | roving focus, `aria-selected` |
| `ListDetail({ items, renderRow, renderDetail, reorder, multiSelect })` | channel list, pool, presets, backups, plugins | virtualized list, one scroll container |
| `Menu`/`MenuButton` | MORE… menus | destructive group styled danger |
| `Dialog({ title, body, actions, defaultAction })` | `renderer/js/setup/dialogs.js` confirms | FocusScope, never defaults to destructive |
| `Toast`, `StatusBar` | flash messages, save state | |
| `FocusScope`, `SpatialFocus` | — | TV focus engine (01) |
| `EmptyState({ message, action })` | `.titles-empty` strings | |
| `Badge`, `Chip` (non-interactive) | tag chips that looked like buttons | |

Every component:
- reads density from `html[data-mode]` (01) — no per-call density prop;
- registers into the settings search manifest when given a `searchId` (03 §6);
- has a focus style defined once, derived from tokens.

## 4. Tokens and theme contract

### 4.1 Layers
```
core defaults (tokens.css)  →  theme pack tokens  →  era overlay (10)  →  channel identity  →  density scale (mode)
```
Themes set **tokens only** under `html[data-theme="x"]`: palette, fonts, radii, shadows,
motion, guide surfaces (the existing `--guide-*` set). Structural selectors (`.btn`,
`.setup-tab-btn`, `.guide-row-chan`) are no longer an override surface. A theme may add
decorative rules scoped to documented **slots** (`[data-slot="guide-topbar"]`,
`[data-slot="power-fx"]`) that don't change layout or state colours.

### 4.2 Semantic tokens (new, required)
`--surface-0..3`, `--text`, `--text-muted`, `--accent`, `--accent-text`, `--selected-bg`,
`--selected-text`, `--focus-ring`, `--danger`, `--danger-text`, `--warning`, `--success`,
`--guide-rail-bg`, `--guide-rail-text`, `--guide-cell-bg`, `--guide-cell-text`,
`--guide-selected-bg`, `--guide-selected-text`. Existing tokens (`--ink`, `--gold`,
`--paper-dim`…) become aliases so current packs keep working during migration.

### 4.3 Density tokens
`--space-1..6`, `--control-h`, `--font-body`, `--font-label`, `--target-min`, `--radius-*`
defined for `desktop` and multiplied for `tv` (1080p logical canvas: body 24 px, targets
64 px, spacing ×1.75). Themes never set density.

### 4.4 Theme validation (load-time and CI-style)
`renderer/js/display/theme-check.js` resolves each theme's tokens in a hidden probe and checks pairs:

| Pair | Minimum |
|---|---|
| `--text` on `--surface-*` | 4.5:1 |
| `--text-muted` on `--surface-1` | 4.5:1 |
| `--selected-text` on `--selected-bg` | 4.5:1 |
| `--guide-*-text` on matching `-bg` (gradients sampled at stops) | 4.5:1 |
| `--focus-ring` against `--surface-0` and `--selected-bg` | 3:1 |
| `--danger-text` on `--surface-1` | 4.5:1 |

In the app: a failing theme still loads; the theme gallery shows a "Low contrast" badge and
Plug-ins › Diagnostics lists failures. In the test harness: the theme sweep fails on any
error. Gradient backgrounds are sampled at every stop, closing the gap the audit's heuristic
check had (it treated gradients as unknown).

## 5. Plugin surface

- `ctx.ui` (`CTX_VERSION` 6) exposes the kit to plugin settings panels and channel UIs.
- Declarative plugin settings (`renderer/js/plugin/settings-schema.js`) render through the kit, so they
  get TV density, search entries and validation for free.
- Plugin CSS keeps working but is scoped: core wraps a plugin's panel in
  `[data-plugin="id"]` and documents that global selectors are unsupported.

## 6. Migration

1. Add semantic + density tokens with aliases; no visual change (theme sweep must be
   pixel-similar; allow ≤ 1% diff per screenshot).
2. Build kit primitives; use them first in the new shell (03) and ON AIR's toolbar.
3. Convert one theme pack to tokens-only as the reference (dual-tuner-dvr-05, the user's
   theme); write the conversion guide into `PLUGIN_DEVELOPMENT.md`.
4. Convert remaining first-party packs; theme-check gates each.
5. Remove structural overrides and the `:not()` chains in `setup.css` once no pack needs them.

## 7. Risks

- Theme packs lose some freedom (layout overrides). Mitigation: documented slots; eras (10)
  cover the "whole different look" use case at a higher level.
- Contrast rules may fail beloved retro palettes (VT323 on dim green). Mitigation: themes
  may declare `contrastExempt` per pair with a reason; gallery still badges it.
