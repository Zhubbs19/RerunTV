# Companion App — Feature and Usability Audit

Date: 2026-09-11
Scope: `plugins/companion-app/` — the LAN control surface served to the Android
companion and to any phone browser (`remote/index.html`, `remote/remote.js`,
`remote/style.css`), plus the routes and state contract behind it
(`main.js`, `renderer/js/power.js`'s `pushRemoteState`, `app.js`'s
`onCompanionApplySettings`).

## Status — most of this shipped on 2026-09-12

Findings 1, 2, 4, 5, 6, 8 and 9 are fixed, along with most of the lower-impact
list; finding 3 was addressed in its lighter form (curate) and finding 7 only
in part. What each fix actually does is recorded under the finding itself.
Verified end to end against a real running box by `test/verify-companion-app.mjs`,
which pairs the way a phone does and then exercises the routes the UI depends
on — 14/14 checks, including 14 of 14 channels reporting real programming and
both a refused and an applied settings patch being reported correctly.

Still open: the remote cannot tell whether the on-screen guide or Setup is
showing (finding 7, partially — `/state` now says whether a break is on air,
but not which screen the box is on), there is still no way to un-pair a device
from the phone, the interface-size control still uses non-standard `zoom`, and
command feedback is still optimistic.

## How this was tested

The companion page was served from a throwaway static server backed by the
INSTALLED app's real `channels.json`, so the Settings tab rendered the user's
actual configuration rather than a toy one, and the Channels/Guide tabs
rendered the real 14-channel lineup. It was driven in a browser emulating a
375x812 phone viewport — the size the whole design targets. Pairing was not
involved; the page and its API shapes are identical either way.

Measurements quoted below are from that live page, not from reading the CSS.

## Executive assessment

The chassis is better than most: every button is at least 44px tall,
`touch-action: manipulation` is set, focus-visible rings exist, safe-area
insets are respected on all four edges, reduced motion is honoured, the
connection lamp reports offline, held buttons auto-repeat, and secrets are
redacted in a way that still lets you type a replacement. None of that needs
revisiting.

What the app is missing is not polish. It is **feedback and editorial
judgement**. The TV already tells the phone what state it is in, and the phone
throws that information away, so every control is a blind fire-and-forget
switch. And the Settings tab hands the user the raw config tree — 195 fields,
68 nested groups and 19 JSON textareas — instead of the settings a person
would actually reach for a phone to change.

Findings are ordered by how much they cost the user.

## High impact

### 1. The TV sends state the UI ignores

`pushRemoteState` (`renderer/js/power.js:33`) publishes `muted`, `volume`,
`crt`, `pictureMode`, `aspectMode`, `audioMode` and `quickJumpSlots` on every
state-changing action. `pollState` in `remote.js` reads only `number`, `name`,
`powered`, `timeMachineOn` and `shuttleDir`. Everything else is discarded.

The consequences are all over the Remote tab:

- MUTE does not show whether the TV is muted, so it is a coin flip.
- There is no volume readout at all, though the level is in every poll.
- PICTURE MODE, ASPECT RATIO, CRT EFFECT and AUDIO MODE cycle blind. You
  press and then look at the TV to find out where you landed.
- The Time Machine SAVE 1-4 / GO 1-4 buttons do not show which slots are
  occupied, though `quickJumpSlots` is right there in the payload.

This is the cheapest large win in the app: the data already arrives every
1.5 seconds, and binding it needs no new route and no protocol change.

**Fixed.** `applyBoxState` in `remote.js` now renders all of it: MUTE lights up
and says MUTED, the Volume panel carries a percentage readout and a meter, the
four cycle buttons show the mode they are currently on, and a GO slot with
nothing saved in it is disabled and says so. `/state` also gained an `onAir`
field, so the header says COMMERCIAL BREAK during one instead of naming a show
that is not on screen.

### 2. A save can silently do nothing and still report success

`POST /api/settings` relays the patch into the renderer and answers `204`
immediately, without waiting to learn what the renderer did with it. The
renderer then drops, without a word, any patch section that is not already a
key of `S.config`, any blocked section (`channels`, `plugins`), and any value
whose shape does not match what is already stored
(`app.js:551`, `deepMergeExistingKeys` / `sameConfigShape`).

The phone meanwhile shows "Changes accepted. Connected TVs will refresh their
settings automatically", then reloads the config 750ms later — so the value
quietly snaps back to what it was and the success message is the only thing
the user has to go on. A rejected setting and an applied setting look
identical.

Fix: have the renderer report which sections it applied and which it refused,
and let `/api/settings` answer with that instead of a bare 204. The UI already
has a notice bar to say "3 applied, 1 could not be changed" in.

**Fixed**, by the second half of that: the renderer records each rejection with
a reason and the outcome rides back in the next pushed state, which the phone
already polls every 1.5s. Saving now says "Sent to the box - waiting for it to
confirm" and is replaced a moment later by what actually happened, naming any
refused section and why. Reporting through the existing push rather than a new
IPC channel keeps the plugin's manifest unchanged, so no paired install has to
re-approve anything.

### 3. The Settings tab is a config dump, not a settings screen

Rendered against the real configuration, the tab produces:

| Thing | Count |
|---|---|
| Editable fields | 195 |
| Nested collapsible objects | 68 |
| Raw JSON textareas | 19 |
| Top-level groups | 7 |

Six groups are curated. The seventh, `MORE`, holds 28 unsorted top-level keys
— `EAS`, `HBO`, `HSN`, `AREA51`, `PPV`, `SYNTH`, `TELETEXT`, `TMDB`,
`SCHEMA VERSION`, `PLAYBACK RESYNC` and the rest — because `GROUPS` in
`remote.js` is a hand-maintained allowlist that the config has outgrown. Every
plugin that adds a config section lands in this bucket.

Labels are derived mechanically from key names (`labelFor` splits camelCase),
so the phone says `REMINDER LEAD MINUTES` where the TV's own setup screen has
a real label and help text. Nothing explains what any of it does. And 19
settings — `FLOWS`, `POOL`, `PRESETS`, `CURATION PROFILES`, `RATINGS`,
`STATIONS`, `SLIDES`, `TRIVIA QUESTIONS`, `AIR CHECKS` and others — are JSON
textareas, which nobody is going to edit correctly on a phone keyboard.

Two directions, either defensible:

- **Curate.** Ship an explicit list of phone-worthy settings (volume, mute,
  picture, CRT, captions, sleep timer, theme, interface size, update
  strategy), each with the label and helper text the TV already uses, and put
  the raw tree behind an "Everything else" disclosure for the rare case.
- **Or make the tree honest.** Derive the groups and labels from the same
  declarative source the TV's PLUGINS tab uses
  (`renderer/js/plugin-settings-schema.js`) so a new plugin section arrives
  labelled and grouped instead of falling into `MORE`.

The second is more work and pays off permanently; the first is a weekend and
covers what people actually do from the couch.

**Partly fixed**, taking the first path. A new EVERYDAY group leads the tab
with the seven settings someone actually reaches for a phone to change (the
three volumes, mute, CRT, picture, aspect), each lifted out of the group it was
buried in - so no setting appears twice - and each carrying a plain sentence of
help. `MORE` is now named PLUGIN & CHANNEL FEATURES and sorted, which describes
what is in it instead of apologising for it. The raw tree underneath is
unchanged: deriving labels and groups from the declarative plugin-settings
schema is still the permanent fix.

### 4. Channel flag toggles are too small to hit

On the Channels tab, the FAVORITE and QUICK-TAP toggles measure **24px tall**
with a **9px** label and an 18px checkbox — two of them side by side at the
right edge of each row. Every other control on the page respects the 44px
minimum; these two do not, and they are the only controls on that tab besides
the tune button.

Fix: make them full-height pill toggles on their own row, or swap them for two
icon buttons (star / lightning) sized like everything else.

**Fixed** the second way - star and lightning buttons at the same 44px minimum
as every other control, with `aria-pressed` and a real label each.

## Medium impact

### 5. The tab bar is clipped with no affordance

At 375px the tab strip needs 410px, so TOOLS is cut off by 35px. It does
scroll (`overflow-x: auto`) but the scrollbar is hidden, there is no edge
fade, and switching tabs never scrolls the active one into view. A user who
never swipes the strip may not know the Tools tab exists.

Fix: shorten the labels, fade the right edge, and call `scrollIntoView` on the
newly active tab.

**Fixed**, all three: CHANNELS became LINEUP, the strip fades at its right
edge, and switching tabs scrolls the new one into view. The tabs also became
real tabs to a screen reader (`role="tab"`, `aria-selected`, panels
associated), which was a separate low-impact finding.

### 6. The Guide tab has no guide in it

The tab named after the on-screen guide contains arrow buttons plus a flat
list of channel numbers and names. It says nothing about what is on. The TV
computes exactly this on demand — schedule resolution is a pure function of
channel and timestamp — so a NOW / NEXT line per channel is available without
inventing any new machinery, only a new route.

Two smaller problems in the same list: the "TUNE" and "★ FAVORITE" text at the
right of each row looks like a button and is not, and the list is a near-copy
of the Channels tab list, so the two tabs are hard to tell apart once you
scroll past the header.

**Fixed.** The box now pushes a lineup snapshot - every channel with what is on
now, what is next, and when the current programme ends - on a 30s timer, riding
the same state push rather than a new IPC channel. The Guide tab leads with
that listing, each row a single tappable card that tunes the channel, with the
one you are watching highlighted; the fake TUNE/FAVORITE badges are gone. That
also makes the two tabs distinct: GUIDE is what's on, LINEUP is editing flags.

### 7. The remote is context-blind

`/state` says nothing about what is on screen — whether the guide is open,
whether Setup is showing, whether a break is playing. So the Guide panel's
arrow buttons mean one thing with the guide open and something else with it
closed, and the panel cannot say which. The same arrows appear in three
panels with three different captions and identical behaviour.

Adding a `screen` field to the state payload would let the companion relabel
or disable controls that do not apply, and would let the Guide tab stop
pretending the guide is open.

### 8. The file browser drops data it already has

`listDirectory` returns `size` and `mtime` for every entry; the UI renders
only the name. There is no search, no sort, and no size shown before you tap
DOWNLOAD on what might be a 4GB file. Downloads are plain links with no
progress indication.

**Fixed** except the progress: every row now shows a human size and date, and
a filter box narrows the current folder. Sorting is still the server's
folders-first, name-order listing.

### 9. Getting to the volume takes a scroll

The Remote tab stacks POWER/MUTE/GUIDE/INFO, then a 12-key numpad, then a
210px D-pad, and only then the CH and VOL rockers — so the single most-used
control on any remote is below the fold on a phone. The numpad, by contrast,
is the least-used control on a box whose channel list is two taps away.

Also on this tab: the QUICK CHANNELS empty state reads "MARK A CHANNEL
QUICK-TAP IN CHANNELS TO ADD IT HERE" and offers no way to go do that.

**Fixed.** Volume and channel now sit in their own panel directly under the
hero row, above the keypad, with the level readout and meter beside them. The
empty quick-channels state has an OPEN LINEUP button instead of instructions.

### 10. BOX FUNCTIONS is a wall of app jargon

Fourteen buttons in one undifferentiated grid, mixing things a viewer wants
(CAPTIONS, SLEEP TIMER, ASPECT RATIO) with things only the person who built
the channel lineup wants (OVERLAY EDITOR, HINT BAR, SETUP, FULLSCREEN). They
are in no obvious order and none of them shows its current state (see finding
1). Splitting into "Watching" and "Set up the box", and moving the second
group behind a disclosure, would make the first group findable.

**Fixed** exactly that way: PICTURE & SOUND holds the eight a viewer wants,
each showing its current value, and the box-wrangling six sit behind a SET UP
THE BOX disclosure.

## Lower impact

- **Tabs are not tabs to a screen reader.** The strip is five plain buttons
  with no `role="tab"`, no `aria-selected`, and no association to the panels
  they show.
- **No unsaved-changes guard.** RELOAD discards a pending patch without
  asking, and switching tabs gives no hint that edits are still pending. The
  enabled SAVE button is the only signal.
- **No home-screen install.** For a page whose entire purpose is to be opened
  on a phone, there is no web app manifest and no apple-touch-icon, so it
  always runs inside browser chrome. **Fixed** - the plugin serves a generated
  `/manifest.webmanifest` and an icon, and the page carries the iOS
  add-to-home-screen meta tags.
- **Feedback is optimistic.** `sendCommand` shows "X SENT" before the request
  resolves, and only corrects itself if the network call outright fails.
- **No way to un-pair from the phone.** A device can pair but cannot sign
  itself out.
- **Possible double-send on tap.** Commands fire on `pointerdown`, with a
  `click` fallback guarded by `event.detail === 0` for keyboard use. On any
  browser that reports `detail: 0` for a touch-generated click, both paths
  fire and the key is sent twice. **Closed defensively** - the click fallback
  now also ignores anything within 700ms of a pointer-driven send, so the
  question no longer needs answering per browser.
- **The interface-size control uses `zoom`.** `document.body.style.zoom` is
  non-standard; older iOS Safari and Firefox before 126 ignore it silently,
  so the setting appears to do nothing on those.
- **TRIGGER NEWS has no confirmation.** A red button one tap from interrupting
  whatever is playing, sitting in a grid with three harmless ones. **Fixed** -
  it and the EAS test both confirm first, via a `data-confirm` attribute any
  button can carry.

## What is already right

Worth not regressing: 44px minimum touch targets everywhere except finding 4;
`touch-action: manipulation` so rapid taps do not zoom; visible focus rings;
`env(safe-area-inset-*)` on header, shell and toast; `prefers-reduced-motion`
honoured; a real offline state with a red lamp; settings search that expands
matching parents; credential fields redacted in a shape that still accepts a
replacement; press-and-hold repeat on arrows and rockers; and a two-column
layout above 850px so a tablet is not just a stretched phone.

## Suggested order of work

1. Bind the state the TV already sends (finding 1). Largest gain, smallest
   change, no protocol work.
2. Make save results honest (finding 2). Currently a correctness problem
   dressed as a UX one.
3. Fix the flag toggles and the tab clipping (findings 4, 5). Both are small.
4. Decide the Settings direction (finding 3) before adding anything else to
   that tab.
5. NOW/NEXT in the Guide tab (finding 6), which needs a new route and is the
   biggest genuine feature gap.
