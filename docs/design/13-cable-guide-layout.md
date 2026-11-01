# 13. The cable-guide layout

Status: built 2026-10-31 to 2026-11-01 (eight steps, see "Build record" below).

RerunTV has two on-screen layouts. The **legacy** layout is the one every theme pack before this
was built for. The **cable-guide** layout is modelled on the program guide of a mid-2000s digital
cable box: one sans face, hierarchy by colour and position, focus as a solid fill, and help for
the focused thing in one header instead of under every control. It comes in two skins:

| Skin | Pack | Look |
|---|---|---|
| HD '15 | `theme-cable-guide-hd-15` | black page, square cells, blue focus, category edge ticks |
| Classic '05 | `theme-cable-guide-classic-05` | blue gradient, rounded pills with a rim, yellow focus, filled category cells |

New installs start on HD (`app.js`'s config defaults). Saved configs keep their theme.

## 1. How the layout is chosen

- The **box theme** decides it. A pack registered with `ui: 'cable-guide'` turns it on; every
  other pack is legacy. A channel's identity theme never flips the layout.
- `html[data-ui="cable-guide"|"legacy"]` (`cable-guide/mode.js`, hook `ui-mode-change`). It is a
  different axis from `html[data-mode]` (desktop / TV, doc 01).
- `html[data-guide-layout="hd"|"classic"]` comes from the pack's `guideLayout` and carries the
  structural differences between the skins. Colours come from the `--cg-*` tokens each pack sets.
- Logic is shared. Schedule math, `viewNow()`, commands, the guide model, input contexts and the
  kit's focus and modal stack are the same in both layouts. Only markup and CSS fork.

## 2. Files

| Piece | Where |
|---|---|
| All layout CSS | `renderer/css/cable-guide.css`, every selector under `html[data-ui="cable-guide"]` (a unit test enforces it). Fallback tokens use `:where(...)` so a pack always wins. |
| Shared header (logo, envelope, clock, three lines, picture slot) | `cable-guide/header.js` |
| Picture box (live TV in the top-right of a page) | `cable-guide/picture-box.js`; `--picture-box-*` in the `.crt`'s local px, `html[data-picture-box="on"]`, hook `picture-box-change` |
| Overlay signal ("is a guide, menu or page up?") | `display/overlay-signal.js`; `html[data-ui-overlay]`, hook `ui-overlay-change`. A surface that is removed rather than hidden calls the unregister function `registerOverlaySurface` returns. |
| Guide (listings, Mini Guide, program info) | the legacy `#guide-grid` restyled by scope, plus `cable-guide/listings.js`, `program-info.js` |
| Flip Bar (channel banner) | `cable-guide/flip-bar.js` |
| Quick Menu and Main Menu | `cable-guide/main-menu.js`, `icons.js`; `tv/menu.js` supplies the items |
| Program info page (I on live TV) | `cable-guide/details-page.js` |
| Full pages | `cable-guide/page.js` (`openCgPage`: header, picture box, modal stack, Back) used by `search-page.js`, `by-channel.js`, `messages.js` |
| Channel Setup | `cable-guide/setup-shell.js` plus the "Channel Setup" block of `cable-guide.css` |
| Pure helpers (labels, ranges, day labels, actions) | `cable-guide/model.js`, unit-tested in `tests/cable-guide.test.js` |

## 3. Rules the layout keeps

- **One header, help as data.** Line 1 is where you are, line 2 (highlight colour) is the focused
  item, line 3 is one sentence about it. Setup rows keep their `.setting-row-help` text in the
  DOM (settings search reads it); the cable-guide layout hides it under the row and shows it in
  the header for the focused or pointed-at row.
- **Sizes on a 60-unit grid** for TV-screen surfaces: `font-size: calc(100cqw / 60)`. Edges near
  the picture box use grid units, never `em`, so a skin's type size can't push text under the
  picture.
- **Labels in title case** (`menuLabel`, keeping abbreviations such as CH, DVR, CSS). Setup's
  section, page and channel-tab labels are relabelled at runtime; the legacy text is kept in
  `data-legacy-label` and put back with a legacy theme.
- **Settings as cyclers.** A setup row reads `Label:` then `‹ value ›`. Selects and checkboxes are
  restyled in place (no markup change), so every listener and test still drives the same
  controls.
- **No new config writes.** The layout adds no config keys; it reads `config.theme`.

## 4. What plugins can rely on (both layouts)

- `.crt`, `#player`, `#plugin-channel-container`, `#test-pattern-canvas`, `#fun-toast`,
  `#hint-bar`, `#guide-grid` stay in the DOM, and `#guide-grid:not(.hidden)` is still true while
  the guide is up.
- `guide-channel-cell` and `guide-program-actions` fire from the cable-guide guide too, and rows
  keep `.guide-row-chan[data-channel-number]`. Program actions may set `icon`.
- Old palette names (`--gold`, `--cyan`, `--paper`, `--ink`) resolve on `body` in the skins.
- A plugin that hides itself while a menu is up checks `html[data-ui-overlay]` on the cable-guide
  layout, because a full page can be up without the guide (breaking-news, eas-alerts,
  screensaver and signal-glitches do).
- `PLUGIN_DEVELOPMENT.md` documents the three hooks and the picture-box rect.

## 5. Deliberate differences from the reference boxes

- Search lists results beside the keyboard as you spell, instead of a separate "search now" step.
- Desktop Channel Setup keeps one sidebar column of section bars (nine sections fit) and its
  Simple / Advanced switch instead of paging dense pages behind "More Choices". The two-column
  menu is the TV menu.
- Setup has no live picture: it is not on the TV screen.
- Reminders fire on the real clock while the guide reads `viewNow()` (an appointment in the
  world; the time machine neither fires nor hides them).

## 6. Testing

- `npm test`: `tests/cable-guide.test.js` (model helpers, token coverage in both packs, the
  scope rule, fonts), plus the theme contract and token tests.
- Live CDP drivers (local, run through `tests/ui/run-ui-tests.ps1 -Script`): foundation,
  listings, flipbar, menus, dialogs, pages, setup and compat, each on both skins and with a
  legacy check. `tests/ui/theme-visual-sweep.ps1 -Theme cable-guide-hd-15` (and classic) for
  a real-data sweep.
- Compare every screen side by side with reference screenshots of real boxes before calling it
  done.

## 7. Build record

1. Foundation: mode, packs, fonts, header, picture box, overlay signal.
2. Listings and program info.
3. Flip Bar, Mini Guide.
4. Quick Menu, Main Menu, settings rows, remote gaps (RECORD records; captions and audio track
   routed).
5. Dialogs, PIN, exit, calendar, program info page.
6. Search, Listings by Channel, Messages.
7. Channel Setup.
8. Compatibility pass (plugins, overlay signal fix), docs, new installs default to HD.
