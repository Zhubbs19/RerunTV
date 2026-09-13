# 03 — Setup shell and navigation

Status: **migration steps 1 and 2 built** (§8). Steps 3–5 proposed.

### Built (step 2: Channels list + detail)

The CHANNELS page (`setup-channels.js`) is a list beside a detail pane.

The list, `#channel-list-pane`:
- Each row is 52 px: badge, number, name, and what's on now, or "NO FOLDER YET" in gold. Before,
  each channel was a 270–480 px card.
- It stays sticky beside a long editor.
- ▲▼/Home/End move the selection and Enter jumps into the editor.
- Rows drag to reorder (the same number swap as ▲▼) and accept dropped videos.
- SELECT CHANNELS puts its checkboxes here.
- Plugin channels are one "PLUGIN CHANNELS (n)" entry.

The detail pane, `#channel-list`:
- It shows only the selected channel's card, with the editor already open. The EDIT toggle is
  gone, and the last-used editor tab is remembered per channel.
- `S.setupSelectedChannel` follows renumbering, swaps, add, duplicate and remove (a neighbour
  is selected), library-search jumps and filtering.
- The card keeps `.channel-row[data-channel-number]` and every editor id.

Below 900 px the list stacks above the editor.

Verified live on the installed 14-channel lineup (scratch `test/verify-channels-list-detail.mjs`,
13 checks):
- the list is 779 px for 14 channels, with one card;
- click and keyboard selection, and rename reflected in the list;
- a swap keeps the selection;
- add selects the new channel and remove selects a neighbour;
- bulk checkboxes, filter, and plugin channels;
- at 1280×720 the list stays on screen with no horizontal scroll.

The UI suite now selects channel 1 in the list before using its card (34/34). The tracked theme
sweep no longer needs the workspace switch. Depends on: C1 (01), C3 (05),
C4 (04). Consumed by: 06 (web panel is this shell).

### Built (step 1: the shell)

Layout (`renderer/index.html`, `setup.css` "Setup shell"):
- A 220 px sidebar with the brand, WATCH TV and the seven sections as one vertical tab list.
  - Sections: Channels, Programming, Picture & Guide, System, Status, Plug-ins, Help.
  - ▲▼ roving focus comes from `setup-keyboard.js`, which honours `aria-orientation`.
  - The sidebar narrows to 172 px below 1100 px and becomes a horizontal strip below 760 px.
- A 56 px header with the page title, breadcrumb (hidden when it would repeat the title), a
  one-line description and search.
- `#setup-content` is the only scroll pane for the page.
- A 44 px pinned status bar with save state, undo/redo, commands and START WATCHING.
  Ctrl+Enter watches from anywhere in setup.

Also:
- The WORKSPACE switch is removed, and every section is always listed.
- EXPORT/IMPORT CONFIG and RESTORE FROM DISK moved from the footer of every page to a card at
  the top of System › Backups.
- Tab buttons, panels, sub-tabs and every id are unchanged, so listeners, plugins, search
  navigation and the UI suite's selectors work as before. The suite's `scrollAndShot` now
  scrolls `#setup-content`.

Verified live (scratch `test/verify-setup-shell.mjs`, 14 checks):
- At 1280×720 the header plus status bar is 100 px, and no section scrolls horizontally.
- The status bar stays visible at the bottom of the longest page.
- Sidebar keyboard navigation, WATCH TV and Ctrl+Enter work.
- A search for "guide slots" lands on the control.
- Five theme packs keep the sidebar vertical and the header at 56 px.
- The 34-check UI suite passes.

## 1. Problem (from the 2026-09-12 audit)

- **Two navigation layers before any content.** The WORKSPACE switch (Watch & Lineup / Master
  Control) mostly just filters the tab bar. LINEUP and MANUAL appear in both.
- **Three tab levels** inside a channel: CONTENT/LOOK/PLAYBACK → FOLDERS/TITLES/SCHEDULE →
  ON AIR/TIMELINE/BLOCKS/CALENDAR.
- **The pinned header eats the screen**: about 220 px at 1080p and about 340 px at 720p
  (47% of the viewport).
- **Lineup cards are 270–480 px tall.** 14 channels become about 4,000 px of scrolling, and the
  editor opens *inside* the list, below a card's options.
- **Global actions scroll away.** START WATCHING, save state and undo sit at the end of long
  pages. EXPORT/IMPORT CONFIG repeat on every page next to everyday buttons.
- **Two overlapping searches.** "Jump to any setting" and Ctrl+K command palette overlap, and
  neither finds individual settings well.
- **Settings live in odd places.** The parental lock is under Network & Access, update policy
  under Manual, and guide theme three levels deep.
- **Lists inside a scrolling page**: pool, backups, titles, sync and history each scroll on
  their own.
- **Inconsistent setting rows**: all-caps paragraphs as help text, checkbox labels styled
  like links.

## 2. Goals

- One navigation layer: a **sidebar** of sections, each section one page (optional in-page tabs,
  never nested twice).
- **List + detail** for collections (channels, pool, presets, flows, backups, plugins).
- A pinned **status bar** with save state, undo/redo, search and Start Watching.
- One **search** that finds settings, channels, programs and actions.
- A consistent **SettingRow** pattern and plain-language copy.
- Works at 1280×720 without horizontal scroll; header ≤ 64 px.

Non-goal: changing any schedule/playback behaviour. This doc is structure and presentation.

## 3. Information architecture

```
RerunTV
├── Watch                (returns to TV; also the status bar button)
├── Channels             list + detail
│   └── <channel>        Overview · Content · Schedule · Look · Breaks · Advanced
├── Programming
│   ├── Ad presets       list + detail
│   ├── Flows            list + detail (flow canvas in detail)
│   ├── Bumper & ad pool list + detail
│   ├── Extras           up next, details card, time machine, ticker…
│   └── Auto-curate
├── Library              (07) folders, sync, tags & taxonomy, relink
├── Picture & sound      picture, CRT, display mode, volumes, sound profile
├── Guide & theme        theme gallery, guide options, typography, genres, reminders
├── Household            profiles, parental lock (09), remote & devices, pairing
├── System               updates, power & standby, network services, backups, diagnostics, air check
├── Plug-ins             list + detail
└── Help                 manual, shortcuts, what's new
```

Mapping from today:

| Today | New home |
|---|---|
| Workspace switch | removed; sections are always all listed (advanced sections can collapse under "More") |
| LINEUP › per-channel OPTIONS row | Channel › Overview (common) and Advanced (rest) |
| Channel EDIT › CONTENT › FOLDERS/TITLES | Channel › Content (folders on top, titles table below) |
| Channel EDIT › SCHEDULE (ON AIR/TIMELINE/BLOCKS/CALENDAR) | Channel › Schedule, ON AIR default with Blocks/Calendar as a view switch (02) |
| Channel EDIT › LOOK (LOGO/OVERLAYS/TICKER/IDENTITY) | Channel › Look (sections on one page) |
| Channel EDIT › PLAYBACK (ADS/CREDITS) | Channel › Breaks |
| PICTURE & GUIDE › PICTURE | Picture & sound |
| PICTURE & GUIDE › INTERFACE | Guide & theme (theme at top) |
| SYSTEM & STORAGE › NETWORK & ACCESS | Household (lock, devices) + System › Network services |
| SYSTEM & STORAGE › BACKUPS / LIBRARY SYNC | System › Backups / Library › Sync |
| STATUS | System › Diagnostics (history moves to Household › profile, 09) |
| PROGRAMMING › TAG TAXONOMY | Library › Tags |
| PROGRAMMING › AIR CHECK | System › Air check (and every ON AIR explanation links to it) |
| MANUAL › UPDATES | System › Updates |
| Footer EXPORT/IMPORT CONFIG, RESTORE FROM DISK | System › Backups |

## 4. Layout

```
┌──────────────┬───────────────────────────────────────────────────────────┐
│  RERUNTV     │  Channels                                  ⌕ Search  (Ctrl+K)│  ← 56px header
│              ├─────────────────────────┬─────────────────────────────────┤
│  ▶ Watch     │  ⌕ filter   + Add       │  CH 7  Nickelodeon       ▶ Preview │
│  Channels  ● │  ─────────────────────  │  Overview  Content  Schedule  Look │
│  Programming │  5  Boomerang   Baseb…  │  ───────────────────────────────── │
│  Library     │  6  The Office  Whistl… │  (detail page scrolls here)        │
│  Picture…    │ ▸7  Nickelodeon SpongeB │                                    │
│  Guide…      │  8  Noggin      Blue's… │                                    │
│  Household   │  …                      │                                    │
│  System      │                         │                                    │
│  Plug-ins    │                         │                                    │
│  Help        │                         │                                    │
├──────────────┴─────────────────────────┴─────────────────────────────────┤
│ ✓ Saved · ↶ Undo  ↷ Redo                              START WATCHING ▶  │  ← 48px status bar
└──────────────────────────────────────────────────────────────────────────┘
```

- **Sidebar** 220 px, collapses to icons below 1100 px; section badges show attention counts
  (plugins needing approval, channels with missing files, sync warnings).
- **List pane** 320–380 px, virtualized, one row per item: logo, number, name, now/next, status
  dot. Drag to reorder (replaces ▲▼ buttons, which remain in a row menu for keyboard users).
  Multi-select with Shift/Ctrl replaces SELECT CHANNELS mode; the bulk bar appears in the
  detail pane when > 1 selected.
- **Detail pane** owns the only scroll container on the page. No nested scroll boxes; long
  lists inside a page use pagination or in-flow virtualization.
- **Status bar** always visible: save state, undo/redo (05), background task progress (scans,
  sync), Start Watching.
- Below 900 px the list and detail become a stack (list → detail with Back).

## 5. Page patterns

### 5.1 SettingRow
Label (sentence case, ≤ 5 words) · control · one line of help (normal case, muted) · optional
"Learn more" linking to the manual anchor. Dependent settings indent under their parent and
disable (not hide) when the parent is off — the CRT toggle fix generalized. All-caps is reserved
for section eyebrows and buttons.

### 5.2 Section cards
A page is a column of section cards with a heading and ≤ 8 rows; wide screens use two columns
only for independent sections (never split a dependent group).

### 5.3 Collections
ListDetail component (04) for every collection. Row actions in a ⋯ menu; destructive actions in
the menu's bottom group and in the detail footer, styled danger, always undoable or confirmed.

### 5.4 Empty states
Each collection has an empty state with one primary action and one sentence ("No channels yet
— add a folder to make your first channel"). Lineup's empty state accepts dropped folders.

### 5.5 Copy
Plain sentence-case help. Developer notes (resolver keys, IDs, file paths) go behind a
"Details" disclosure. Plugin descriptions show a one-line user-facing summary; the long text
moves into the plugin's detail page.

## 6. Search (Ctrl+K)

One palette replacing both the setting search and the command palette.

- **Index**: every SettingRow registers `{ id, label, synonyms, section, anchor }` at render
  time (a static manifest generated from the page definitions so unrendered pages are
  searchable); channels by number/name; programs over the next 7 days (`program-search.js`);
  actions from the action registry (01) and commands (05) that make sense standalone.
- **Result kinds** grouped: Go to setting · Channels · Programs · Actions. Enter on a setting
  navigates and focuses the control with a brief highlight.
- Plugins contribute settings via their declarative schema automatically; custom panels may
  register search entries (`ctx.search.registerEntries`, new ctx API).

## 7. Keyboard (desktop)

- `Ctrl+K` search · `G then C/P/L/…` go to section · `J/K` or arrows in lists · `Enter` open ·
  `Esc` back to list · `Ctrl+Z / Ctrl+Shift+Z` undo/redo · `Ctrl+Enter` Start Watching.
- Roving tabindex from `setup-keyboard.js` is reused inside the list and tab bars.

## 8. Migration

Incremental, one section at a time, behind the new shell (P2):
1. Shell (sidebar, header, status bar) hosting the existing tab panels unchanged inside the
   detail area. Removes the workspace switch and footer duplication immediately.
2. Channels list + detail (largest win), reusing existing panel builders (`buildTitlesPanel`,
   `buildUnifiedSchedulePanel`, `buildLogoBugPanel`…) inside the new tabs.
3. Move settings pages onto SettingRow one by one; each move deletes the old markup in
   `index.html` for that page.
4. Unified search once ≥ 80% of pages use SettingRow (so the manifest is meaningful).
5. Collections (pool, presets, flows, backups, plugins) to ListDetail.

Each step keeps DOM ids that the UI test suite and plugins rely on, or updates the tests and
`PLUGIN_DEVELOPMENT.md` in the same change.

## 9. Acceptance criteria

- Rename channel 7 and change its rating: ≤ 3 actions from app open (today ≈ 6 + scrolling).
- Find "guide slots" via search in ≤ 2 keystrokes after Ctrl+K.
- At 1280×720, header + status bar ≤ 104 px; no horizontal scroll on any page.
- Zero nested scroll containers on settings pages (checked by the audit driver's heuristics).
- Theme sweep: no contrast failures below 4.5:1 for body text (04's checker).

## 10. Interactions with other docs

- **06**: the web panel serves this exact shell; the status bar also shows who else is
  editing.
- **01**: TV-mode setup pages reuse these page definitions rendered with TV density and a
  single-column layout; the sidebar becomes the TV menu's Setup level.
- **09**: Household section is where profiles land.
- **02**: Channel › Schedule hosts ON AIR + editable timeline.
