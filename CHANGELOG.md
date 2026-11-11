# Changelog

What changed in RerunTV, newest first. This is the list the app shows under HELP > What's New.
It is generated from `renderer/js/setup/help.js` by `node scripts/release-notes.js --changelog`, so edit it there.
Each GitHub release lists the entries that are new since the release before it.

## 2026-11-17

- On the two cable-guide skins, the pop-up questions in Channel Setup (Add Channel, remove and rename prompts, error messages) now look like the rest of the setup screen: the same buttons, text boxes and wording style. In every theme a button’s label stays on one line, so Add Channel’s four choices no longer wrap.

## 2026-11-16

- The companion app’s NEARBY BOXES search now finds a box this phone has paired with before. It used to list nothing once the phone had been paired, so the address had to be typed again. Needs companion app 0.4.1.

## 2026-11-15

- A game controller now works on the setup screen: the D-pad or left stick moves between controls, ◀▶ change a list or slider, and A presses the one in focus.
- Pressing A on a text box opens an on-screen keyboard you type on with the controller, on the setup screen and anywhere else a text box has focus. It has upper case, lower case and symbols; the bottom-left key switches between them, DONE keeps the text and B cancels. Turn it off with On-screen keyboard for text boxes (SYSTEM › REMOTE & KEYS › GAME CONTROLLER, or SETUP › CONTROLS in the TV menu).
- Dialogs answer the controller in desktop mode too: the D-pad moves between their buttons, A presses and B cancels.

## 2026-11-14

- Game controllers have their own settings: SYSTEM › REMOTE & KEYS › GAME CONTROLLER. Choose what every button, trigger and stick direction does, either a remote button (OK, Guide, Channel up…) or any keyboard shortcut (Fullscreen, Sleep timer, Skip the commercial break…). Press a button on the controller and its row lights up.
- New on a controller out of the box: the right stick is the volume, clicking the left stick mutes, clicking the right stick goes back to the last channel, and in TV mode holding A opens the TV menu.
- A controller is now ignored while another window is in front, so playing a game on the same PC doesn’t change channels. Respond while another window is in front turns that off; Stick dead zone helps a worn stick. Both are also in the TV menu under SETUP › CONTROLS.

## 2026-11-13

- A phone the box no longer recognises goes back to the companion app’s pairing screen. Before, it showed NO SIGNAL and its Settings page failed with a JSON error.
- The companion app can now reach every screen on the box. Its new SCREEN tab shows what the TV is showing (a setup page, a dialog, the TV menu, the guide or a plugin page) and lists every button, switch, list and text field on it. Tap one to press it, pick a choice, move a slider or type into a field with the phone’s keyboard. The phone’s D-pad, OK, Back and Menu now work the way the box’s own remote does in TV mode, so the TV menu and dialogs answer them too. The plug-in, network, update, backup, PIN lock and PC power controls are shown but stay locked: they’re changed on the box.
- The companion app has the schedule calendar: MORE › SCHEDULE CALENDAR shows what each channel airs on every day of the month, with overlaps and blocks that have no folder marked. Add a block for a day, change a block’s dates, hours, days, priority and how it runs, give it a folder from your channel folders, remove it, or override one day of a daily or weekly block.

## 2026-11-12

- The phone companion app wears your box’s theme: Cable Guide HD ’15 gives it black screens with blue buttons, Classic ’05 navy with yellow, and every other theme its own colours. It changes when you change the box’s theme and opens in the last box’s colours.

## 2026-11-11

- Shows and movies now pause for their commercial breaks. Before, the schedule kept a program running underneath its ads, so jumping with the time machine, tuning in or reading the guide found it minutes further on after every break, as if it had played during the commercials. Now it picks up exactly where it stopped, and the guide gives each program its full time, breaks included. On by default; turn it off with BREAKS › CADENCE & PRESETS › Shows pause for ad breaks, or for one channel on its BREAKS › ADS page (a schedule block can set its own too).
- New break settings under BREAKS › CADENCE & PRESETS and in the TV menu’s new SETUP › BREAKS: how far breaks keep from a show’s start and end, ad variety (other ads the same length, also slightly shorter ones, or the same ads every time), and whether Q may skip a break (always, only in the time machine, or never). A channel can set its own ad break interval on its BREAKS › ADS page.
- More you can now set: when Up next appears and how long the rating and other program cards stay up (ON SCREEN › PROGRAM CARDS), where the end-of-break jump lands, what a file that won’t play does (fix it, stand by until the next program, or show an error, under SYSTEM › START-UP & POWER or per channel on its PLAYBACK page) and how often a stalled file is retried, what sped-up end credits sound like (muted, kept or turned down), and a 15-minute grid for fit to time slots.
- A channel’s ad cadence now counts program time, and a break that would land within a minute of a program’s start or end moves to between programs. Each break plays the same length every time it airs, with different ads of the same length so it still varies. Skipping a break (Q) moves you ahead to where it ends, the way a DVR skips ads.
- The time machine can jump to the end of a break: press \ (beside ] ) or pick END OF BREAK in the TV menu’s TIME MACHINE. It lands a few seconds before the show comes back, so you can check the cut back without sitting through the ads.
- Setup is reorganised so each setting has one home. PROGRAMMING is now BREAKS; the guide and the time machine have their own GUIDE & TIME MACHINE section; HELP moved to the ? button at the top. A channel’s ADVANCED page is now PLAYBACK, and its program card switches moved to LOOK › PROGRAM CARDS. Settings search finds every setting by its new place, a channel’s own settings included.
- New settings: a warning before auto-standby turns the TV off, and whether RerunTV starts on or in standby (SYSTEM › START-UP & POWER); how long the sleep timer fades, and when its countdown appears; relocking a PIN channel after a while or when the TV is turned off (HOUSEHOLD); the welcome-back card and how long away counts (ON SCREEN › PROGRAM CARDS); how long the trivia card and the station ID bar stay up, and the fade into and out of breaks (BREAKS); how loud the volume leveler aims (PICTURE & SOUND › SOUND); and how often to check for updates.
- The time machine’s jumps and ranges are yours to set under GUIDE & TIME MACHINE › TIME MACHINE: which morning and weekend day its presets go to, how many days the date picker reaches, the week’s first day, the scrubber’s first step and span, and the fastest shuttle speed.
- In TV mode you can choose what ◀, ▶, OK, Back and the colour buttons do on live TV: SYSTEM › REMOTE & KEYS › REMOTE BUTTONS, or SETUP › REMOTE in the TV menu. The guide and menus keep their own keys.
- The companion app’s Settings screen now shows the same sections and pages as setup here, with a Simple and Advanced view, every setting’s default even if you never changed it, and the new settings above. The phone’s remote counts down to the end of a break, offers SKIP BREAK only where your skipping rule allows it, and has END OF BREAK in its time machine. A paired phone can no longer change the PIN lock, network, update or PC power settings; those stay on the box.

## 2026-11-10

- Plugin channels show the channel banner on the Cable Guide themes too, with the channel’s name and what’s on.
- Changing channels while the banner is up now switches it to the new channel. Before, flipping onto a plugin channel left the previous channel’s banner on screen.

## 2026-11-09

- Your media library, viewing history and saved lookups (TMDB results and the volume-levelling and black-bar measurements) now live in one database file, rerun.db, instead of large files rewritten on every change. Library edits and the viewing log save only what changed, and the viewing history keeps up to 50,000 programs instead of 2,000.
- Nothing to do: everything moves over by itself the first time this version starts, and the old library file is kept beside it as library/index.json.pre-sqlite. Your channel lineup is unchanged and stays in channels.json.

## 2026-11-08

- Fourteen older themes are gone: the blue guide grids the Cable Guide skins replaced, near-copies of other themes, and looks not based on a TV box. If you used one, your box switches to the closest theme still included (most go to Cable Guide HD ’15 or Classic ’05).

## 2026-11-07

- RerunTV opens about a second sooner: plugins that run in their own process now start side by side instead of one after another. A plugin still waits for the plugins it depends on.

## 2026-11-06

- RerunTV runs on a newer engine (Electron 45, Chromium 156), with its security fixes.

## 2026-11-05

- Sped-up end credits now start where a film’s credits really begin, instead of a fixed 90 seconds before the end. FIND FADES (PROGRAMMING › CADENCE & PRESETS) and FIND ACT BREAKS on a channel’s TITLES now also find where each file’s end credits start, from the same read, and a channel with SPEED UP END CREDITS on uses it. Credits on a black background are found; ones over picture keep the channel’s lead time. On a channel fitted to time slots, the credits squeeze starts there too. Turn it off with Speed up credits from where they start.

## 2026-11-04

- Breaks inside a show can land where it was really cut for commercials. PROGRAMMING › CADENCE & PRESETS › Line up mid-show breaks with fades moves each mid-show break to the nearest fade to black (within 3 minutes, adjustable), so a break no longer cuts a scene in half. Breaks with no fade nearby stay where they were. On a channel fitted to time slots, the breaks spread through each program move the same way.
- The fades are found by reading each show once: FIND FADES there does every show on channels that break inside shows, and FIND ACT BREAKS on a channel’s TITLES does the files you select. About half a minute per episode, a few minutes per film; you can stop and pick up later. Openings and end credits are ignored.

## 2026-11-03

- TMDB matches go down to the episode: a file with a season and episode (S02E01 in its name, or from its details) gets that episode’s own title, description and air date instead of the show’s, and MATCH searches by the show’s name rather than the whole file name.
- A TMDB match fills in an empty TV rating from the US rating; a film’s rating becomes the one it airs under (PG-13 shows as TV-14).
- Matching prefers a film for a feature-length file and a show for an episode, and keeps a year in the name to pick the right version. MATCH FOR SELECTED looks a show up once for all its episodes, and re-does episodes that only had the show’s description.
- Both are switches under PLUGINS › TMDB Metadata › MATCHING.
- New plugin, TVmaze Episodes: a TVMAZE button on each TITLES row fills in an episode’s title, synopsis and series name, and records when and on which network it first aired. No account or key; data from TVmaze.com (CC BY-SA).
- Program info shows what the matches found. On the cable-box layout the page is headed by the series, the description opens with the episode in quotes and ends with “Starring …” and “First aired September 20, 2005 on its network.” The I card on other themes adds the series and episode number, the poster, and first-aired and cast tags. GUIDE & THEME › Cast and air date on program info turns the credits off.
- DETAILS FROM YOUR FILES also picks up posters beside your media (a file’s own -thumb or -poster image, a movie folder’s poster.jpg or folder.jpg, a show folder’s poster) for the I card.

## 2026-11-02

- Fit to time slots (opt-in, per channel or for the whole box): each program ends on the next half hour or hour. One that runs a little long is shortened by speeding up its end credits, then gently sped up, within limits you set, and shows a formatted-for-television card; one that runs short gets breaks to fill the gap. End credits gain settings for when they speed up, how much they may save, and four squeeze-back layouts.
- The full guide’s header no longer overlaps: title and channel, time and rating, and two lines of description all fit above the search line.
- The Classic skin uses a typeface closer to the original boxes’, and the Mini Guide sits straight on the picture without a border.
- Episode titles, descriptions, ratings and series names can come from the files themselves: .nfo files beside them (the kind media centers and library managers write) and tags stored inside them. Use READ NFO & TAGS on a channel’s TITLES page, or LIBRARY › SYNC › DETAILS FROM YOUR FILES to fill in every channel at once or to fill new files as they arrive. Only empty details are filled, and release names or website banners left in a file’s tags are ignored.
- LIBRARY › REVIEW can read the same files, so its suggestions use a show’s real name, episode titles, ratings and descriptions where a file has them.
- A TMDB match now belongs to the file, not one channel: it reaches every channel and schedule block that plays the same file, a file newly added to a channel picks up what its other copies already have, and LIBRARY › SYNC › FILL IN ALL CHANNELS NOW shares matches you made earlier.
- TMDB matching finds titles whose file names carry a year, such as “Some Special 1964”, “(1995). Some Film” or “An Episode (February 13, 1943)”. The year is used to pick the right version instead of being searched for.
- On the cable-box layout, a program page ends with “Starring …” when a TMDB match found the cast. The TMDB Metadata plugin asks for approval once after updating, because it now declares the site it contacts.
- A new on-screen layout modelled on a mid-2000s digital cable box, in two skins: HD (black, square, blue focus) and Classic (blue, rounded, yellow focus). Pick either under GUIDE & THEME › Theme; every older theme keeps the layout it always had.
- On the new layout: the guide keeps the live picture in its corner, the channel banner and a Mini Guide sit over the picture, MENU opens a Quick Menu and then the Main Menu, and I opens a program page with its actions as icons.
- New pages there: Search with an on-screen keyboard, Listings by Channel, and Messages (your reminders and a downloaded update; an envelope in the corner counts them).
- Channel Setup on the new layout shows the setting you are on and what it does at the top, instead of a line under every row, and on/off and choice settings read as ‹ value › bars.
- The RECORD button on a remote now records; captions and audio-track buttons work.
- New installs start on the HD skin.
- The new layout has depth: shaded bars and cells, a focus that glows, and panels, buttons and dialogs that cast a shadow. Classic gets the glossy buttons of its era.
- In a desktop window the new layout uses smaller type, so the guide shows about twice as many channels; TV mode keeps the size you can read from across the room.
- Short shows no longer clutter a row: back-to-back episodes too short to label merge into one guide cell, named for the series when they are all one show.
- Buttons are spaced evenly, with more room around them.
- The update window that shows while RerunTV updates now matches your theme, including the HD and Classic skins.
- Channel logos on the HD and Classic skins: each channel’s icon shows in the guide, the Mini Guide, the channel banner and program pages. While a menu or page shows the picture in its corner, the logo bug shrinks with it into the same spot.
- The time machine calendar fills the screen and shows the chosen day’s whole schedule for a channel, with special programming named and marked. Pick a program to jump to its start, or step through channels with ‹ ›.
- On the HD and Classic skins: no scrollbars, screens cut instantly like a real cable box, and What’s New and the guide’s top line use the skin’s own type.
- Search on the HD and Classic skins lists each show once, with how many times it airs; OK on it lists every airing. Prefer the old list of every airing? Turn off Group search results by show under GUIDE & THEME › Guide (also in the TV menu).
- Fixes on the HD and Classic skins: the guide’s time row lines up with the programs under it, the menu opens over the guide instead of underneath it, choosing Search no longer types an A, and channel names show as you wrote them.
- Lists on the skins show whole rows instead of a half-cut one at the bottom: the full guide, Search, Listings by Channel and the calendar’s day.
- The time machine bar, quick notices, TIME SHIFT, Recent Channels and the calendar take the skin’s look and are readable from the couch; the LIVE marker no longer covers a program title.
- Pointing with the mouse outlines a choice instead of filling it, so only the focused or chosen item looks selected. Setup on the skins reads in title case, and the channel banner and corner tags stay out of the way while a menu or page is up.

## 2026-10-29

- Plugins you install yourself now work in a release build: a plugin talks to its own background code through one shared, checked route instead of needing its own entry built into the app.
- Plugin permissions in plain words: the approval prompt and each plugin’s page say where it runs, which sites, files, programs and ports it can use, and whether it is sandboxed (a plugin that is not gets a red APPROVE FULL ACCESS button). A plugin can list the sites it connects to, and a sandboxed one is held to that list. Each plugin’s page also shows what it has done since start: calls, refused calls, sites reached and sites blocked.
- Companion app on Android: the app now reaches the box over your home network (it could not before in installed builds), and SCAN QR CODE reads the pairing QR on the Companion App panel. A failed connection or scan now says what was tried and why it failed.

## 2026-10-22

- Skip a commercial break with Q (the blue button on a remote, SKIP BREAK on the phone). The show comes back where it left off.
- The sleep timer now shows a SLEEP m:ss countdown over the picture for its last five minutes, and the phone remote shows it too, along with how long the current show has left and what is next.
- The I details card also says why the show is on: the block or lineup that picked it and the ad flow behind its breaks.
- The guide has a channel view button next to search: ALL CHANNELS, FAVORITES, or channels you have not watched in 14 days.
- When the box starts after a long time away, a short card says how long it was off and lists your next reminders.
- Setup: DUPLICATE, RUNNING BEHIND… copies a channel shifted by some hours (a second copy of a channel that is never on the same episode); the multi-select bar can hide channels from tuning and shift their schedules, with a count of the programs that will move. The CHANNELS sidebar item is badged when files are missing.
- Restore points: importing a config, settings or channel, applying a preset and relinking a folder each save a named backup first (SETTINGS › Backups).
- Shut down the PC from the box. SYSTEM › POWER has a new switch, off by default, that adds SHUT DOWN PC to the TV menu (desktop and TV mode) and a SHUT DOWN PC button to the companion remote. Both ask first, then count down 20 seconds on the screen and on the phone, with CANCEL on either. A second option makes the box’s own power-off (P, the remote’s power button, the TV menu) shut the computer down too; auto standby and the screen turning off never do.
- Steadier playback: Setup no longer lets a break or channel change start playing behind it, a paused or stalled picture resumes by itself, and a time-of-day block that crosses midnight (10 PM to 2 AM) with a day filter now follows the right day.
- Folders on a slow or sleeping drive: files that cannot be read yet are skipped and listed instead of being added as 3-minute videos, and a failed save keeps you in Setup with a message.
- Safer sharing: a phone or tablet paired to control the box now needs the pairing code again after 7 days, a guest on the viewer link can no longer see the companion app code, and a plugin that is off or waiting for approval stays completely inert. The Cast to TV plugin asks for approval again.

## 2026-10-18

- Volume leveler has a new CONSISTENT setting (PICTURE & SOUND › VOLUME). It levels every show and commercial to a slightly lower common volume, so quiet files are no longer stuck below loud ones when the master volume is high, loud ads are cut deeper, and a file is held back for the moment before its loudness is measured instead of blasting.

## 2026-10-17

- Channel presets: LIBRARY › PRESETS lists every preset (built in, from a plugin, or yours) with how much of your library fills it, and builds a channel from one in one undo step. A preset creator lets you make your own: slots of programs (kind, genre, era, series, tags), weekly or date-range blocks or a 24/7 loop, a slot of ads that play only on that channel, shuffle, and the artist / song card. Start from scratch, from an existing channel, from an imported file, or by customizing a built-in.
- Two new built-in presets: MUSIC VIDEOS (music videos around the clock, shuffled, with music ads and the artist and song shown on screen as each video starts and ends) and CHRISTMAS TV (only Christmas movies, specials and episodes, with Christmas ads in the breaks).
- A channel can show an artist / song card as each video starts and ends (the IDENTITY tab). It reads the artist and title the library tagged, or an “Artist - Title” filename.
- Auto-tagging now recognises music videos (artist and title from an “Artist - Title” name in a music folder), bumpers and commercials by their folder, and the specific holiday in a path (christmas, halloween, …) as a tag, plus more genres (sci-fi, western, fantasy, crime, game show, …). The library item editor gained Artist and Album.

## 2026-10-12

- First-run setup now has a CHOOSE HOW IT LOOKS page (page 2 of 3): FULL RETRO LOOK, GENTLE (no screen flicker or channel-change static) or MINIMAL (no CRT effect at all), with a note for people who are sensitive to flashing. You can change it later under Picture & Sound. The TV-mode setup wizard has the same choice (page 3 of 5).
- RerunTV is now in beta: releases are numbered 0.2.0-beta.N, and the update check follows them.
- Three plugins have new names (your settings, approvals and theme carry over on first launch): the music channel plugin (CH 910) is now Digital Music Channel and asks you to approve it once, the guide plugin is now Guide Channel, and the 1994 guide theme is now Scrolling Guide 94.
- A generated demo library (scripts/make-demo-library.js) lets anyone try the app with slow, soft test video and static and flicker already off, and the README has a photosensitivity notice listing the CRT effect, flicker and channel static switches.

## 2026-10-08

- Time machine: a scrub you have parked now holds still, so pressing Enter or T lands exactly where the picture was however long you waited. Picking a date on the calendar plays straight away with a note of where it landed, and T after a scrub no longer reloads the video.

## 2026-10-07

- Time machine calendar: press D (or TIME MACHINE › PICK A DATE… in the TV menu, or CALENDAR… in a channel's PREVIEW) to pick any date and time on a month grid. Days with a date-range block carry a dot, and the footer shows what would be airing there.
- Date-range blocks can repeat every year on their own: RESTART FROM ITS FIRST FILE EACH YEAR begins the playlist again at the start of each year's range, and STARTS ON THANKSGIVING follows the 4th Thursday of November.

## 2026-10-06

- Bumper text can count calendar days: DAY {dayNumber:12/1} OF 25 shows the day of a run that started Dec 1, and {daysLeft:12/25} counts down to Dec 25. Both stay blank outside the range.
- A channel can take individual videos as well as whole folders: ADD FILES in the channel's actions (or its ⋯ menu, or CONTENT › Folders) picks several at once, and files you add this way are listed there with their own REMOVE buttons.
- Audit fixes: the REPEAT / NEW EPISODE badge and other start-of-show corner cards no longer linger after a channel change or sit on top of a break; the sponsor message card no longer sticks on screen; the O-key layout editor now returns to the picture instead of Setup; the footer no longer sticks on SAVING…; release notes in HELP read as plain text.
- Setup polish: sentence-case helper text on a channel's LOOK page, tidier Sound rows, the No signal card lines up under Dynamic overlays, and the header search clears when you change tabs.
- The flow editor shows older bump-in/bump-out steps in its Bumper type list, the flow list updates its target channels as you edit, and the guide explains an empty channel search when upcoming programs still match.

## 2026-10-05

- The live overlay layout editor (O key) was rebuilt: a preview of the real picture, smart snapping to edges and other elements, undo/redo, and H to tuck the controls away into a clean view.
- The logo and corner badges keep their margin on letterboxed or pillarboxed pictures and stay on the picture instead of on black bars.
- Two audit rounds hardened the LAN viewer, plugin approvals, media limits and the personal PIN, and finished setup-screen validation and accessibility.

## 2026-10-04

- Remove baked-in black bars: finds letterbox bars inside the video itself and frames just the picture. New default logo size that scales to 1080p or 4K, reset-this-panel buttons, and a settings-only export/import.
- Remappable keys for live TV (SYSTEM › Keys), per-channel number chip, and a Guide & Theme page split into Guide, Theme and On-screen.
- Music channel: cover art, a CD-rack / record-crate cabinet and search by artist, song, album or year.
- Combiner now converts only the clips that differ, reports progress, and uses the GPU when re-encoding.

## 2026-09-29

- Simple and Advanced settings views: Simple shows everyday controls and search still finds everything; Advanced shows the lot.

## 2026-09-26

- The Video Splicer is built in (LIBRARY › SPLICER): cut recordings into episodes, ads and bumpers, then combine clips.
- Updates now keep your library, profiles and assets when the installer replaces the app folder.
- Digital Music: pause and seek on demand, and search the library by song, artist, album or year.

## 2026-09-23

- TV on a second screen: per-screen placement and fullscreen, TV mode per screen, a sound output picker, screen edges, follow the TV's power state, and volume levelling per file.

## 2026-09-13

- TV mode for a couch and remote: a TV menu, banner hub, remote test and learn mode, on-screen keyboard, game controllers, Tizen/webOS remotes and HDMI-CEC.
- Time machine scrubber strip with a Go to menu, guide program actions, shorts grouped in the guide, breaks drawn as a band, and call letters.
- SCHEDULE › ON AIR is an editable programming timeline with edit previews and an explanation of every layer.
- A media library with catalogue, review and smart channels; households, DVR and watching together; theme eras; a LAN control panel; and full undo/redo for every setting.

## 2026-08-24

- Unified the app typography around the original cable-guide face, with a separate readable face reserved for longer descriptions; fixed the downloaded-update notice so its copy and actions fit as a responsive card.
- Added five explicit update policies, including the new recommended pre-launch update flow, plus a two-step first-time setup that explains local-media privacy, autosave/backups, optional integrations, and the update choice.
- Channel Health can now relink a moved local media folder: it preserves the old relative layout, verifies the proposed replacement, previews unresolved files, and updates shared channel/schedule references as one undoable edit.
- Completed the feature audit: channel packages, Air Check, safe playback-order editing, guide-wide program search/reminders, backup comparison and pinned snapshots, per-channel broadcast identity, opt-in smart library sync, and redacted plugin diagnostics/support export.

## 2026-08-19

- Boot-time power-on animation (DISPLAY > PICTURE toggle, on by default) — the app now plays the same powering-on CRT flash the manual power button uses when it first lands on the TV screen, instead of cutting straight to live video. Wood-Grain Console, Late-Night UHF, and Digital Satellite each got their own period-appropriate version (sluggish tube warm-up, tearing signal, crisp digital snap).
- Fixed a real bug where an approved plugin's REVIEW & APPROVE PERMISSIONS button could keep showing (and the approval could silently be lost) after a restart — the approval write and the settings screen's own autosave were racing each other.
- PLUGINS tab: an approved plugin now shows a plain "Permissions approved" note instead of the approve button, with REVOKE PERMISSIONS and FULLY UNINSTALL actions next to it — uninstall opens its own themed confirm dialog since it permanently deletes the plugin's files.

## 2026-08-17

- Full undo/redo (Ctrl+Z / Ctrl+Shift+Z) for setup-screen edits, with toolbar buttons and a command palette (Ctrl+K) for jumping to any tab/sub-tab or running common actions.
- Keyboard-nav overhaul of the setup screen: arrow-key navigation between tabs/sub-tabs and between channel rows/interstitial cards, with Enter/Delete acting on the focused row.
- Drag video files straight from Explorer onto a channel row or the interstitials pool to add them, instead of only via CHOOSE/ADD FOLDER.
- App-wide QOL batch: save-state indicator, breadcrumb trail, session-resume for setup tabs, labeled backups, a migration notice, cross-channel search + NOW/NEXT dashboard, copy-channel-settings, drag-to-reorder channels, a combined health dashboard, and bulk bumper/ad preview.
- This HELP tab.

## 2026-08-16

- 4 new theme eras — Wood-Grain Console (1978), Late-Night UHF (1988), Network Prime Time (1996), Digital Satellite (2001) — each with its own channel-change transition, idle screensaver, synthesized sound (tune/power SFX + ambient texture), guide-grid look, and CRT picture bias, not just a recolor.
- Fixed a Shopping Network modal that could survive a channel change; fixed the PPV order button showing the wrong price; fixed a clipped bulk-title input.
- Virtual Channels settings panel is now collapsible with a filter instead of one long scroll of 17 cards.
- New "STRIP RELEASE TAGS" bulk button cleans up scene-release-style filenames in the Titles editor.
- Live CRT-effect preview swatch on the DISPLAY tab.

## 2026-08-09

- Bulk-tag by folder/selection with tag autocomplete, rotating config backups with restore, PREVIEW/test-tune (with block picker + quick-jump buttons), channel health check, SMPTE test pattern for unconfigured channels, episode countdown bumper placeholder.
- Interstitials/ad-preset UI redesigned into collapsible cards; settings sub-tabs added across DISPLAY/PROGRAMMING/AUDIO & SYSTEM; setup screen widened to use most of the window.

## 2026-08-05

- Channel EDIT view unified into one tabbed panel (Folders/Schedule/Titles/Ads/Logo); per-channel calendar with color-coded days, conflict detection, and inline day-override editing; blocks unified onto one trigger schema (day-of-week or date-range, with daily/weekly advent-calendar modes); tagged-interstitials pool replacing the old separate commercial/station-ID/trivia systems; per-channel/per-block volume and content-vs-ad volume layers.
