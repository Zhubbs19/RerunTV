// HELP tab: feature guide, shortcuts reference, changelog, release notes and
// the update settings panel. Split out of settings.js.
import { S, dispatch } from '../core/state.js';
import { escapeHtml, readableReleaseNotes } from '../core/util.js';
import { alertDialog } from './dialogs.js';
import { helpShortcutsGridEl, helpChangelogListEl, helpVersionEl, checkUpdatesBtn, updateModeSelect, updateStatusLineEl, updateSettingsPanelEl, helpReleaseNotesListEl, releaseNotesPanelEl, helpGuideListEl, helpGuideSearchEl, helpPrintManualBtn, hintBarEl } from '../core/dom.js';

// ---------- HELP tab: feature guide + shortcuts reference + changelog ----------
// The shortcuts grid is built from the hint bar's own spans (index.html)
// rather than a second hand-typed copy — one source of truth for "what do
// the keys do," so this can't drift out of sync with the real hint bar the
// way a duplicated list would the next time a shortcut changes. The guide
// below has no such live source to build from (it's explaining *why*/*how*,
// not reciting an existing list), so it's hand-written and needs updating by
// hand when a covered feature changes shape.
let helpTabRendered = false;

// Written to be read by an actual beginner, not a hobbyist who already knows
// what a "bumper pool" is — short sentences, plain everyday words, one idea
// per paragraph. Still uses numbered SECTIONs and NOTE:/TIP:/CAUTION:
// callouts (renderHelpGuide below bolds those words) since that structure
// genuinely helps scanning, but the prose itself should read like a friendly
// person explaining the app, not a 1980s owner's manual. `group` doubles as
// the SECTION heading shown above a run of same-group entries.
const HELP_GUIDE = [
  { group: 'SECTION 1 — WELCOME', title: 'Getting Started With This Guide', body: [
    'Welcome! This guide explains what everything in the setup screen does, organized by tab so it\'s easy to find what you need.',
    'TIP: Use the SEARCH THE GUIDE box above if you already know roughly what you\'re looking for — it searches both the topic titles and the text inside them.',
    'Don\'t feel like you need to read this all at once. Most people just build their first channel (see SECTION 2 below) and come back here later when they want to try something new.',
    'NOTE: RerunTV is in beta. If something looks wrong, check HELP › WHAT\'S NEW for recent changes, and report problems on the project\'s GitHub page.',
    'NOTE: RerunTV is vibe-coded: an AI coding agent wrote almost all of it under the direction of the project owner, and it has not had an independent code review or security audit. See the README on GitHub for details.',
  ] },
  { group: 'SECTION 2 — GETTING STARTED', title: '2.1 Setting Up Your First Channel', body: [
    'STEP 1: Go to the LINEUP tab and click "+ ADD CHANNEL". A new, empty channel will show up.',
    'STEP 2: Click "ADD FOLDER" and pick a folder of video files on your computer. The app scans it, figures out how long each video is, and builds a playlist for you automatically. A big folder might take a minute — that\'s normal.',
    'STEP 3: Want more than one folder on the same channel? Just repeat step 2. You could put cartoons and movies on the same channel, or keep them on separate channels — totally up to you.',
    'NOTE: You can rename a channel or change its number any time by clicking directly on its NAME or NUMBER in the list.',
    'TIP: Checking "SHUFFLE ORDER" mixes up the playback order once. It won\'t keep re-shuffling every time the channel loops — uncheck and recheck it whenever you want a new shuffle.',
    'STEP 4: When you\'re ready, click "START WATCHING" in the bottom-right corner to leave this screen and start watching. That\'s it!',
  ] },
  { group: 'SECTION 2 — GETTING STARTED', title: '2.2 Trying RerunTV Without Your Own Media', body: [
    'No library handy? Each release on GitHub has RerunTV-demo-library.zip, a gentle demo lineup of generated test video: slow soft colors, quiet tones, nothing copyrighted.',
    'STEP 1: Download the zip from the Releases page on GitHub and unzip it somewhere permanent. (Developers can generate the same thing with scripts/make-demo-library.js, which needs Node and ffmpeg.)',
    'STEP 2: In the LINEUP tab, click "+ ADD CHANNEL" for each folder it created, use "ADD FOLDER" to point the channel at it, then click "START WATCHING".',
    'TIP: The zip has a README.txt with these steps and suggested channel numbers.',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.1 Editing a Channel: Folders, Schedule, Titles, Ads, and Logo', body: [
    'Click "EDIT" on any channel to open its full settings. Its tabs are grouped under CONTENT (FOLDERS, TITLES, SCHEDULE), LOOK (LOGO, OVERLAYS, TICKER, IDENTITY) and PLAYBACK (ADS, CREDITS). The main ones:',
    'FOLDERS — add or remove which video folders feed this channel.',
    'SCHEDULE — set up a real broadcast-style schedule using PROGRAMMING BLOCKS, plus a CALENDAR for marking special dates.',
    'TITLES — rename individual shows, or automatically pull in a poster and description for each one.',
    'ADS — control how often commercial breaks happen on this channel.',
    'LOGO — show a small logo in the corner of the screen while this channel is playing, like a real TV network watermark.',
    'NOTE: If you don\'t set up any BLOCKS, the channel just plays through its whole library on a loop. Blocks are completely optional — only bother with them once you want an actual schedule, like "cartoons in the morning, movies at night."',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.2 Programming Blocks and the Calendar', body: [
    'A PROGRAMMING BLOCK is just a time slot with its own lineup — for example, "cartoons, weekdays, 4–6 PM." You can trigger a block two ways: by day of the week and time (repeats every week), or by a specific date range (great for holidays or a limited-time marathon).',
    'TIP: Turn on WEEKLY ROTATION on a block if you want its lineup to change from week to week instead of repeating the exact same shows every time.',
    'ON AIR (the first view in SCHEDULE) shows the week this channel will actually broadcast, with every show, ad break and sign-off after blocks, calendar days, presets and flows are all applied. Click any program to see which block or preset produced it, the breaks inside it, and a WATCH FROM HERE button.',
    'The CALENDAR (same tab as SCHEDULE) shows you a full month at once, color-coded by what\'s playing each day. It automatically flags anything that conflicts, and you can override a single day without messing up your regular schedule.',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.3 Previewing, Fixing Problems, and Editing Multiple Channels', body: [
    'PREVIEW (on every channel row) shows you what that channel would look like at any date and time, right in the setup screen — no need to actually tune to it. Use the quick-jump buttons to skip to the start of a show, the next ad break, an hour later, and so on.',
    'CAUTION: If you move, rename, or delete video files outside the app, the channel won\'t know where they went. Click "CHECK CHANNELS" to scan for anything missing, and "FIX PLAYBACK" to relink or remove those files.',
    'Need to change something on a bunch of channels at once — like favoriting several, or bulk-deleting? Ctrl+click channels in the list to pick several (Shift+click picks a range, Ctrl+A picks them all) and the editor turns into bulk actions for the selection. Esc goes back to one channel.',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.4 Playback Order, Channel Packages, and Broadcast Identity', body: [
    'The TITLES editor can sort naturally, reverse, restore folder order, create a repeatable seeded shuffle, or accept drag-and-drop ordering. Every automatic reorder previews the change and asks before it re-anchors the live channel.',
    'EXPORT CHANNEL creates a portable package containing that channel and the programming resources it directly uses. IMPORT CHANNEL merges one into your current box, remaps conflicting channel/resource numbers, and can relink missing local folders without replacing unrelated settings.',
    'IDENTITY lets one channel override the box theme, tune sound, static style, and accent colors. Leave any choice on INHERIT to keep following the box-wide theme.',
  ] },
  { group: 'SECTION 3 — CHANNELS', title: '3.5 Sub-Channels (7.1, 7.2)', body: [
    'Off by default. Most lineups are whole numbers all the way through, and there is no reason to put decimal points in front of everyone who does not want them.',
    'Switch on ALLOW SUB-CHANNELS at the bottom of the LINEUP tab and a channel number can then carry one decimal place, so you can run 7.1 and 7.2 alongside 7 the way a digital broadcast station carries sub-channels. Type the number into a channel\'s number box as 7.1.',
    'To tune one from the remote, type the main number, press the period key, then the sub-channel digit: 7 . 1. Everything else treats it as an ordinary channel — it sorts straight after 7, appears in the guide, takes blocks and breaks, and can be marked as a favorite.',
    'Only one decimal place is allowed. 7.1 is a channel, 7.12 is not.',
    'NOTE: with the option on, the up/down arrows in a number box step in tenths rather than whole numbers — that is the trade, and why it is off unless you ask for it. Switching it back off later does not break a sub-channel you already made: it stays in the lineup, in the guide and tunable. The option only controls whether you can type a new one.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.1 The Bumper & Ad Pool', body: [
    'This is the shared library of everything that plays between shows — commercials, station IDs, "up next" bumpers, trivia cards. Each item is tagged with which channels or blocks it belongs to, so ad breaks automatically pull from the right ones.',
    'STEP 1: Click "+ ADD FOLDER" to bring in a whole folder of commercials at once, or "+ ADD ENTRY" to add one by hand — you can even make a text-only station ID with no video file needed.',
    'The GLOBAL DEFAULT AD CADENCE sets how often breaks happen for any channel that hasn\'t set its own. Drag directly on the timeline, or type in exact break points.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.2 Ad Presets and the Show & Ad Flow Builder', body: [
    'CADENCE & PRESETS lets you save a break pattern and apply it to anything with a matching tag, instead of picking one channel at a time — handy if you want every "sitcom"-tagged show to break the same way.',
    'ADVANCED FLOWS is a visual builder for the rare channel that needs an exact order of segments, bumpers, ad pods, and IDs instead of the usual automatic cadence.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.3 On-Screen Extras', body: [
    'TEXT TICKER scrolls a message along the bottom of the screen, like a news channel.',
    'The Emergency Alert System and Breaking News Alerts have their own settings — look for SETTINGS next to each one in the PLUG-INS tab. EAS runs a periodic test alert (or press E to trigger one now); Breaking News interrupts with a styled bulletin, either automatically or on demand with the B key.',
    'NOTE: Press I any time to see details about what\'s currently playing. Press T to open the TIME MACHINE and jump the schedule backward or forward.',
  ] },
  { group: 'SECTION 4 — THE PROGRAMMING TAB', title: '4.4 Air Check', body: [
    'AIR CHECK is the broadcast resolver console. Pick a channel and time to see which source, show position, schedule block, ad policy, and output RerunTV resolves, plus why that result won. Previous/next boundary buttons make timing problems easier to isolate.',
    'The pool inspector shows which bumper and ad entries are eligible. FORCE ON TV previews one selected entry without rewriting the real schedule.',
  ] },
  { group: 'SECTION 5 — PICTURE & SOUND, GUIDE & THEME', title: '5.1 Picture Adjustments and the CRT Look', body: [
    'The CRT sliders — SCANLINES, VIGNETTE, GRAIN, FLICKER, CURVATURE, and BURN-IN — recreate the look of an old TV screen. Watch the preview update live as you drag each one.',
    'COMFORT AND PHOTOSENSITIVITY: some of these effects flicker or flash: the FLICKER slider, the CHANNEL STATIC burst when you change channel, the power on and off animations, and the optional signal-glitch, breaking-news and emergency-alert overlays. If you are sensitive to flashing lights or patterns, set FLICKER to 0, turn CHANNEL STATIC off, press C to switch the CRT effect off entirely, and turn the glitch and alert plugins off in the PLUG-INS tab. The first-run setup also offers this as a choice between FULL RETRO LOOK, GENTLE and MINIMAL. The pictures themselves come from your own media, which RerunTV can\'t change.',
    'This is general guidance, not medical advice. If you ever feel unwell while watching, stop and take a break.',
    'Press V any time to cycle through picture-color presets (P is POWER), or press A to cycle how the picture fits the screen: STANDARD (safe letterboxing, with a border for non-widescreen content if your theme has one), STRETCH (deliberately distorted, like squeezing a widescreen picture onto an old TV), and FILL (zooms in to fill the whole screen, cropping the edges).',
  ] },
  { group: 'SECTION 5 — PICTURE & SOUND, GUIDE & THEME', title: '5.2 Themes and the Channel Logo', body: [
    'GUIDE THEME (INTERFACE sub-tab, CLOCK & GUIDE panel) changes the whole look and feel of your box in one click — the channel-change animation, the idle screensaver, the sound effects, the on-screen guide, and the picture\'s color, all at once, not just a color swap.',
    'CHANNEL LOGO shows a small logo in a corner of the screen while you\'re watching. TIP: Leave it in the same spot long enough and it develops a faint "burn-in" ghost, just like a real old TV — that\'s intentional, not a bug.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.1 Volume Controls', body: [
    'The box has two separate volume levels — CONTENT (your shows) and COMMERCIAL/BUMPER — both set as a percentage you can adjust live with the +/- keys. Turn up the commercial volume if your ads always sound quiet, or down if they blast.',
    'NOTE: Any individual channel or block can set its own volume, which always overrides the two sliders above.',
    'VINTAGE CRT AUDIO FILTER & SFX softens the sound a bit and can add a faint hum and mechanical click sounds, for that old-TV-speaker feel.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.2 The Companion App (Phone Browser Page)', body: [
    'Enable COMPANION APP LAN ACCESS (REMOTE + SETTINGS + FILES) in the Companion App plugin, save, and restart. Its pairing link opens a full remote in any browser on the same WiFi; the short code is exchanged for a private session before controls or channel data are available.',
    'NOTE: This only works on your home WiFi, not over cellular data or from outside the house.',
    'TIP: If the remote page won\'t load, double check your phone is on the exact same WiFi network as the box (not a guest network) — that\'s the most common issue.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.3 Watching on Other Screens (The LAN Viewer)', body: [
    'WATCH ON OTHER DEVICES is off by default. Enable it, save, and restart, then open its pairing link on a laptop, tablet, or second TV. The viewer receives schedule data and opaque media ids, never host filesystem paths.',
    'NOTE: Each paired viewer is an independent read-only instance of the channel lineup and can tune locally without changing the main box.',
    'There\'s also an early Android TV app included in this project for a proper big-screen version of the same viewer, if you\'re comfortable building it yourself.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.4 The Party Page (Guest Bulletin & Jukebox)', body: [
    'When the PARTY channel (see SECTION 7) is enabled and RerunTV restarted, it shows a pairing QR code for the guest page. Guests need no account, but must use that host-issued link before posting or controlling party features.',
    'From that page, a guest can: post a photo or short video to the screen, send a text-to-speech announcement, play a sound effect, join a trivia round, submit a caption contest entry, vote for what plays next, check in on the guest wall, and — if the jukebox is turned on — add or vote to skip a song.',
    'TIP: The QR code shows right on screen whenever the PARTY channel is idle, so guests can just scan it — no need to read a URL out loud over the music.',
    'NOTE: Anything posted from the party page only lasts for that session — it\'s not saved permanently, and clears out the next time the box restarts.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.5 The Android Companion App and Connected Devices', body: [
    'There\'s also a separate Android app (different from the browser remote above) with quick-tap favorite channels you set up yourself, plus the same core remote controls — a faster option if you\'re often using just one hand.',
    'CONNECTED DEVICES shows every remote, viewer, and party guest currently active on your network. NOTE: A device drops off this list about 30 seconds after it stops checking in — think of it as "who\'s active right now," not a permanent list.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.6 Backing Up Your Settings', body: [
    'CAUTION: Your settings are backed up automatically on a rotating basis, and you can also click "snapshot now" any time for a manual backup. If something ever goes wrong, click "RESTORE" next to any backup to roll back to it — and if that wasn\'t what you wanted, Ctrl+Z undoes even that (see SECTION 8).',
    'TIP: Give an important backup a LABEL (like "before reorganizing cartoons") and PIN it so automatic rotation never removes it. PREVIEW shows channel, title-count, schedule, and box-setting differences before you restore.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.7 Opt-In Library Synchronization', body: [
    'LIBRARY SYNC is off by default. When enabled, it checks only the folders already linked to your channels, either after startup or at your chosen interval, and adds new titles automatically.',
    'Likely renames preserve your title, tags, and other metadata only when the match is unambiguous. Missing titles are reported but kept by default; automatic removal is a separate warned option you must explicitly enable.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.8 Staying On Schedule and Staying Awake', body: [
    'Two settings in SYSTEM › POWER keep a long unattended session honest.',
    'KEEP THE DISPLAY AWAKE holds off your monitor\'s screensaver and sleep timer while the set is powered on. Playing video normally keeps a screen up by itself, but a plugin channel, a NO SIGNAL card, or an open guide is a still picture as far as your computer is concerned. Powering the set off, including into AUTO STANDBY, releases it again immediately.',
    'KEEP PLAYBACK IN SYNC re-checks every 20 seconds that the picture is still at the point the schedule says it should be, and eases it back if it has fallen behind. This matters most after the computer sleeps and wakes, when the wall clock has moved on but the video has not. It also covers a file that stalls long enough to lose its place.',
    'NOTE: Turn the sync option off if your media lives somewhere slow enough that you would rather sit through an occasional stall than be moved past it. Everything else about the schedule is unaffected either way.',
  ] },
  { group: 'SECTION 6 — HOUSEHOLD, LIBRARY & SYSTEM', title: '6.9 Updates and Beta Releases', body: [
    'RerunTV is in beta, and releases are numbered like 0.2.0-beta.7: the first part is the version, and the number after beta only goes up, so a higher one is always newer.',
    'In SYSTEM, the UPDATE POLICY setting decides when updates happen: BEFORE APP OPENS — INSTALL AUTOMATICALLY, AFTER APP OPENS — INSTALL WHEN I QUIT, AFTER APP OPENS — ASK WHEN READY, ONLY WHEN I ASK, or NEVER. CHECK NOW looks for a newer build right away, and HELP › WHAT\'S NEW lists what changed.',
    'Your channels and settings live in the userData folder next to the app, and a backup is taken before an update installs, so an update keeps your lineup.',
    'NOTE: Beta installers are not code-signed, so Windows SmartScreen may warn the first time you run one. Choose "More info" and then "Run anyway" if you downloaded it from the project\'s own GitHub releases page.',
  ] },
  { group: 'SECTION 7 — SPECIAL & VIRTUAL CHANNELS', title: '7.1 The Built-In Channels', body: [
    'Alongside your own channels, the box comes with a few special built-in ones — a program guide, a community bulletin board, a weather channel, a party channel, and more. Each one is its own plugin, and you can turn any of them on or off from the PLUG-INS tab, even the ones that come on by default.',
    'CH1 PREVIEW GUIDE is a scrolling program guide, like an old cable listings channel. CH2 PUBLIC ACCESS shows rotating community bulletin slides.',
    'CH0 AUX/VIDEO IN acts like a "line in" — it can even capture a window or app running on this same computer (like a karaoke app). CH3 WEATHER shows current conditions for your area.',
    'CH94 PARTY (see SECTION 6.4) is the interactive guest channel with photos, trivia, voting, and more.',
    'A few higher channel numbers (51, 88, and 94–99) are used for fun extras — a fake late-night channel, a game channel, shopping-channel parodies, a music visualizer, a pay-per-view screen, and a teletext channel. Each is its own plugin too, and any of them will automatically step aside if you already have a real channel using that number.',
    'CH910 DIGITAL MUSIC CHANNEL plays genre "stations" from your own music folders, styled like a digital-cable music service, with on-demand pause and seek and a search by song, artist, album or year. Set up its stations in the PLUG-INS tab. It asks for permission to read your music folders the first time.',
  ] },
  { group: 'SECTION 7 — SPECIAL & VIRTUAL CHANNELS', title: '7.2 CH 100 — The Channel Mosaic', body: [
    'CH 100 is a preview mosaic: a grid showing what is airing on every one of your other channels right now, paging through the lineup a screenful at a time.',
    'Each tile is a still frame taken from that channel\'s current position, not a live picture. That is deliberate — a wall of moving video would cost far more than the whole rest of the box put together, and a real cable mosaic was a page of near-stills too.',
    'Tiles per page, how long a page stays up, and how often the frames refresh are all on the PLUG-INS tab under Channel Mosaic. If a big lineup makes the page stutter, lower the tile count first; it matters more than the refresh rate.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.1 Undo, Redo, the Command Palette, and Keyboard Shortcuts', body: [
    'Made a mistake? Press Ctrl+Z to undo your last change, and Ctrl+Shift+Z (or Ctrl+Y) to redo it. There are also UNDO/REDO buttons at the bottom of the screen — they gray out automatically when there\'s nothing to undo or redo.',
    'NOTE: Regular watching — changing the channel, adjusting volume, switching picture mode — doesn\'t count as a "setting" and won\'t show up in this undo history.',
    'Press Ctrl+K, or the SEARCH button, to search everything on this screen — settings, channels, upcoming programs, and actions like adding a channel or exporting your settings.',
    'TIP: You can also get around this whole screen with just the keyboard. Arrow keys (or J and K) move between sections and list rows, Enter selects a row and Enter again moves into its editor, Esc goes back to the list, Delete removes, and Ctrl+Enter starts watching.',
    'Press G and then a letter to jump to a section: C Channels, P Programming, L Library, S Picture & Sound, G Guide & Theme, H Household, Y System, U Plug-ins, ? Help.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.2 Searching the Guide and Reminders', body: [
    'Type at least two letters in the full guide search to find matching program titles, descriptions, or tags across the next seven days. Choose a result to jump the guide to it.',
    'SET REMINDER creates a local reminder. When the viewing clock reaches the program, a toast offers TUNE NOW or DISMISS; reminders follow the time-machine clock just like the schedule itself.',
    'Everything you have pending is listed under PROGRAM REMINDERS in GUIDE & THEME. Remove one you set by mistake, or clear the lot. Each reminder tidies itself up a few minutes after its program ends.',
    'Two options live with that list. TUNE AUTOMATICALLY changes the channel for you the moment a reminder comes due. The desktop-notification option covers the case this box is built for — still broadcasting behind whatever you are actually working in, where an on-screen toast is invisible. It only fires when the RerunTV window is not the one you are looking at.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.3 Air Checks — Marking a Moment', body: [
    'Press X while watching, or pick MARK AIR CHECK from the TV menu, and the box remembers exactly where you were: which channel, and what moment of its schedule was on screen.',
    'To go back, open the TV menu and choose one of the AIR CHECK entries listed there. The viewing clock shifts to that instant and the channel tunes, so the programme picks up exactly where it was.',
    'Nothing is recorded and nothing is copied. Because a channel plays the same thing at the same time no matter when you ask, a channel number and a timestamp already describe the moment completely. A mark costs a few dozen bytes.',
    'CAUTION: re-scanning a channel\'s folder or changing its playback order re-anchors that channel. Marks made before that will land on whatever airs at that time afterwards, which may be something else. The full list, with a REMOVE button on each, is under SYSTEM › AIR CHECK.',
  ] },
  { group: 'SECTION 8 — OPERATING THIS SETUP SCREEN', title: '8.4 Channel Scan and the Viewing Log', body: [
    'Press N to start SCAN. The box holds on each channel for about eight seconds and then moves on, showing the channel banner as it goes, exactly like the SCAN button on an old cable box. Pressing any key stops it on whatever is on screen.',
    'SYSTEM › DIAGNOSTICS keeps a VIEWING HISTORY: one row for each programme that actually reached the screen, with an estimated watch time and your most-watched channel and programme.',
    'That log lives in its own file, separate from your channel configuration. It is never included in a config backup or export, which also means CLEAR HISTORY cannot be undone by restoring a backup. Turn the whole thing off with the checkbox on that panel if you would rather nothing were logged.',
  ] },
  { group: 'SECTION 9 — THE PLUG-INS TAB', title: '9.1 Installing, Turning On/Off, and Removing Plugins', body: [
    'A lot of what this box can do — every special channel from SECTION 7, the remote control, weather and show-info lookups, even audio streaming features that need extra processing behind the scenes — comes from individual PLUGINS, listed on the PLUG-INS tab. Some come built in and turned on by default; you can add more yourself.',
    'STEP 1: To add one, either click "INSTALL FROM ZIP…" and pick the file, or drop its folder into the plugins folder (click "OPEN PLUGINS FOLDER" to find it) and click "RESCAN".',
    'Use the checkbox next to each plugin to turn it on or off, then click "SAVE CHANGES". Like most changes on this tab, turning a plugin on/off or adding a new one only takes effect after you restart the app.',
    'NOTE: To remove a plugin you installed yourself, delete its folder from the plugins folder ("OPEN PLUGINS FOLDER") and click RESCAN. Plugins that came built in are different — if a future app update removes one, it cleans up after itself automatically the next time you restart. You don\'t need to do anything.',
  ] },
  { group: 'SECTION 9 — THE PLUG-INS TAB', title: '9.2 What a Plugin Is Allowed to Do', body: [
    'Some plugins need extra permissions — to talk to the internet, open another program, or run their own little web page. Each plugin lists exactly which of these it needs and why, right in the PLUG-INS tab. The first time you use a plugin like this (or after an update adds a new permission), you\'ll see a prompt to approve it before it can run.',
    'CAUTION: Only install plugins from sources you trust. Approving a permission limits what a plugin is allowed to do — it doesn\'t guarantee the plugin only does good things with the access you give it.',
    'If a plugin asks for approval again after an update, its permissions changed or it was renamed. Review the list and approve it again to keep using it.',
    'Many plugins also run in their own separate, walled-off space instead of sharing the app\'s own — similar to how each tab in a web browser runs separately. That way, if one plugin crashes or misbehaves, it can\'t take the rest of the box down with it, and it\'s genuinely limited by your computer to only what it asked permission for.',
  ] },
  { group: 'SECTION 9 — THE PLUG-INS TAB', title: '9.3 Developer Diagnostics and Support Bundles', body: [
    'PLUGIN DEVELOPER DIAGNOSTICS shows main and renderer load state, registered extension points, declared capability activity, published services, recent bounded logs, and whether a restart is still needed.',
    'EXPORT REDACTED SUPPORT BUNDLE writes that snapshot as JSON. Credential-shaped fields, authorization strings, URL credentials, and user-specific filesystem roots are removed first; your channel configuration and media inventory are not included.',
  ] },
];

function guideMatchesQuery(entry, q) {
  if (!q) return true;
  const haystack = `${entry.group} ${entry.title} ${entry.body.join(' ')}`.toLowerCase();
  return haystack.includes(q);
}

function renderHelpGuide() {
  if (!helpGuideListEl) return;
  const q = (helpGuideSearchEl && helpGuideSearchEl.value.trim().toLowerCase()) || '';
  helpGuideListEl.innerHTML = '';
  const matches = HELP_GUIDE.filter((entry) => guideMatchesQuery(entry, q));
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO GUIDE TOPICS MATCH THAT SEARCH.';
    helpGuideListEl.appendChild(empty);
    return;
  }
  let lastGroup = null;
  matches.forEach((entry, i) => {
    if (entry.group !== lastGroup) {
      lastGroup = entry.group;
      const groupHeader = document.createElement('div');
      groupHeader.className = 'help-guide-group-header';
      groupHeader.textContent = entry.group;
      helpGuideListEl.appendChild(groupHeader);
    }

    const card = document.createElement('div');
    // Expanded by default while a search is narrowing things down (so a
    // match's own text is immediately visible, not hidden behind another
    // click), and for the very first topic otherwise — everything else
    // starts collapsed so the guide reads as a scannable table of contents
    // rather than one long wall of text.
    const open = !!q || i === 0;
    card.className = 'help-guide-card' + (open ? ' open' : '');

    // A plain div with role="button" here, not a real <button> — a real
    // <button> given `display: flex` collapsed to ~8px regardless of its
    // content (its flex-computed height never made it into the parent
    // div's auto-height calculation, a Blink quirk specific to form
    // controls with an overridden display), so its content painted outside
    // the card's own overflow:hidden clip and never showed on screen.
    // Every other custom clickable header in this codebase (e.g.
    // .interstitial-card-summary) already uses a div for exactly this
    // reason — tabIndex + a keydown handler restore the button-like
    // keyboard activation a real <button> would give for free.
    const header = document.createElement('div');
    header.className = 'help-guide-card-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(open));
    header.tabIndex = 0;
    const chevron = document.createElement('span');
    chevron.className = 'help-guide-chevron';
    chevron.textContent = open ? '▾' : '▸';
    const title = document.createElement('span');
    title.textContent = entry.title;
    header.appendChild(chevron);
    header.appendChild(title);
    const toggle = () => {
      const nowOpen = card.classList.toggle('open');
      chevron.textContent = nowOpen ? '▾' : '▸';
      header.setAttribute('aria-expanded', String(nowOpen));
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'help-guide-card-body';
    entry.body.forEach((para) => {
      const p = document.createElement('p');
      // A paragraph opening with one of the manual's own callout words —
      // STEP 1:, NOTE:, TIP:, CAUTION: — gets that lead-in word bolded and
      // set off, the way a real manual's marginal callouts read, instead of
      // just running straight into the sentence like the rest of the prose.
      const calloutMatch = para.match(/^((?:STEP \d+|NOTE|TIP|CAUTION):)\s*/);
      if (calloutMatch) {
        const strong = document.createElement('strong');
        strong.className = 'manual-callout';
        strong.textContent = calloutMatch[1];
        p.appendChild(strong);
        p.appendChild(document.createTextNode(' ' + para.slice(calloutMatch[0].length)));
      } else {
        p.textContent = para;
      }
      body.appendChild(p);
    });
    card.appendChild(body);

    helpGuideListEl.appendChild(card);
  });
}

if (helpGuideSearchEl) helpGuideSearchEl.addEventListener('input', renderHelpGuide);

// Renders the same manual-voice callout ("STEP 1:", "NOTE:", "TIP:",
// "CAUTION:") that renderHelpGuide bolds on screen, so the printed page
// keeps that visual distinction too instead of reading as flat prose.
function paraToHtml(para) {
  const calloutMatch = para.match(/^((?:STEP \d+|NOTE|TIP|CAUTION):)\s*/);
  if (!calloutMatch) return `<p>${escapeHtml(para)}</p>`;
  const label = escapeHtml(calloutMatch[1]);
  const rest = escapeHtml(para.slice(calloutMatch[0].length));
  let kind = 'step';
  if (/CAUTION/.test(label)) kind = 'caution';
  else if (/TIP/.test(label)) kind = 'tip';
  else if (/NOTE/.test(label)) kind = 'note';
  return `<p class="callout callout-${kind}"><strong>${label}</strong> ${rest}</p>`;
}

// Builds a complete, self-contained (inline CSS, no external assets) HTML
// document styled like the perfect-bound owner's manual that used to ship
// taped inside a real cable box — reuses HELP_GUIDE verbatim rather than
// keeping a second hand-written copy of the same instructions, so the
// on-screen guide and the printable one can never drift out of sync with
// each other. Handed to window.api.openPrintableManual (main.js writes it
// to a temp file and opens it with the OS's default browser, since a
// sandboxed renderer can't write files or reliably open a real
// window.open() window itself) rather than rendered inside this app's own
// window, so Ctrl+P / the browser's own print dialog works normally.
function buildPrintableManualHtml() {
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  let sectionsHtml = '';
  let lastGroup = null;
  let tocHtml = '';
  HELP_GUIDE.forEach((entry) => {
    if (entry.group !== lastGroup) {
      lastGroup = entry.group;
      sectionsHtml += `<h2>${escapeHtml(entry.group)}</h2>`;
      tocHtml += `<li>${escapeHtml(entry.group)}</li>`;
    }
    sectionsHtml += `<div class="topic"><h3>${escapeHtml(entry.title)}</h3>${entry.body.map(paraToHtml).join('')}</div>`;
  });

  // Palette pulled from this app's own indigo/gold theme (tokens.css's
  // default digital-2000s vars) rather than literal antique sepia paper —
  // the manual VOICE stays retro (SECTION numbering, STEP/NOTE/TIP/CAUTION
  // callouts, "congratulations on your new..." framing), but the visual
  // design is a clean, modern print layout: a sans display face for
  // headings, generous whitespace, a two-column grid TOC, and rounded
  // color-coded callout cards instead of parchment-and-serif pastiche.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RerunTV — Owner's Manual</title>
<style>
  @page { margin: 0.75in; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    color: #1b1f3b;
    background: #f3f4fb;
    max-width: 7.6in;
    margin: 0 auto;
    padding: 48px 28px 90px;
    line-height: 1.55;
    font-size: 13px;
  }
  .cover {
    text-align: center;
    padding: 56px 32px;
    margin-bottom: 40px;
    border-radius: 20px;
    background: linear-gradient(160deg, #292f6b 0%, #4147a3 55%, #6a6fd6 100%);
    color: #fff;
  }
  .cover .badge {
    display: inline-block;
    font-size: 28px;
    width: 60px; height: 60px; line-height: 60px;
    border-radius: 50%;
    background: rgba(255,255,255,0.15);
    margin-bottom: 16px;
  }
  .cover .eyebrow { letter-spacing: 4px; font-size: 11px; opacity: 0.75; text-transform: uppercase; font-weight: 600; }
  .cover h1 { font-size: 38px; letter-spacing: 1px; margin: 10px 0 6px; font-weight: 800; }
  .cover .subtitle { font-size: 14px; opacity: 0.85; margin-bottom: 18px; }
  .cover .model-line {
    display: inline-block;
    font-size: 11px; letter-spacing: 0.5px; font-weight: 600;
    background: rgba(255,255,255,0.14);
    padding: 6px 14px;
    border-radius: 999px;
  }
  .toc {
    background: #fff;
    border: 1px solid #dcdff2;
    border-radius: 14px;
    padding: 22px 26px;
    margin-bottom: 40px;
    box-shadow: 0 1px 3px rgba(30,35,90,0.06);
  }
  .toc h2 { margin: 0 0 12px; font-size: 12px; letter-spacing: 2px; color: #4147a3; text-transform: uppercase; border: none; padding: 0; }
  .toc ul { columns: 2; gap: 28px; padding-left: 18px; font-size: 12.5px; color: #3a3f5c; }
  .toc li { margin-bottom: 4px; break-inside: avoid; }
  h2 {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #4147a3;
    border-bottom: 2px solid #dcdff2;
    padding-bottom: 8px;
    margin-top: 40px;
    page-break-after: avoid;
  }
  .topic {
    page-break-inside: avoid;
    margin: 16px 0;
    padding: 16px 18px;
    background: #fff;
    border: 1px solid #e4e6f4;
    border-radius: 12px;
  }
  .topic h3 { font-size: 14px; margin: 0 0 8px; color: #1b1f3b; font-weight: 700; }
  .topic p { margin: 8px 0; font-size: 12.5px; color: #3a3f5c; }
  .callout {
    border-radius: 8px;
    border-left: 4px solid #6a6fd6;
    padding: 8px 14px;
    background: #f3f4fb;
    margin: 10px 0 !important;
  }
  .callout strong { color: #4147a3; }
  .callout-caution { border-left-color: #d64550; background: #fdf2f3; }
  .callout-caution strong { color: #b3313b; }
  .callout-tip { border-left-color: #2fa36a; background: #f1f9f4; }
  .callout-tip strong { color: #23825a; }
  footer {
    margin-top: 56px;
    padding-top: 18px;
    border-top: 1px solid #dcdff2;
    font-size: 10.5px;
    color: #6b70a0;
    text-align: center;
  }
  @media print {
    body { background: #fff; }
    .cover { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .toc { break-after: page; }
    .topic { box-shadow: none; }
  }
</style>
</head>
<body>
  <div class="cover">
    <div class="badge">&#128250;</div>
    <div class="eyebrow">Owner's Manual</div>
    <h1>RerunTV</h1>
    <div class="subtitle">Channel Setup &amp; Programming System</div>
    <div class="model-line">MODEL: SYSTEM CONFIG REV 1.0 &nbsp;·&nbsp; PRINTED ${escapeHtml(today)}</div>
  </div>
  <div class="toc">
    <h2>Table of Contents</h2>
    <ul>${tocHtml}</ul>
  </div>
  ${sectionsHtml}
  <footer>Please retain this manual for future reference. Ctrl+P (or your browser's Print command) to print or save as PDF.</footer>
</body></html>`;
}

if (helpPrintManualBtn) {
  helpPrintManualBtn.addEventListener('click', async () => {
    try {
      await window.api.openPrintableManual(buildPrintableManualHtml());
    } catch (e) {
      alertDialog(`Couldn't open the printable manual: ${e.message}`, { variant: 'error' });
    }
  });
}

const CHANGELOG = [
  { date: '2026-10-29', items: [
    'Plugins you install yourself now work in a release build: a plugin talks to its own background code through one shared, checked route instead of needing its own entry built into the app.',
    'Plugin permissions in plain words: the approval prompt and each plugin’s page say where it runs, which sites, files, programs and ports it can use, and whether it is sandboxed (a plugin that is not gets a red APPROVE FULL ACCESS button). A plugin can list the sites it connects to, and a sandboxed one is held to that list. Each plugin’s page also shows what it has done since start: calls, refused calls, sites reached and sites blocked.',
    'Companion app on Android: the app now reaches the box over your home network (it could not before in installed builds), and SCAN QR CODE reads the pairing QR on the Companion App panel. A failed connection or scan now says what was tried and why it failed.',
  ] },
  { date: '2026-10-22', items: [
    'Skip a commercial break with Q (the blue button on a remote, SKIP BREAK on the phone). The show comes back where it left off.',
    'The sleep timer now shows a SLEEP m:ss countdown over the picture for its last five minutes, and the phone remote shows it too, along with how long the current show has left and what is next.',
    'The I details card also says why the show is on: the block or lineup that picked it and the ad flow behind its breaks.',
    'The guide has a channel view button next to search: ALL CHANNELS, FAVORITES, or channels you have not watched in 14 days.',
    'When the box starts after a long time away, a short card says how long it was off and lists your next reminders.',
    'Setup: DUPLICATE, RUNNING BEHIND… copies a channel shifted by some hours (a second copy of a channel that is never on the same episode); the multi-select bar can hide channels from tuning and shift their schedules, with a count of the programs that will move. The CHANNELS sidebar item is badged when files are missing.',
    'Restore points: importing a config, settings or channel, applying a preset and relinking a folder each save a named backup first (SETTINGS › Backups).',
    'Shut down the PC from the box. SYSTEM › POWER has a new switch, off by default, that adds SHUT DOWN PC to the TV menu (desktop and TV mode) and a SHUT DOWN PC button to the companion remote. Both ask first, then count down 20 seconds on the screen and on the phone, with CANCEL on either. A second option makes the box’s own power-off (P, the remote’s power button, the TV menu) shut the computer down too; auto standby and the screen turning off never do.',
    'Steadier playback: Setup no longer lets a break or channel change start playing behind it, a paused or stalled picture resumes by itself, and a time-of-day block that crosses midnight (10 PM to 2 AM) with a day filter now follows the right day.',
    'Folders on a slow or sleeping drive: files that cannot be read yet are skipped and listed instead of being added as 3-minute videos, and a failed save keeps you in Setup with a message.',
    'Safer sharing: a phone or tablet paired to control the box now needs the pairing code again after 7 days, a guest on the viewer link can no longer see the companion app code, and a plugin that is off or waiting for approval stays completely inert. The Cast to TV plugin asks for approval again.',
  ] },
  { date: '2026-10-18', items: [
    'Volume leveler has a new CONSISTENT setting (PICTURE & SOUND › VOLUME). It levels every show and commercial to a slightly lower common volume, so quiet files are no longer stuck below loud ones when the master volume is high, loud ads are cut deeper, and a file is held back for the moment before its loudness is measured instead of blasting.',
  ] },
  { date: '2026-10-17', items: [
    'Channel presets: LIBRARY › PRESETS lists every preset (built in, from a plugin, or yours) with how much of your library fills it, and builds a channel from one in one undo step. A preset creator lets you make your own: slots of programs (kind, genre, era, series, tags), weekly or date-range blocks or a 24/7 loop, a slot of ads that play only on that channel, shuffle, and the artist / song card. Start from scratch, from an existing channel, from an imported file, or by customizing a built-in.',
    'Two new built-in presets: MUSIC VIDEOS (music videos around the clock, shuffled, with music ads and the artist and song shown on screen as each video starts and ends) and CHRISTMAS TV (only Christmas movies, specials and episodes, with Christmas ads in the breaks).',
    'A channel can show an artist / song card as each video starts and ends (the IDENTITY tab). It reads the artist and title the library tagged, or an “Artist - Title” filename.',
    'Auto-tagging now recognises music videos (artist and title from an “Artist - Title” name in a music folder), bumpers and commercials by their folder, and the specific holiday in a path (christmas, halloween, …) as a tag, plus more genres (sci-fi, western, fantasy, crime, game show, …). The library item editor gained Artist and Album.',
  ] },
  { date: '2026-10-12', items: [
    'First-run setup now has a CHOOSE HOW IT LOOKS page (page 2 of 3): FULL RETRO LOOK, GENTLE (no screen flicker or channel-change static) or MINIMAL (no CRT effect at all), with a note for people who are sensitive to flashing. You can change it later under Picture & Sound. The TV-mode setup wizard has the same choice (page 3 of 5).',
    'RerunTV is now in beta: releases are numbered 0.2.0-beta.N, and the update check follows them.',
    'Three plugins have new names (your settings, approvals and theme carry over on first launch): the music channel plugin (CH 910) is now Digital Music Channel and asks you to approve it once, the guide plugin is now Guide Channel, and the 1994 guide theme is now Scrolling Guide 94.',
    'A generated demo library (scripts/make-demo-library.js) lets anyone try the app with slow, soft test video and static and flicker already off, and the README has a photosensitivity notice listing the CRT effect, flicker and channel static switches.',
  ] },
  { date: '2026-10-08', items: [
    'Time machine: a scrub you have parked now holds still, so pressing Enter or T lands exactly where the picture was however long you waited. Picking a date on the calendar plays straight away with a note of where it landed, and T after a scrub no longer reloads the video.',
  ] },
  { date: '2026-10-07', items: [
    'Time machine calendar: press D (or TIME MACHINE › PICK A DATE… in the TV menu, or CALENDAR… in a channel\'s PREVIEW) to pick any date and time on a month grid. Days with a date-range block carry a dot, and the footer shows what would be airing there.',
    'Date-range blocks can repeat every year on their own: RESTART FROM ITS FIRST FILE EACH YEAR begins the playlist again at the start of each year\'s range, and STARTS ON THANKSGIVING follows the 4th Thursday of November.',
  ] },
  { date: '2026-10-06', items: [
    'Bumper text can count calendar days: DAY {dayNumber:12/1} OF 25 shows the day of a run that started Dec 1, and {daysLeft:12/25} counts down to Dec 25. Both stay blank outside the range.',
    'A channel can take individual videos as well as whole folders: ADD FILES in the channel\'s actions (or its ⋯ menu, or CONTENT › Folders) picks several at once, and files you add this way are listed there with their own REMOVE buttons.',
    'Audit fixes: the REPEAT / NEW EPISODE badge and other start-of-show corner cards no longer linger after a channel change or sit on top of a break; the sponsor message card no longer sticks on screen; the O-key layout editor now returns to the picture instead of Setup; the footer no longer sticks on SAVING…; release notes in HELP read as plain text.',
    'Setup polish: sentence-case helper text on a channel\'s LOOK page, tidier Sound rows, the No signal card lines up under Dynamic overlays, and the header search clears when you change tabs.',
    'The flow editor shows older bump-in/bump-out steps in its Bumper type list, the flow list updates its target channels as you edit, and the guide explains an empty channel search when upcoming programs still match.',
  ] },
  { date: '2026-10-05', items: [
    'The live overlay layout editor (O key) was rebuilt: a preview of the real picture, smart snapping to edges and other elements, undo/redo, and H to tuck the controls away into a clean view.',
    'The logo and corner badges keep their margin on letterboxed or pillarboxed pictures and stay on the picture instead of on black bars.',
    'Two audit rounds hardened the LAN viewer, plugin approvals, media limits and the personal PIN, and finished setup-screen validation and accessibility.',
  ] },
  { date: '2026-10-04', items: [
    'Remove baked-in black bars: finds letterbox bars inside the video itself and frames just the picture. New default logo size that scales to 1080p or 4K, reset-this-panel buttons, and a settings-only export/import.',
    'Remappable keys for live TV (SYSTEM › Keys), per-channel number chip, and a Guide & Theme page split into Guide, Theme and On-screen.',
    'Music channel: cover art, a CD-rack / record-crate cabinet and search by artist, song, album or year.',
    'Combiner now converts only the clips that differ, reports progress, and uses the GPU when re-encoding.',
  ] },
  { date: '2026-09-29', items: [
    'Simple and Advanced settings views: Simple shows everyday controls and search still finds everything; Advanced shows the lot.',
  ] },
  { date: '2026-09-26', items: [
    'The Video Splicer is built in (LIBRARY › SPLICER): cut recordings into episodes, ads and bumpers, then combine clips.',
    'Updates now keep your library, profiles and assets when the installer replaces the app folder.',
    'Digital Music: pause and seek on demand, and search the library by song, artist, album or year.',
  ] },
  { date: '2026-09-23', items: [
    'TV on a second screen: per-screen placement and fullscreen, TV mode per screen, a sound output picker, screen edges, follow the TV\'s power state, and volume levelling per file.',
  ] },
  { date: '2026-09-13', items: [
    'TV mode for a couch and remote: a TV menu, banner hub, remote test and learn mode, on-screen keyboard, game controllers, Tizen/webOS remotes and HDMI-CEC.',
    'Time machine scrubber strip with a Go to menu, guide program actions, shorts grouped in the guide, breaks drawn as a band, and call letters.',
    'SCHEDULE › ON AIR is an editable programming timeline with edit previews and an explanation of every layer.',
    'A media library with catalogue, review and smart channels; households, DVR and watching together; theme eras; a LAN control panel; and full undo/redo for every setting.',
  ] },
  { date: '2026-08-24', items: [
    'Unified the app typography around the original cable-guide face, with a separate readable face reserved for longer descriptions; fixed the downloaded-update notice so its copy and actions fit as a responsive card.',
    'Added five explicit update policies, including the new recommended pre-launch update flow, plus a two-step first-time setup that explains local-media privacy, autosave/backups, optional integrations, and the update choice.',
    'Channel Health can now relink a moved local media folder: it preserves the old relative layout, verifies the proposed replacement, previews unresolved files, and updates shared channel/schedule references as one undoable edit.',
    'Completed the feature audit: channel packages, Air Check, safe playback-order editing, guide-wide program search/reminders, backup comparison and pinned snapshots, per-channel broadcast identity, opt-in smart library sync, and redacted plugin diagnostics/support export.',
  ] },
  { date: '2026-08-19', items: [
    'Boot-time power-on animation (DISPLAY > PICTURE toggle, on by default) — the app now plays the same powering-on CRT flash the manual power button uses when it first lands on the TV screen, instead of cutting straight to live video. Wood-Grain Console, Late-Night UHF, and Digital Satellite each got their own period-appropriate version (sluggish tube warm-up, tearing signal, crisp digital snap).',
    'Fixed a real bug where an approved plugin\'s REVIEW & APPROVE PERMISSIONS button could keep showing (and the approval could silently be lost) after a restart — the approval write and the settings screen\'s own autosave were racing each other.',
    'PLUGINS tab: an approved plugin now shows a plain "Permissions approved" note instead of the approve button, with REVOKE PERMISSIONS and FULLY UNINSTALL actions next to it — uninstall opens its own themed confirm dialog since it permanently deletes the plugin\'s files.',
  ] },
  { date: '2026-08-17', items: [
    'Full undo/redo (Ctrl+Z / Ctrl+Shift+Z) for setup-screen edits, with toolbar buttons and a command palette (Ctrl+K) for jumping to any tab/sub-tab or running common actions.',
    'Keyboard-nav overhaul of the setup screen: arrow-key navigation between tabs/sub-tabs and between channel rows/interstitial cards, with Enter/Delete acting on the focused row.',
    'Drag video files straight from Explorer onto a channel row or the interstitials pool to add them, instead of only via CHOOSE/ADD FOLDER.',
    'App-wide QOL batch: save-state indicator, breadcrumb trail, session-resume for setup tabs, labeled backups, a migration notice, cross-channel search + NOW/NEXT dashboard, copy-channel-settings, drag-to-reorder channels, a combined health dashboard, and bulk bumper/ad preview.',
    'This HELP tab.',
  ] },
  { date: '2026-08-16', items: [
    '4 new theme eras — Wood-Grain Console (1978), Late-Night UHF (1988), Network Prime Time (1996), Digital Satellite (2001) — each with its own channel-change transition, idle screensaver, synthesized sound (tune/power SFX + ambient texture), guide-grid look, and CRT picture bias, not just a recolor.',
    'Fixed a Shopping Network modal that could survive a channel change; fixed the PPV order button showing the wrong price; fixed a clipped bulk-title input.',
    'Virtual Channels settings panel is now collapsible with a filter instead of one long scroll of 17 cards.',
    'New "STRIP RELEASE TAGS" bulk button cleans up scene-release-style filenames in the Titles editor.',
    'Live CRT-effect preview swatch on the DISPLAY tab.',
  ] },
  { date: '2026-08-09', items: [
    'Bulk-tag by folder/selection with tag autocomplete, rotating config backups with restore, PREVIEW/test-tune (with block picker + quick-jump buttons), channel health check, SMPTE test pattern for unconfigured channels, episode countdown bumper placeholder.',
    'Interstitials/ad-preset UI redesigned into collapsible cards; settings sub-tabs added across DISPLAY/PROGRAMMING/AUDIO & SYSTEM; setup screen widened to use most of the window.',
  ] },
  { date: '2026-08-05', items: [
    'Channel EDIT view unified into one tabbed panel (Folders/Schedule/Titles/Ads/Logo); per-channel calendar with color-coded days, conflict detection, and inline day-override editing; blocks unified onto one trigger schema (day-of-week or date-range, with daily/weekly advent-calendar modes); tagged-interstitials pool replacing the old separate commercial/station-ID/trivia systems; per-channel/per-block volume and content-vs-ad volume layers.',
  ] },
];

// 'off' also disables CHECK NOW — "never" means no update network requests,
// including user-triggered ones. main-updater.js enforces the same rule.
function refreshUpdateModeUI() {
  const strategy = (S.config.updates && S.config.updates.strategy) || 'startup-auto';
  if (checkUpdatesBtn) checkUpdatesBtn.disabled = strategy === 'off';
}

function setUpdateStatus(text) {
  if (updateStatusLineEl) updateStatusLineEl.textContent = text;
}

// Bound once (renderHelpTab's helpTabRendered guard keeps this from
// double-firing) — config.updates itself can still change afterward via
// undo/import, same caveat as the rest of this once-rendered tab.
function initUpdateSettingsPanel() {
  if (updateModeSelect) {
    updateModeSelect.value = (S.config.updates && S.config.updates.strategy) || 'startup-auto';
    updateModeSelect.addEventListener('change', () => {
      dispatch({ type: 'settings.set', path: ['updates', 'strategy'], value: updateModeSelect.value });
      refreshUpdateModeUI();
      setUpdateStatus('');
    });
  }
  refreshUpdateModeUI();

  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener('click', async () => {
      checkUpdatesBtn.disabled = true;
      const originalText = checkUpdatesBtn.textContent;
      checkUpdatesBtn.textContent = 'CHECKING…';
      try {
        const result = await window.api.checkForUpdates();
        if (result.status === 'dev-mode') {
          setUpdateStatus('Update checks only run in a packaged build — this is a dev copy running from source.');
        } else if (result.status === 'disabled') {
          setUpdateStatus('Update checks are turned off (UPDATE POLICY: NEVER, above).');
        } else if (result.status === 'downloading') {
          setUpdateStatus(`Update v${result.version} found — downloading now. You'll be notified once it's ready.`);
        } else if (result.status === 'up-to-date') {
          setUpdateStatus(`You're on the latest version (v${result.version}), checked just now.`);
        } else {
          setUpdateStatus(`Update check failed: ${result.message}`);
        }
      } catch (e) {
        setUpdateStatus(`Update check failed: ${e.message}`);
      } finally {
        checkUpdatesBtn.disabled = (S.config.updates && S.config.updates.strategy) === 'off';
        checkUpdatesBtn.textContent = originalText;
      }
    });
  }
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatReleaseDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Live GitHub Releases feed — fetched once per HELP-tab visit (main
// process caches the actual HTTP call for an hour regardless, see
// main-updater.js's RELEASE_NOTES_TTL_MS), so re-opening HELP later in the
// same session still shows current data without hammering GitHub's API.
async function renderReleaseNotes() {
  if (!helpReleaseNotesListEl) return;
  helpReleaseNotesListEl.textContent = 'Loading…';
  let releases;
  try {
    releases = await window.api.getReleaseNotes();
  } catch (e) {
    releases = [];
  }
  if (!releases || releases.length === 0) {
    helpReleaseNotesListEl.textContent = 'Couldn\'t reach GitHub for release notes right now — try again later.';
    return;
  }
  helpReleaseNotesListEl.innerHTML = '';
  releases.forEach((r) => {
    const entry = document.createElement('div');
    entry.className = 'help-changelog-entry';
    const date = document.createElement('div');
    date.className = 'help-changelog-date';
    date.textContent = `${r.name}${r.prerelease ? ' (pre-release)' : ''} — ${formatReleaseDate(r.publishedAt)}`;
    entry.appendChild(date);
    const body = document.createElement('div');
    // Release bodies are markdown but this is a plain-text panel, not a
    // markdown renderer — bullet lines still read fine as plain text
    // (GitHub's own convention, "- " per line), and escaping the rest
    // avoids trusting arbitrary release-note HTML/script content.
    body.className = 'help-release-body';
    body.textContent = r.body ? readableReleaseNotes(r.body) : 'No description.';
    entry.appendChild(body);
    helpReleaseNotesListEl.appendChild(entry);
  });
}

export function renderHelpTab() {
  if (helpTabRendered) return; // static content — no need to rebuild on every visit
  helpTabRendered = true;

  renderHelpGuide();

  if (helpVersionEl) {
    window.api.getAppVersion().then((v) => {
      if (v) helpVersionEl.textContent = `v${v}`;
    });
  }

  // Not exposed to the LAN viewer's browser-api-shim (nothing to install on
  // a read-only browser tab) — hide the whole panel rather than wire up
  // controls that would just error.
  if (!window.api.checkForUpdates) {
    if (updateSettingsPanelEl) updateSettingsPanelEl.classList.add('hidden');
  } else {
    initUpdateSettingsPanel();
  }

  if (!window.api.getReleaseNotes) {
    if (releaseNotesPanelEl) releaseNotesPanelEl.classList.add('hidden');
  } else {
    renderReleaseNotes();
  }

  if (helpShortcutsGridEl && hintBarEl) {
    helpShortcutsGridEl.innerHTML = '';
    Array.from(hintBarEl.children).filter((span) => span.dataset.hintMode !== 'tv').forEach((span) => {
      const item = document.createElement('div');
      item.className = 'help-shortcut-item';
      item.innerHTML = span.innerHTML;
      helpShortcutsGridEl.appendChild(item);
    });
  }

  if (helpChangelogListEl) {
    helpChangelogListEl.innerHTML = '';
    CHANGELOG.forEach((entry) => {
      const group = document.createElement('div');
      group.className = 'help-changelog-entry';
      const date = document.createElement('div');
      date.className = 'help-changelog-date';
      date.textContent = entry.date;
      group.appendChild(date);
      const list = document.createElement('ul');
      entry.items.forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
      });
      group.appendChild(list);
      helpChangelogListEl.appendChild(group);
    });
  }
}
