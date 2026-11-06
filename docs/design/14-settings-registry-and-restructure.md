# 14. Settings: one registry, one home per idea

Status: proposal, 2026-11-06. Nothing here is built yet.

Doc 03 gave setup one navigation layer, list + detail, one search and SettingRow. Since then
the app has gained about a hundred settings, and new ones get added wherever the feature was
built. The result is the same problem doc 03 set out to fix, one level down: the same idea lives
in several places, under different names, with different ranges, and the TV menu and search
reach only some of it. This doc proposes:

1. a **settings registry**: one table that defines every setting once, and that drives the setup
   rows, the per-channel overrides, the TV menu, search and defaults (§3);
2. **one home per idea**: every concept gets one page, holding the box-wide default and the rules
   for which channels override it (§4);
3. a **regrouped section list** that still fits nine sidebar bars (§5);
4. the **new options** worth adding, in three tiers (§6);
5. **naming and range fixes** (§7), and a build order that keeps every id, selector and key
   working (§8, §9).

Inputs: a full inventory of the setup screen, the channel editor and the TV menu, plus a sweep for
hard-coded behaviour a user would plausibly want to change (both 2026-11-06).

## 1. What is wrong today

### 1.1 One idea, many places

| Idea | Where it lives now | What goes wrong |
|---|---|---|
| End credits | FIT TO TIME SLOTS (5 credits rows), BREAK CADENCE (`useFoundCredits`, FIND FADES), channel BREAKS › END CREDITS, the channel's FIT overrides, per-file TITLES (`creditsLeadS`, squeeze image), the TV menu's PICTURE & SOUND | Labels differ ("Credits length" vs "DEFAULT LEAD TIME"). Speed is 1–8 in 0.5 steps box-wide, but only whole numbers 2–8 per channel. "Applies" defaults to `fit` box-wide and `always` per channel. |
| Logo bug | GUIDE & THEME › ON-SCREEN, CRT "Logo burn-in", keys reachable only in the live editor (`logoBugAutoAdjust` duplicates `logoBugVaryWithContent`), channel LOOK › LOGO, the channel icon (set only by clicking the header badge), the bulk bar, the TV menu | The box key is `display.logoBugHideOnBreaks` and the channel key is `ch.logoBugHidesOnBreak`. |
| Ad breaks | PROGRAMMING (5 sub-tabs), channel BREAKS › ADS (on/off and tags only), block ADS overrides, ON AIR per airing, ad volume under SOUND, three toggles in the TV menu's PICTURE & SOUND | The help says "Flows and channels can override" the interval, but there is no channel-level interval control. `ch.commercials` is deleted on migration yet still read in three places. |
| Ticker | Plug-ins (content), the live editor (placement), APP DISPLAY MODE ("Keep the ticker sharp"), channel LOOK › TICKER | |
| Volume | SOUND › VOLUME; SYSTEM › TUNING & CONTROLS (step, max, per-channel memory, fades); channel OVERVIEW; the bulk bar | |
| Static and tint | CHANNEL STATIC, IDENTITY (tuning static, static tint), block THEME (static tint) | |
| Aspect | "Aspect ratio" (`aspectMode`) vs "Screen shape" (`displayMode.aspect`); per channel "ASPECT RATIO" vs "DISPLAY ASPECT" | Two different things with near-identical names. |

### 1.2 Settings in surprising places

- Daypart chime (a sound) is under PICTURE MODE & ASPECT, and Sound output is on the PICTURE sub-tab.
- TUNING & CONTROLS is on the POWER sub-tab.
- HOUSEHOLD holds device and network panels.
- "Interface size" is under THIS DEVICE but is saved box-wide (`display.uiScale`).
- Reminder lead time is in the GUIDE panel; the rest of reminders has its own panel.
- Custom CSS is under PLUG-INS.
- Viewing history is a checkbox in a DIAGNOSTICS panel heading.
- Channel content tags are on BREAKS › ADS.
- Broadcast hours can be edited in both ON AIR and BLOCKS.
- The TV menu files the break toggles under PICTURE & SOUND.

### 1.3 Reach

- **Search** indexes `.setting-row` and `.panel` only. Channel-editor fields are bare controls with
  tooltips, so none of them can be found (doc 03 already noted this).
- **TV menu**: about 45 settings are reachable. Everything else needs a keyboard, including some
  you would plausibly change from the couch: ad interval, station IDs, up next, the time-shift
  badge, static, the leveler, reminders and sound output.
- **TV menu duplicates**: REMOTE appears both at the top level and under SETUP; SLEEP TIMER under
  SYSTEM and under SETUP › POWER; CRT/PICTURE/ASPECT twice.
- **Help text** is missing on about 25 static rows (CRT sliders, trivia, station ID, hint-bar
  timings and others) and on nearly every channel-editor control (they only have tooltips).

### 1.4 Defaults and ranges have no single source

`core/setting-defaults.js` covers 21 paths. Every other default is inline in
`app.js applyConfigDefaults` (about 230 lines). The setup row, the channel override and the TV
`valueItem` each hard-code their own min, max and step, which is how the credits and standby
ranges drifted apart (TV standby is 15–240 min in 15-minute steps; desktop allows 1 minute).

## 2. Goals

- **One definition per setting.** Label, help, type, range, default, scope and synonyms are
  written once. Every surface reads them.
- **One home per idea.** A user who wants to change "end credits" goes to one page. A channel's
  override for it sits on that channel's page that matches the home.
- **Overrides look the same everywhere.** Fit to time slots already has the right pattern
  (Follow box / On / Off, then per-field overrides). Every per-channel setting uses it.
- **Everything is searchable**, channel fields included, and the TV menu reaches every setting
  marked for it.
- **Nothing breaks.** Control ids, `data-tab` ids, stored sub-tab ids, config paths and the UI
  harness selectors stay (doc 03 §8). Desktop keys stay byte-for-byte (doc 01 §10). Both layouts
  share one markup (doc 13 §1).

## 3. The settings registry

A new pure module, `core/settings-registry.js`, holds one entry per setting:

```js
{
  id: 'breaks.pauseForBreaks',          // stable search / data-setting id
  path: ['commercials', 'pauseForBreaks'],
  label: 'Shows pause for ad breaks',
  help: 'A show stops for its commercials and picks up where it left off, in the guide and the time machine as well as live.',
  type: 'switch',                        // switch | number | choice | text | color | file | custom
  default: true,
  range: null,                           // { min, max, step, unit } for numbers
  choices: null,                         // [{ value, label }] for choices
  home: 'breaks/cadence',                // section/page where the box-wide row lives
  override: { channel: 'pauseForBreaks', block: 'pauseForBreaks' }, // who may override, under which key
  tv: 'basic',                           // basic | advanced | false
  level: 'basic',                        // basic | advanced: replaces the undocumented data-simple-settings
  dependsOn: null,
  synonyms: 'pause program commercial resume where it left off',
  remote: true,                          // false = in REMOTE_DENIED_SETTINGS (config/host.js)
}
```

What it drives:

| Surface | Today | With the registry |
|---|---|---|
| Setup rows | Hand-written in `index.html` | `index.html` keeps its static rows and ids, so nothing moves on day one. A test checks that each row's label, help and range match the registry entry. New settings are rendered from the registry into a placeholder (the way `#program-fit-rows` already works). |
| Per-channel overrides | Hand-built controls with tooltips | One generic `OverrideRow`: the box value greyed, a Follow box / custom switch, then the control. The channel's page for a home lists every entry with `override.channel`. |
| TV menu | `tv/setup.js` hand-lists about 45 `valueItem`s | Generated from entries with `tv` set, in the same sections as desktop. Stepping uses the registry range, so the two can't drift. |
| Search | Static rows only | Every entry, channel overrides included ("Pause for ads · CH 67"), plus the existing ACTIONS and PROGRAMS groups. |
| Defaults | `applyConfigDefaults` and `setting-defaults.js` | Read from the registry. `applyConfigDefaults` keeps only migrations. |
| Remote deny-list | `REMOTE_DENIED_SETTINGS` by hand | Built from `remote: false`, with a test that the old list is a subset. |
| Docs | Help text hand-kept per row | The Feature Guide and the user manual can list settings per section from the registry. |

**Effective value.** One function, `settingFor(id, { ch, block })`, returns block, else channel,
else box, else default. It replaces the scattered `ch.x != null ? ch.x : box.x` reads (credits
alone has three variants today). Caches that depend on a setting keep keying on
`S.configGeneration` (CLAUDE.md, "Config mutation").

**Writes** still go through `dispatch({ type: 'settings.set' })` for the box and
`commitOwnerFields` for channels and blocks (CLAUDE.md, "Commands"). The registry adds no
mutation path of its own.

## 4. One home per idea

Each home is one page with three parts:
1. the box-wide settings;
2. **"Channels that differ"**: a short list of every channel or block that overrides anything on
   this page, with a jump to it;
3. related actions (FIND FADES, the live editor, …).

On a channel, the page with the same name shows the same rows as overrides. That page is
generated from the registry.

| Home | Box-wide (today's location → here) | Per channel / block |
|---|---|---|
| **Breaks › Cadence** | Ad break every; Shows pause for ad breaks; edge snap (new); No repeat ×3; ad variety (new); Line up with fades; break fade (new) | Pause for ads; Ad break every (the override the help already promises); timing mode; pod size |
| **Breaks › End credits** | Every credits field, merged from FIT TO TIME SLOTS, BREAK CADENCE and END CREDITS: Speed up end credits, When it applies, Speed, Lead time, Save at most, Start where credits are found, Layout, Squeeze background, Credits audio (new) | The same fields. Per file: lead and squeeze image stay in TITLES, but are shown here read-only as "Files with their own lead: 3". |
| **Breaks › Fit to time slots** | The 15 fit fields that aren't about credits, plus a 15-minute grid (new) | Fit mode and overrides (unchanged) |
| **Breaks › Station breaks** | Station IDs, trivia (with their card durations, new), up-next ident, preemption windows | Hide local-avail glitch |
| **Breaks › Pool / Flows / Presets** | Unchanged editors | — |
| **On screen › Logo bug** | All 7 places above in one page, with the live editor button; burn-in moves here from CRT | LOGO page: placements, hide in breaks, hide number, seasonal icons and the channel icon itself (no more badge-only) |
| **On screen › Program cards** | Rating bug, NEW/REPEAT, CC/SAP badge, advisory, formatted-for-TV card: on/off and how long they stay up (new); up-next bar and its lead (new) | The six ADVANCED hide-checkboxes move here as overrides |
| **On screen › Ticker** | Content (from the plug-in), placement, keep sharp | TICKER page |
| **On screen › Hint bar & clock** | Unchanged rows | — |
| **Picture** | CRT, picture mode, aspect, black bars, fill widescreen, static, motion, screen shape, resolution | ADVANCED › PICTURE |
| **Sound** | Show / ad volume, leveler (+ target, new), volume step and max, remember per-channel volume, tune fade-in, daypart chime (moved from PICTURE), sound output (moved from PICTURE), custom sounds | Channel volume, hide daypart chime, identity sounds |
| **Guide** | Guide rows, reminders (lead moved in from GUIDE), genre colours, unseen days and search horizon (new) | — |
| **Time machine** | On/off and time-shift badge (from EXTRAS), end-of-break lead, scrub steps, fastest shuttle, scrubber span, go-to presets, picker range, first day of week (all new) | Plugin channels' time-machine opt-in |

Rules for homes:
- A home holds at most two cards of eight rows (doc 03 §5.2). Longer ones split into sub-pages:
  Fit becomes "Fit to time slots" and "Breaks in fitted slots".
- A setting has exactly one home. Other pages may show it read-only with "Change in Breaks › End
  credits", never as a second editable control.
- Labels follow doc 03 §5.1 (sentence case, at most five words) and must survive the cable-guide
  title-casing and trailing colon (doc 13 §3). Help is one sentence that stands alone in the
  cable-guide header.

## 5. Sections

Nine sidebar bars fit in the cable-guide layout (doc 13 §5), so the regroup keeps nine and moves
HELP out of the sidebar to a **?** button in the header (it holds no settings).

| # | Section (label) | `data-tab` id (kept) | Holds |
|---|---|---|---|
| 1 | Channels | `channels` | Lineup list + channel pages (below) |
| 2 | Breaks | `programming` | Cadence, End credits, Fit to time slots, Station breaks, Pool, Flows, Presets |
| 3 | Library | `library` | Catalogue, Review, Smart channels, Channel presets, Auto-curate (moved from PROGRAMMING), Sync, Tags, Splicer |
| 4 | Picture & sound | `display` | Picture, Sound (now actually holding every sound setting), Screen & speakers |
| 5 | On screen | `guide` | Logo bug, Program cards, Ticker, Hint bar & clock, Overlays, No-signal screen, Theme & era, Custom CSS (moved from PLUG-INS) |
| 6 | Guide & time machine | new id `guidetm` | Guide, Reminders, Time machine |
| 7 | Household | `household` | Who's watching, My shows & DVR, Watch together, Parental lock |
| 8 | System | `audio` | Start-up & power, Remote & keys, This device, Network & sharing, Updates, Backups, Diagnostics & history, Air check |
| 9 | Plug-ins | `plugins` | Installed, plugin settings |

Notes:
- Ids are kept even where the name changes (doc 03 §8). The one new id, `guidetm`, is added
  alongside; the old GUIDE sub-tab id redirects to it, and `tests/ui` selectors are updated in
  the same change.
- **Channels pages** become Overview · Content · Schedule · Look · Breaks · Playback. ADVANCED is
  renamed Playback (picture, audio, captions, file handling) because its on-screen checkboxes
  move to Look › Program cards. Content tags move from BREAKS › ADS to Overview, where they are
  identity, not ads.
- **This device** collects the per-device settings (usage mode, TV-mode screen, screen-off action,
  edges, sound output stays in Sound but is labelled "on this device"). "Interface size" becomes
  per device, which is what its panel already claims.
- **Simple / Advanced** becomes `level` on registry entries instead of the undocumented
  `data-simple-settings` attribute (doc 13 §5 refers to the switch; doc 03 never described it).
  In Simple, a home shows only its basic rows and a "More settings" link.
- **The TV menu's SETUP** uses the same nine sections and the registry's `tv` flag. The
  duplicates in §1.3 go: REMOTE and SLEEP TIMER keep their top-level shortcuts, and SETUP lists
  them once.

## 6. New options

Ranked by how likely a user is to want them. File references are where the fixed value is today.

### Tier 1: tied to recent work, or missing in a way people notice

| Setting | Home | Today | Proposed |
|---|---|---|---|
| Pause for ads, per channel and block | Breaks › Cadence | Box-wide only (`breaksPauseProgram`, interstitials.js) | Follow box / On / Off. The block override has to stay planned per file, so a block that sets it counts as "the source's own" (the gate at interstitials.js `applyBreakPlan`). |
| Ad break every, per channel | Breaks › Cadence | Promised by the help, has no UI | Number override |
| Keep breaks away from a show's start and end | Breaks › Cadence | `PLAN_EDGE_SNAP_S` 60 s | 0–300 s (0 turns snapping off) |
| Ad variety | Breaks › Cadence | Swaps only spots the same length to the second (`planRef`) | Off / Same length / Within N s. A shorter spot is padded to the planned length with black. A longer one can't be swapped in, because the plan's lengths are fixed. |
| Skipping a break (Q) | Breaks › Cadence | Moves the view ahead to the break's end | Skip ahead / Only in the time machine / Never |
| Credits audio | Breaks › End credits | Always muted (broadcast-fx.js `startCreditsSpeedup`) | Mute / Keep / Lower |
| Fit grid 15 minutes | Breaks › Fit | 30 or 60 only (`normalizeFitConfig`) | 15 / 30 / 60. The `/ 30` and `slot / 1800` maths in `planFit` need checking for 15. |
| End-of-break jump lands | Time machine | `BREAK_END_LEAD_MS` 5 s | 0–30 s before the show returns |
| When a file won't play | Playback (box and channel) | One retry, then an automatic ffmpeg fix that moves the original into `_originals_backup` and swaps in the fixed copy; 3 failures = OFF THE AIR | Fix automatically / Skip to the next file / Show the error; retries 0–3. This is the strongest case for a choice: the user's files get moved without asking. |
| Program-start cards stay up | On screen › Program cards | 16 s, six timers (broadcast-fx.js) | 3–30 s |
| Up next appears | On screen › Program cards | 45 s before the end, skipped under 60 s (breaks.js) | 10–120 s before the end |

### Tier 2: small, clearly useful

| Setting | Home | Today → proposed |
|---|---|---|
| Warn before auto-standby | System › Start-up & power | Goes dark mid-show → countdown 0–120 s |
| On launch | System › Start-up & power | Always powers on → Power on / Standby (for an always-on PC) |
| Sleep fade length; sleep countdown shows | Sound / System | 25 s; last 5 min → 5–120 s; 0–15 min |
| Relock unlocked channels | Household › Parental lock | Until restart (`unlockedPinChannels` is never cleared) → after 5–240 min / at power-off |
| Welcome-back card | On screen › Program cards | Always, after 2 h away → on/off and "after away" 0–24 h |
| Trivia card / text station ID on screen | Breaks › Station breaks | 8 s / 5 s → 4–20 s / 3–15 s |
| Break fade | Breaks › Cadence | 180/220 ms per pool entry only → box default 0–1000 ms |
| Time-machine go-to presets, picker range, first day of week | Time machine | 6 AM, Sat 8 AM, ±7 days, Sunday → hours, 1–30 days, Sun/Mon |
| Scrub step, fastest shuttle, scrubber span | Time machine | 10 s→30 s→2 min; 7200×; ±3 h → choices |
| Check for updates every | System › Updates | Once at launch → 6 / 12 / 24 h |
| Leveler target | Sound | −24 / −30 LUFS → −30 to −16 |
| Remote buttons | System › Remote & keys | The keyboard can be remapped; TV-mode button meanings (◀ guide, ▶/OK banner, Blue skip, hold-OK menu) cannot → an action picker per button |

### Tier 3: tuning knobs, behind Advanced

Resync tolerance (3 s), fix quality (CRF 20), long-press time (500 ms), cursor and touch-bar hide
(3 s / 4 s), volume OSD (1.5 s), banner hub idle close (12 s), recent channels count (6), TV
reminder toast (15 s), "not watched in" days (14), program search horizon (7 days), 4-digit
channel numbers, DVR planning window (14 days), air checks kept and shown (24 / 6), LAN pairing
lifetime (90 days), viewer and companion ports (8724 / 8725), PC shutdown countdown (20 s), music
card end lead (4 s), minimum gap between act-break fades (60 s), shortest spread break in fitted
slots (60 s).

Left out on purpose: caches, IPC and probe timeouts, safety caps, float epsilons, poll intervals,
and the black/silence detection thresholds in `main/media/breakdetect.js`.

## 7. Names, ranges and leftovers to fix

- One key name per idea: `logoBugHideOnBreaks` (box) vs `logoBugHidesOnBreak` (channel) get one
  registry id. Config keys don't change; the registry maps both.
- FAVOURITE (TV) vs FAVORITE (desktop); "HIDE FROM TUNING" vs "SHOWN WHEN SURFING" (inverted);
  "Channel at start-up" vs "STARTS ON"; "Channel number delay" vs "NUMBER ENTRY WAIT": one label
  each, from the registry.
- The TV menu shows fallback values that aren't the real defaults (`NORMAL`/`AUTO` vs
  `standard`/`contain`, tv/setup.js): read the default from the registry.
- "Aspect ratio" vs "Screen shape": rename to "Picture shape" (what the video does) and "Screen
  shape" (what the window is), the same pair per channel.
- Stale cross-references in help: "DISPLAY tab", "DISPLAY › Logo bug", "System › This device",
  "SETTINGS › Break cadence", "INTERSTITIALS POOL", "SYSTEM › ffmpeg". A test fails when help
  text names a section or page that doesn't exist.
- `ch.commercials` (deleted on migration, still read in three places) and `config.eas.*` (seeded,
  no reader): remove or give a UI.
- The channel editor's ALL-CAPS labels move to sentence case with real help lines, which the
  cable-guide header then shows.

## 8. Constraints

- Control ids, `data-tab` ids, stored sub-tab ids and config paths do not change. Moved panels move
  whole (doc 03 §8). Where a test or `PLUGIN_DEVELOPMENT.md` names a moved thing, it changes in
  the same commit.
- Same markup in both layouts; cable-guide differences stay in `cable-guide.css` (doc 13).
- Desktop keyboard behaviour is unchanged; the G-key jumps (`data-go-key`) keep their letters.
- Plugin settings keep their declarative `fields` and `data-plugin` scoping. A plugin field is a
  registry entry with `home: 'plugins/<id>'`.
- Setup tab switch stays under 100 ms (doc 00 §5). Search over the registry is in memory.
- The LAN control panel is this shell (doc 06). `remote: false` entries stay host-only.

## 9. Build order

Each step is shippable and leaves the app working.

1. **Registry, read-only.** `core/settings-registry.js` with every existing setting, and
   `settingFor()`. A test checks every static row's label, help and range against it, and every
   config path written by setup against an entry. No visible change.
2. **Defaults from the registry.** `applyConfigDefaults` and `setting-defaults.js` read it. A test
   compares the defaults before and after on a fresh and a real config.
3. **Search and TV menu from the registry.** Channel fields become searchable. `tv/setup.js` is
   generated; duplicates go; ranges and fallback values match desktop.
4. **OverrideRow and the channel pages.** Breaks, Look and Playback pages built from the registry.
   The ADVANCED checkboxes and the END CREDITS card become override rows.
5. **Homes.** Move panels whole into the homes in §4, End credits first (the worst split), then
   Logo bug, Sound, Time machine. Fix the names in §7 as each one moves.
6. **Sections.** The §5 regroup, HELP to the header, the `guidetm` section, Simple/Advanced from
   `level`.
7. **New options**, Tier 1 first. Each one is a registry entry, a home row, a channel override
   where it says so, a TV item where it says so, and a What's New line.

Steps 1–3 are pure groundwork and can land before any decision on 5–6. Tier 1 options can be added
to today's layout right away (as rows in their current sections) and then move with their homes.
