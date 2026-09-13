# 03 — Setup shell and navigation

Status: **migration steps 1–5 built** (§8), plus the §3 sections. The rest of the end
state (§4–§7 details) is being built piece by piece below.

### Built (§4 status bar task progress)

`setup-tasks.js`: `beginTask(label)` returns `{ update, end }` and shows a spinner and the
latest task in the status bar ("(+n MORE)" when several run), so progress follows you to other
sections. Library sync and the channel health check report through it. The channel page's own
`#scan-progress` line (add folder, rescan all, batch fixes, relink) is mirrored while it shows.

Verified live (scratch `test/verify-setup-tasks.mjs`, 7 checks).

### Built (§4 sidebar icons and badges)

`setup-sidebar.js` and `setup.css`:
- Each section has an icon. Below 1100 px the sidebar is a 64 px icon rail; the section name
  is in each button's tooltip (with its G-key).
- Badges count what needs a look: Channels with nothing to play, Library sync warnings (missing
  files and folder errors from the last run), and Plug-ins needing attention. The count is a
  `data-badge` attribute drawn by CSS and added to the accessible name, so the button text that
  the breadcrumb, search and tooltips read stays the section name.
- Badges refresh on opening setup, on every history change, after a library sync, and whenever
  the plugin list is fetched.

Electron clamps `font-size: 0` to its minimum font size, so the rail hides names with a
transparent text fill instead.

Verified live (scratch `test/verify-setup-sidebar.mjs`, 8 checks).

### Built (§7 keyboard)

`setup-keyboard.js`:
- G then a letter opens a section: C, P, L, S (picture & sound), G (guide & theme), H, Y (system),
  U (plug-ins), ? (help). The letter is on each sidebar button as `data-go-key` and in its tooltip.
  Keys typed into text fields are never taken.
- J and K are ▼ and ▲ in any list + detail list.
- Enter on the row that is already selected moves focus to the first control of its detail pane;
  Esc anywhere in a detail pane returns focus to the selected row.

Verified live (scratch `test/verify-setup-keyboard.mjs`, 8 checks).

### Built (§3 sections)

The sidebar is Channels, Programming, Library, Picture & sound, Guide & theme, Household,
System, Plug-ins, Help. Whole panels moved; every control id is unchanged.
- **Programming:** cadence & presets, flows, bumper & ad pool, extras, auto-curate.
- **Library:** sync, tags (the tag taxonomy).
- **Picture & sound:** picture, and a new sound page (volume, custom sound profile).
- **Guide & theme:** the old Interface page, with the guide and theme card first.
- **Household:** parental lock, this device (usage mode, interface size), watching on other
  devices, connected devices.
- **System:** power (with the background server), updates, backups, air check (the console
  and the marks list), diagnostics (the old STATUS tab).

The `data-tab` ids predate the names: `display` is Picture & sound and `audio` is System.
Diagnostics refreshes once a second only while it is on screen. Viewing history stays in
Diagnostics until Household profiles exist (09).

Also for §9: the header is a fixed 56 px, and the history, sync results, tag list, changelog
and plugin log sit in the page's own scroll. List + detail panes keep theirs.

Verified live (scratch `test/verify-setup-sections.mjs`):
- all 23 pages at 1280×720 have no horizontal scroll, 100 px of header plus status bar, and no
  nested scroll box;
- search lands on settings in their new sections.

### Built (step 5: collections as list + detail)

Every collection page is a `.list-detail`: compact rows on the left and the selected item's
editor on the right. ▲▼ move the selection, and a filter that hides the selection selects the
first item it shows.
- **Ad pool and presets** (`setup-interstitials.js`): the selected entry's card opens in
  `#interstitials-detail` / `#presets-detail`. Edits there rebuild the entry's list row. The
  expand/collapse-all buttons are gone.
- **Flows** (`setup-interstitials-flowbuilder.js`): `#flow-list` rows show name, step count,
  on/off and channels beside the flow editor and canvas. The old template select is hidden but
  still populated.
- **Backups** (`setup-backups.js`): rows show age, reason, time and size. The detail pane has
  RESTORE / LABEL / PIN / DELETE and shows the restore diff inline instead of behind a PREVIEW
  dialog.
- **Plugins** (`setup-plugins.js`): one-line rows keep the enable checkbox. The detail pane
  holds the description, integrity, permissions, dependencies, RELOAD and the plugin's settings,
  rendered on selection. The +DETAILS and SETTINGS toggles are gone. The selection survives
  RESCAN.

Verified live (scratch `test/verify-collections-list-detail.mjs`,
`verify-flows-backups-list-detail.mjs`, `verify-plugins-list-detail.mjs`).

### Built (steps 3–4: SettingRow and one search)

**SettingRow** (`renderer/js/ui/setting-row.js`, "SettingRow" in `setup.css`):
- Each setting is a sentence-case label wired to its control with `for`, plus one muted help
  line. A longer explanation stays on the row's title. `data-setting` is its search id and
  `data-synonyms` adds search words.
- A `data-depends-on="<checkbox id>"` row indents, dims and disables its controls while that
  switch is off; it is never hidden.
- `SettingRow()` builds the same markup at runtime.

70 static settings are now rows, and every control id is unchanged:
- **Picture & Guide:** Picture and Interface.
- **Programming:** Cadence & Presets, and On-screen extras.
- **System:** Audio & Power, Network & Access, and Library sync.
- **Help:** Updates.

Toggles that used to sit in card headings became the first row of their card, and the old
all-caps paragraphs became one-line help. Plugin settings panels still build their own markup.

**Unified search** (`setup-settings.js`, `setup-command-palette.js`):
- The header search replaces the separate Ctrl+K palette overlay. Ctrl+K and the status bar's
  SEARCH button focus it, and while it's empty it lists actions.
- Typed results are grouped: SETTINGS (single rows, label matches ranked first), CHANNELS
  (opens the channel in list + detail), ACTIONS (the old palette's commands and every section),
  SECTIONS (whole cards on pages not yet on rows), and PROGRAMS (the next 7 days, through
  `program-search.js`).
- Choosing a setting opens its page and focuses the control.

Verified live (scratch `test/verify-setting-rows-search.mjs`, 12 checks):
- no loose old-style rows remain on the converted pages;
- a dependency disables without hiding, and clicking a label toggles its control;
- Ctrl+K lists actions, and "gu" lists Guide width under SETTINGS;
- Enter on "guide slots" focuses the control;
- channel, action and program groups work, as does the SEARCH button.

The 34-check UI suite and the earlier step 5, usage-mode and shell drivers all pass.

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
