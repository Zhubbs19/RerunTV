// A real, D-pad/OK-navigable action menu — replaces the old keyboard-
// shortcut reference (a flat legend of "press X for Y" text, exactly as
// useless on a remote with no letter keys as the hint bar's own text was)
// with actual focusable buttons that DO the thing when activated, calling
// the exact same functions the keyboard shortcuts already call. Opened the
// same way the old reference screen was (the ? key) — works identically
// whether driven by mouse click, Enter/OK via a real keyboard, or a
// synthetic KeyboardEvent from the Android TV wrapper or the phone touch
// controls, since all of those already just dispatch a 'keydown' that
// lands here the same way.
import { guideGrid, shortcutsOverlayEl } from '../core/dom.js';
import { changeChannel, changeFavoriteChannel, jumpToLastChannel, toggleChannelScan, tuneToChannel } from '../playback/core.js';
import { AIR_CHECK_MENU_MAX, airCheckLabel, airChecks, recallAirCheck, saveAirCheck } from '../library/airchecks.js';
import { showDetailsForCurrentChannel } from './details.js';
import { cycleGuideView, focusGuideSearch, openGuideGrid, toggleGuideDockMode, toggleGuideShowBreaks } from '../guide/guide.js';
import { GUIDE_VIEW_LABELS } from '../core/guide-filter.js';
import { skipCurrentBreak } from '../playback/breaks.js';
import { toggleRecentChannels } from '../playback/recent-channels.js';
import { currentUiMode } from '../cable-guide/mode.js';
import { CABLE_GUIDE_UI } from '../cable-guide/model.js';
import { cgMenuKey, cgMenuMode, closeCgMenu, openQuickMenu, renderMainMenu } from '../cable-guide/main-menu.js';
import { getRendererService, interruptEntries } from '../plugin/host.js';
import {
  currentProgramStart, enterTimeMachine, exitTimeMachine, restartCurrentShow, returnToLive, timeMachineAvailable, timeMachineGoTo,
} from '../playback/timemachine.js';
import { formatClock } from '../core/util.js';
import { openTimeCalendar } from '../playback/time-calendar.js';
import { goToTargets, pickerTime, clampPicker, PICKER_DAY_RANGE } from '../timeline/scrubber.js';
import {
  toggleMute, adjustVolume, toggleCrt, cyclePictureMode, cycleAspectMode,
  cycleSleepTimer, powerOff, toggleHintBar,
} from '../playback/power.js';
import { confirmPcShutdown, pcShutdownEnabled } from '../playback/pc-power.js';
import { getClientId, MONTHS, S, WEEKDAYS, viewNow } from '../core/state.js';
import { isPreviewingTvMode, isTvMode, setTvPreview, setUsageModePreference } from './usage-mode.js';
import { commitEntry, cycleSapMode, pushDigit, recallQuickJump, saveQuickJump, showSetupScreen } from '../app.js';
import { subChannelsEnabled } from '../core/channels.js';
import { openHandoff } from './handoff.js';
import { tvSetupItems } from './setup.js';
import { openLearnMode, openRemoteTest } from '../remote/test.js';
import { backExitsImmediately, setBackExitsImmediately } from './input.js';
import { openOnScreenKeyboard } from '../ui/on-screen-keyboard.js';
import {
  currentProfile, handoffTo, joinSharedSession, leaveSharedSession,
  profiles, startSharedSession, switchProfile,
} from '../personal/state.js';

// Read left-to-right, top-to-bottom — arrow-key navigation below treats the
// button list as a grid with this many columns per row. Not derived from
// the actual layout (no measured column count at call time) — has to match
// .tv-menu-grid's own `grid-template-columns: repeat(4, 1fr)` in
// overlays.css by hand. If that CSS rule's column count ever changes, this
// needs to change with it or Up/Down navigation silently desyncs from what's
// actually on screen.
const GRID_COLUMNS = 4;

// Any registerInterrupt entry (plugins.js) contributes its own menu button
// here — generalizes what used to be a couple of hardcoded entries naming
// specific plugins by id, so any interrupt plugin shows up in the TV menu
// automatically without a core code change.
// ---------- TIME MACHINE › (docs/design/11 §3.2) ----------
// Go to… targets first, then the day/hour picker, then on/off and live. With
// the time machine switched off in settings it stays the plain toggle it was.
function timeMachineMenuItem() {
  const enabled = !!(S.config.timeMachine && S.config.timeMachine.enabled);
  if (!enabled) return { label: 'TIME MACHINE', run: () => (S.timeMachineOn ? exitTimeMachine() : enterTimeMachine()) };
  return { label: 'TIME MACHINE ›', submenu: timeMachineSubmenu };
}

function dayLabel(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function timeMachineSubmenu() {
  const now = viewNow();
  const available = S.timeMachineOn || timeMachineAvailable();
  const items = available
    ? goToTargets(now, currentProgramStart()).map((target) => ({
      label: target.label,
      run: () => timeMachineGoTo(target.at, target.label),
    }))
    : [];
  if (available) items.push({ label: 'PICK A DATE (CALENDAR)…', run: () => openTimeCalendar() });
  if (available) items.push({ label: 'PICK DAY & HOUR…', submenu: dayHourPicker });
  items.push({ label: S.timeMachineOn ? 'CLOSE TIME MACHINE' : 'OPEN TIME MACHINE', run: () => (S.timeMachineOn ? exitTimeMachine() : enterTimeMachine()) });
  items.push({ label: 'RETURN TO LIVE', run: () => returnToLive() });
  return { title: available ? 'TIME MACHINE · GO TO…' : 'TIME MACHINE · NOT ON THIS CHANNEL', items };
}

// A D-pad-only picker: step the day and hour with buttons that keep the menu
// open, then GO. ±7 days from the viewed day (scrubber-model.js).
let picker = { dayOffset: 0, hour: 20 };
function dayHourPicker() {
  const now = viewNow();
  const target = pickerTime(now, picker);
  const hourText = formatClock(new Date(target));
  const step = (change) => () => { picker = clampPicker({ dayOffset: picker.dayOffset + (change.day || 0), hour: picker.hour + (change.hour || 0) }); };
  return {
    title: `GO TO ${dayLabel(target)} · ${hourText}`,
    onOpen: () => { picker = clampPicker({ dayOffset: 0, hour: new Date(now).getHours() }); },
    items: [
      { label: '◀ DAY', keepOpen: true, run: step({ day: -1 }), disabled: picker.dayOffset <= -PICKER_DAY_RANGE },
      { label: 'DAY ▶', keepOpen: true, run: step({ day: 1 }), disabled: picker.dayOffset >= PICKER_DAY_RANGE },
      { label: '◀ HOUR', keepOpen: true, run: step({ hour: -1 }) },
      { label: 'HOUR ▶', keepOpen: true, run: step({ hour: 1 }) },
      { label: `GO TO ${dayLabel(target)} ${hourText}`, run: () => timeMachineGoTo(target, `${dayLabel(target)} ${hourText}`) },
    ],
  };
}

// While the guide is open, its own actions come first (docs/design/11 §2.3):
// a remote has no D or B key, and search needs a way to reach the keyboard.
function guideActions() {
  if (!guideGrid || guideGrid.classList.contains('hidden')) return [];
  return [
    { label: S.guideDocked ? 'FULL PAGE GUIDE' : 'DOCK GUIDE', run: () => toggleGuideDockMode() },
    { label: S.guideShowBreaks ? 'HIDE BREAKS' : 'SHOW BREAKS', run: () => toggleGuideShowBreaks() },
    { label: 'SEARCH GUIDE', run: () => focusGuideSearch() },
    // ALL CHANNELS → FAVORITES → NOT WATCHED LATELY, which had no remote path.
    { label: `VIEW: ${GUIDE_VIEW_LABELS[S.guideView] || GUIDE_VIEW_LABELS.all}`, keepOpen: true, run: () => cycleGuideView() },
  ];
}

// ---------- TV mode: a hierarchical menu (docs/design/01 §6.3) ----------
// One column of large choices, a breadcrumb title, Back up a level — instead
// of the desktop grid, which stays exactly as it was. Everything the app can
// do is reachable from here with D-pad + OK + Back alone.
function section(label, title, items, columns, help) {
  return { label: `${label} ›`, help, submenu: () => ({ title, items: items(), columns }) };
}

// Quick-jump slots 1-4, which only Ctrl/Alt + number reached before. Shared
// by the TV menu and the desktop menu.
function quickJumpItems() {
  return ['1', '2', '3', '4'].flatMap((slot) => {
    const target = S.quickJumpSlots && S.quickJumpSlots[slot];
    return [
      { label: `GO TO SLOT ${slot}${target != null ? ` · CH ${target}` : ' · EMPTY'}`, disabled: target == null, run: () => recallQuickJump(slot) },
      { label: `SAVE THIS CHANNEL AS SLOT ${slot}`, keepOpen: true, run: () => saveQuickJump(slot) },
    ];
  });
}

function profileItems() {
  const active = currentProfile();
  return profiles().map((profile) => ({
    label: `${profile.id === active?.id ? '● ' : ''}${profile.name.toUpperCase()}${profile.restriction !== 'none' ? ` · ${profile.restriction.toUpperCase()}` : ''}`,
    disabled: profile.id === active?.id,
    run: async () => {
      let pin = null;
      if (active && active.restriction !== 'none' && active.hasPin) {
        pin = await openOnScreenKeyboard({ title: `PIN FOR ${active.name.toUpperCase()}`, maxLength: 4 });
        if (pin == null) return;
      }
      try { await switchProfile(profile.id, { pin }); } catch (e) { console.warn('[profiles]', e.message); }
    },
  }));
}

function myShowsItems() {
  const profile = currentProfile();
  if (!profile) return [{ label: 'CHOOSE A PROFILE FIRST', disabled: true }];
  const ready = Object.entries(profile.state.recordings || {}).filter(([, recording]) => recording.status === 'ready');
  const requests = profile.state.recordingRequests || [];
  const items = ready.map(([key, recording]) => ({
    label: `▶ ${String(recording.title || key.split('|').slice(-1)[0] || 'RECORDING').toUpperCase()}`,
    run: () => {
      const deck = getRendererService('tape-deck');
      if (!recording.tapeId || !deck?.play) return;
      tuneToChannel(101);
      setTimeout(() => deck.play(recording.tapeId, profile.state.resumePoints?.[`tape:${recording.tapeId}`]?.positionMs || 0), 250);
    },
  }));
  requests.forEach((request) => items.push({
    label: `${request.type.toUpperCase()} · CH ${request.channel} · ${new Date(request.start).toLocaleDateString()}`,
    disabled: true,
  }));
  return items.length ? items : [{ label: 'NO SHOWS OR RECORDING REQUESTS', disabled: true }];
}

function togetherItems() {
  const session = S.sharedSession;
  if (session) return [
    { label: `${session.leader === getClientId() ? 'LEADING' : 'JOINED'} ${session.id} · CH ${session.channel}`, disabled: true },
    { label: 'LEAVE SESSION', run: () => leaveSharedSession().catch((e) => console.warn('[watch together]', e.message)) },
  ];
  return [
    { label: 'START SESSION', run: () => startSharedSession().catch((e) => console.warn('[watch together]', e.message)) },
    { label: 'JOIN SESSION…', run: async () => {
      const id = await openOnScreenKeyboard({ title: 'WATCH SESSION ID', maxLength: 40 });
      if (id) joinSharedSession(id.toLowerCase()).catch((e) => console.warn('[watch together]', e.message));
    } },
  ];
}

function handoffItems() {
  const targets = (S.personalClients || []).filter((client) => client.id !== getClientId());
  return targets.length ? targets.map((client) => ({
    label: `${client.label.toUpperCase()} · ${client.id.slice(-4).toUpperCase()}`,
    run: () => handoffTo(client.id).catch((e) => console.warn('[handoff]', e.message)),
  })) : [{ label: 'NO OTHER SCREEN IS ONLINE', disabled: true }];
}

function tvRootItems() {
  return [
    ...guideActions(),
    { label: 'GUIDE', help: 'See what\'s on now and later on every channel.', run: () => openGuideGrid() },
    // Second, so from live TV "yesterday same time" is Play/Pause, ▼, OK, OK,
    // OK — docs/design/11 §5.
    { ...timeMachineMenuItem(), help: 'Go back in time and watch what aired then.' },
    section('CHANNELS', 'TV MENU · CHANNELS', () => [
      { label: 'CH ▲', run: () => changeChannel(1) },
      { label: 'CH ▼', run: () => changeChannel(-1) },
      { label: 'LAST CH', run: () => jumpToLastChannel() },
      { label: 'RECENT CHANNELS', help: 'The channels you watched last.', run: () => toggleRecentChannels() },
      { label: 'NEXT FAVOURITE', help: 'Step to the next channel marked as a favourite.', run: () => changeFavoriteChannel(1) },
      { label: 'PREVIOUS FAVOURITE', run: () => changeFavoriteChannel(-1) },
      { label: 'TUNE TO NUMBER…', submenu: numberPad },
      { label: 'QUICK-JUMP SLOTS…', help: 'Save up to four channels and jump straight back to them.', submenu: () => ({ title: 'TV MENU · CHANNELS · QUICK-JUMP', items: quickJumpItems() }) },
      { label: 'SCAN', help: 'Flip through every channel until you press a button.', run: () => toggleChannelScan() },
    ], undefined, 'Change, scan and jump between channels.'),
    section('WATCH', 'TV MENU · WATCH', () => [
      { label: 'INFO', run: () => showDetailsForCurrentChannel() },
      { label: 'START OVER', help: 'Watch this show from its beginning.', run: () => restartCurrentShow() },
      { label: 'SKIP THIS BREAK', help: 'Jump past the commercial break that\'s on now.', run: () => skipCurrentBreak() },
      { label: 'RETURN TO LIVE', run: () => returnToLive() },
      { label: 'MARK AIR CHECK', run: () => saveAirCheck() },
      ...airChecks().slice(0, AIR_CHECK_MENU_MAX).map((mark) => ({
        label: `▶ ${airCheckLabel(mark)}`,
        run: () => recallAirCheck(mark.id),
      })),
      ...interruptEntries().filter((e) => e.label).map((e) => ({ label: e.label, run: () => e.run({ manual: true }) })),
    ]),
    section(`PROFILE: ${currentProfile()?.name || 'EVERYONE'}`, 'TV MENU · WHO’S WATCHING', profileItems),
    section('MY SHOWS', 'TV MENU · MY SHOWS', myShowsItems),
    section('WATCH TOGETHER', 'TV MENU · WATCH TOGETHER', togetherItems),
    section('CONTINUE ON…', 'TV MENU · CONTINUE ON…', handoffItems),
    section('PICTURE & SOUND', 'TV MENU · PICTURE & SOUND', () => [
      { label: S.config.muted ? 'UNMUTE' : 'MUTE', keepOpen: true, run: () => toggleMute() },
      { label: `AUDIO: ${String(S.sapMode || 'stereo').toUpperCase()}`, keepOpen: true, help: 'Stereo, mono or the second audio program.', run: () => cycleSapMode() },
      { label: 'VOL ▲', keepOpen: true, run: () => adjustVolume(0.1) },
      { label: 'VOL ▼', keepOpen: true, run: () => adjustVolume(-0.1) },
      { label: 'CRT FX', keepOpen: true, run: () => toggleCrt() },
      { label: 'PICTURE', keepOpen: true, run: () => cyclePictureMode() },
      { label: 'ASPECT', keepOpen: true, run: () => cycleAspectMode() },
      { label: 'FULLSCREEN', run: () => window.api.toggleFullscreen() },
    ]),
    section('REMOTE', 'TV MENU · REMOTE', () => [
      { label: 'REMOTE TEST', run: () => openRemoteTest() },
      { label: 'CUSTOMIZE BUTTONS', run: () => openLearnMode() },
      { label: backExitsImmediately() ? 'BACK ASKS FIRST' : 'BACK EXITS AT ONCE', keepOpen: true, run: () => setBackExitsImmediately(!backExitsImmediately()) },
    ]),
    // Setup with a remote (docs/design/01 §6.4, tv-setup.js); the full setup
    // screen is still one choice away for a keyboard and mouse.
    section('SETUP', 'TV MENU · SETUP', () => [
      ...tvSetupItems(section),
      { label: 'OPEN FULL SETUP', run: () => showSetupScreen() },
    ]),
    section('SYSTEM', 'TV MENU · SYSTEM', () => [
      { label: 'SLEEP TIMER', keepOpen: true, run: () => cycleSleepTimer() },
      { label: 'HIDE HINTS', keepOpen: true, run: () => toggleHintBar() },
      isPreviewingTvMode()
        ? { label: 'END TV PREVIEW', run: () => setTvPreview(false) }
        : { label: 'DESKTOP MODE', run: () => setUsageModePreference('desktop') },
      ...(window.AndroidRemoteBridge && window.AndroidRemoteBridge.openClientSettings
        ? [{ label: 'TV CLIENT SETTINGS', run: () => window.AndroidRemoteBridge.openClientSettings() }] : []),
      { label: 'POWER OFF', run: () => powerOff() },
      // Only once SYSTEM › POWER allows it (playback/pc-power.js); it asks first.
      ...(pcShutdownEnabled() ? [{ label: 'SHUT DOWN PC', run: () => confirmPcShutdown() }] : []),
    ]),
  ];
}

// Direct tuning without digit keys (docs/design/01 §5.3): a 3-column pad that
// feeds the same entry buffer the number keys do.
function numberPad() {
  const digit = (d) => ({ label: d, keepOpen: true, columnsItem: true, run: () => pushDigit(d) });
  const items = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit);
  items.push(subChannelsEnabled() ? { label: '·', keepOpen: true, run: () => pushDigit('.') } : { label: ' ', disabled: true, keepOpen: true, run: () => {} });
  items.push(digit('0'));
  items.push({ label: 'TUNE', run: () => commitEntry() });
  return { title: S.entryBuffer ? `TUNE TO ${S.entryBuffer}` : 'TUNE TO NUMBER', items, columns: 3 };
}

function actions() {
  return [
    ...guideActions(),
    { label: 'CH ▲', run: () => changeChannel(1) },
    { label: 'CH ▼', run: () => changeChannel(-1) },
    { label: 'LAST CH', run: () => jumpToLastChannel() },
    { label: 'GUIDE', run: () => openGuideGrid() },
    // Directly under the first item, so from live TV "yesterday same time" is
    // Play/Pause, ▼, OK, OK (and OK again to play) — docs/design/11 §5.
    timeMachineMenuItem(),
    { label: 'INFO', run: () => showDetailsForCurrentChannel() },
    { label: 'START OVER', run: () => restartCurrentShow() },
    { label: 'SKIP BREAK', run: () => skipCurrentBreak() },
    { label: 'RETURN TO LIVE', run: () => returnToLive() },
    { label: 'RECENT CHANNELS', run: () => toggleRecentChannels() },
    { label: 'NEXT FAVOURITE', run: () => changeFavoriteChannel(1) },
    { label: 'QUICK-JUMP SLOTS ›', submenu: () => ({ title: 'TV MENU · QUICK-JUMP SLOTS', items: quickJumpItems(), columns: 2 }) },
    { label: 'SCAN', run: () => toggleChannelScan() },
    { label: 'MARK AIR CHECK', run: () => saveAirCheck() },
    // The most recent marks, as one-press recalls. This is a remote-friendly
    // shortlist, not a management surface — removing one is a setup-screen
    // job, where there's a keyboard and a full list to work with.
    ...airChecks().slice(0, AIR_CHECK_MENU_MAX).map((mark) => ({
      label: `▶ ${airCheckLabel(mark)}`,
      run: () => recallAirCheck(mark.id),
    })),
    ...interruptEntries().filter((e) => e.label).map((e) => ({ label: e.label, run: () => e.run({ manual: true }) })),
    { label: 'MUTE', run: () => toggleMute() },
    { label: `AUDIO: ${String(S.sapMode || 'stereo').toUpperCase()}`, keepOpen: true, run: () => cycleSapMode() },
    { label: 'VOL ▲', run: () => adjustVolume(0.1) },
    { label: 'VOL ▼', run: () => adjustVolume(-0.1) },
    { label: 'CRT FX', run: () => toggleCrt() },
    { label: 'PICTURE', run: () => cyclePictureMode() },
    { label: 'ASPECT', run: () => cycleAspectMode() },
    { label: 'SLEEP TIMER', run: () => cycleSleepTimer() },
    { label: 'FULLSCREEN', run: () => window.api.toggleFullscreen() },
    { label: 'HIDE HINTS', run: () => toggleHintBar() },
    // Per device (usage-mode.js): the way back from TV mode on a box with only
    // a remote, and a quick way to try TV mode from a keyboard.
    { label: isTvMode() ? 'DESKTOP MODE' : 'TV MODE', run: () => setUsageModePreference(isTvMode() ? 'desktop' : 'tv') },
    // Remote (docs/design/01 §5.2): what this remote actually sends, and
    // reassigning a button the automatic mapping gets wrong.
    { label: 'REMOTE TEST', run: () => openRemoteTest() },
    { label: 'CUSTOMIZE BUTTONS', run: () => openLearnMode() },
    { label: backExitsImmediately() ? 'BACK ASKS FIRST' : 'BACK EXITS AT ONCE', run: () => setBackExitsImmediately(!backExitsImmediately()) },
    section(`PROFILE: ${currentProfile()?.name || 'EVERYONE'}`, 'TV MENU · WHO’S WATCHING', profileItems, GRID_COLUMNS),
    section('MY SHOWS', 'TV MENU · MY SHOWS', myShowsItems, GRID_COLUMNS),
    section('WATCH TOGETHER', 'TV MENU · WATCH TOGETHER', togetherItems, GRID_COLUMNS),
    section('CONTINUE ON…', 'TV MENU · CONTINUE ON…', handoffItems, GRID_COLUMNS),
    { label: 'POWER OFF', run: () => powerOff() },
    ...(pcShutdownEnabled() ? [{ label: 'SHUT DOWN PC', run: () => confirmPcShutdown() }] : []),
  ];
}

// The cable-guide Quick Menu: one row of tiles over the picture.
function quickTiles() {
  const lock = S.config.pinLock && S.config.pinLock.enabled;
  return [
    { icon: 'home', label: 'Main Menu', help: 'Go to the Main Menu', toMain: true },
    { icon: 'guide', label: 'Guide', help: 'See what\'s on now and later', run: () => openGuideGrid() },
    { icon: 'clock', label: 'Time Machine', help: 'Go back in time', run: () => (S.timeMachineOn ? exitTimeMachine() : enterTimeMachine()) },
    { icon: 'start', label: 'Start Over', help: 'Watch this show from the start', run: () => restartCurrentShow() },
    { icon: 'recent', label: 'Recent', help: 'The channels you watched last', run: () => toggleRecentChannels() },
    { icon: 'favorite', label: 'Favourites', help: 'Next favourite channel', run: () => changeFavoriteChannel(1) },
    { icon: 'search', label: 'Search', help: 'Find a show by name', run: () => { openGuideGrid(); setTimeout(() => focusGuideSearch(), 50); } },
    { icon: 'skip', label: 'Skip Break', help: 'Jump past this commercial break', run: () => skipCurrentBreak() },
    { icon: 'audio', label: 'Audio', help: `Stereo, mono or SAP (now ${String(S.sapMode || 'stereo').toUpperCase()})`, run: () => cycleSapMode() },
    { icon: 'lock', label: 'Parental Lock', help: lock ? 'The lock is on' : 'The lock is off', run: () => openTvMenuAt(['SETUP ›', 'PARENTAL LOCK ›']) },
  ];
}

function cableGuide() {
  return currentUiMode() === CABLE_GUIDE_UI;
}

const gridEl = document.getElementById('tv-menu-grid');
// Built fresh every time the menu opens (not once at module load) since
// interruptEntries() only reflects whatever's registered by then — plugin
// renderer.js modules import+register asynchronously (loadPlugins(),
// app.js) after this module's own top-level code has already run.
let buttons = [];
let menuPreviouslyFocused = null;
// Open submenus, innermost last; each is the function that builds it (so a
// picker step re-reads its labels). Back pops one level (handleTvMenuKey).
let menuStack = [];
const titleEl = document.getElementById('tv-menu-title');

// The desktop grid is 4 wide; a TV level is one column unless it says
// otherwise (the number pad is 3).
let viewColumns = GRID_COLUMNS;
let viewItems = [];

// What OK on an item does, in either layout's menu.
function activateItem(a, i) {
  if (!a || a.disabled) return;
  if (a.submenu) {
    menuStack.push(a.submenu);
    const sub = a.submenu();
    if (sub.onOpen) sub.onOpen();
    rebuildMenu(0);
    return;
  }
  if (a.keepOpen) {
    const result = a.run();
    rebuildMenu(i);
    // An item that asks for something first (the on-screen keyboard)
    // relabels once it's answered.
    if (result && typeof result.then === 'function') {
      result.then(() => { if (!shortcutsOverlayEl.classList.contains('hidden')) rebuildMenu(i); });
    }
    return;
  }
  closeTvMenu();
  a.run();
}

function backOneLevel() {
  if (menuStack.length) { menuStack.pop(); rebuildMenu(0); } else closeTvMenu();
}

// The cable-guide Main Menu uses the TV hierarchy on desktop too, so every
// section (profiles, my shows, watch together…) is reachable from both.
function renderCableGuideMenu(view, focusIndex) {
  renderMainMenu(shortcutsOverlayEl, view, focusIndex, {
    activate: (i) => activateItem(viewItems[i], i),
    adjust: (i, direction) => {
      const item = viewItems[i];
      if (item && typeof item.adjust === 'function') { item.adjust(direction); rebuildMenu(i); }
    },
    back: backOneLevel,
    close: () => closeTvMenu(),
  });
}

// Opens the menu straight at a path of section labels (the Quick Menu's lock).
function openTvMenuAt(path) {
  openTvMenu();
  if (cableGuide() && cgMenuMode() === 'quick') openTvMenu();
  let items = tvRootItems();
  for (const label of path) {
    const item = items.find((it) => it.label === label);
    if (!item || !item.submenu) break;
    menuStack.push(item.submenu);
    items = item.submenu().items;
  }
  rebuildMenu(0);
}

function rebuildMenu(focusIndex = 0) {
  gridEl.innerHTML = '';
  const level = menuStack[menuStack.length - 1];
  if (cableGuide()) {
    const cgView = level ? level() : { title: 'TV MENU', items: tvRootItems() };
    viewItems = cgView.items;
    buttons = [];
    renderCableGuideMenu(cgView, focusIndex);
    return;
  }
  const view = level ? level() : { title: 'TV MENU', items: isTvMode() ? tvRootItems() : actions() };
  viewColumns = view.columns || (isTvMode() ? 1 : GRID_COLUMNS);
  gridEl.style.gridTemplateColumns = viewColumns === GRID_COLUMNS ? '' : `repeat(${viewColumns}, 1fr)`;
  gridEl.classList.toggle('tv-menu-list', isTvMode() && viewColumns === 1);
  if (titleEl) titleEl.textContent = view.title;
  viewItems = view.items;
  buttons = view.items.map((a, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tv-menu-btn';
    btn.dataset.slot = 'tv-menu-button';
    btn.textContent = a.label;
    if (a.disabled) btn.setAttribute('aria-disabled', 'true');
    btn.addEventListener('click', () => activateItem(a, i));
    gridEl.appendChild(btn);
    return btn;
  });
  const target = buttons[Math.min(focusIndex, buttons.length - 1)];
  if (target && !shortcutsOverlayEl.classList.contains('hidden')) target.focus();
}

export function openTvMenu() {
  if (cableGuide()) {
    // First press: the Quick Menu. Pressed again while it's up: the Main Menu.
    const wasHidden = shortcutsOverlayEl.classList.contains('hidden');
    if (wasHidden) menuPreviouslyFocused = document.activeElement;
    menuStack = [];
    if (wasHidden || cgMenuMode() !== 'quick') {
      shortcutsOverlayEl.classList.remove('hidden');
      openQuickMenu(shortcutsOverlayEl, quickTiles(), {
        toMain: () => rebuildMenu(0),
        close: () => closeTvMenu(),
      });
      shortcutsOverlayEl.focus({ preventScroll: true });
    } else {
      rebuildMenu(0);
    }
    return;
  }
  if (shortcutsOverlayEl.classList.contains('hidden')) menuPreviouslyFocused = document.activeElement;
  menuStack = [];
  rebuildMenu();
  const hint = shortcutsOverlayEl.querySelector('.shortcuts-hint');
  if (hint) hint.textContent = isTvMode() ? '▲ ▼ TO MOVE · OK OPENS · BACK GOES UP' : 'ARROW KEYS TO MOVE · ENTER/OK TO SELECT · ? OR ESC TO CLOSE';
  shortcutsOverlayEl.classList.remove('hidden');
  if (buttons[0]) buttons[0].focus();
}

export function closeTvMenu() {
  menuStack = [];
  closeCgMenu();
  shortcutsOverlayEl.classList.add('hidden');
  if (menuPreviouslyFocused && menuPreviouslyFocused.isConnected && menuPreviouslyFocused.getClientRects().length && menuPreviouslyFocused.focus) {
    menuPreviouslyFocused.focus({ preventScroll: true });
  } else if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  menuPreviouslyFocused = null;
}

// Real 2D grid navigation — arrow keys move focus by row/column. A plain
// browser focus order has no concept of "up"/"down" for a grid of buttons
// (only linear Tab order), so this has to be computed explicitly. Moving
// right/left past a row's edge rolls into the next/previous row rather
// than stopping dead — a common, easy-to-predict grid-navigation behavior.
export function handleTvMenuKey(e) {
  if (cableGuide() && cgMenuMode() && cgMenuKey(e)) return;
  if (e.key === 'Escape' && menuStack.length) {
    menuStack.pop();
    rebuildMenu(0);
    return;
  }
  if (e.key === '?' || e.key === 'Escape') {
    closeTvMenu();
    return;
  }
  const current = buttons.indexOf(document.activeElement);
  if (e.key === 'Tab') {
    e.preventDefault();
    const index = current === -1 ? 0 : (current + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    if (buttons[index]) buttons[index].focus();
    return;
  }
  if (current === -1) {
    if (e.key === 'Enter' || e.key === ' ') buttons[0] && buttons[0].click();
    else if (buttons[0]) buttons[0].focus();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    buttons[current].click();
    return;
  }
  if (viewColumns === 1) {
    // A value item (TV setup): ◀▶ step it in place.
    const item = viewItems[current];
    if (item && typeof item.adjust === 'function' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      item.adjust(e.key === 'ArrowRight' ? 1 : -1);
      rebuildMenu(current);
      return;
    }
    if (e.key === 'ArrowLeft') {
      if (menuStack.length) { menuStack.pop(); rebuildMenu(0); }
      return;
    }
    if (e.key === 'ArrowRight') {
      buttons[current].click();
      return;
    }
  }
  let next = current;
  if (e.key === 'ArrowRight') next = Math.min(current + 1, buttons.length - 1);
  else if (e.key === 'ArrowLeft') next = Math.max(current - 1, 0);
  else if (e.key === 'ArrowDown') next = Math.min(current + viewColumns, buttons.length - 1);
  else if (e.key === 'ArrowUp') next = Math.max(current - viewColumns, 0);
  else return;
  buttons[next].focus();
}
