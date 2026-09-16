// Setup in TV mode (docs/design/01 §6.4): the tasks that make sense with a
// remote, as sections of the TV menu. Values step with ◀▶ (or OK), text uses
// the on-screen keyboard, and every change is a command like any setup edit.
// Heavier work — folders, blocks, flows, the ad pool — is handed off to a
// phone or computer.
import { sortedChannels } from '../core/channels.js';
import { openHandoff } from './handoff.js';
import { applyCrtState, applyDisplayWakeLock, applyVolume, cycleAspectMode, cyclePictureMode, cycleSleepTimer, toggleCrt } from '../playback/power.js';
import { themePackEntries } from '../plugin/host.js';
import { S, dispatch } from '../core/state.js';
import { applyTheme } from '../display/themes.js';
import { cycleChoice, stepNumber } from './setup-model.js';
import { openLearnMode, openRemoteTest } from '../remote/test.js';
import { openOnScreenKeyboard } from '../ui/on-screen-keyboard.js';

const RATINGS = ['', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
const UPDATE_STRATEGIES = ['startup-auto', 'background-auto', 'background-notify', 'manual', 'off'];
const UPDATE_LABELS = {
  'startup-auto': 'INSTALL BEFORE OPENING', 'background-auto': 'INSTALL WHEN I QUIT', 'background-notify': 'ASK WHEN READY', manual: 'ONLY WHEN I ASK', off: 'NEVER',
};

const onOff = (v) => (v ? 'ON' : 'OFF');
const pct = (v) => `${Math.round(v)}%`;

// A menu item for a value: OK and ▶ step forward, ◀ steps back.
function valueItem(label, read, write) {
  return {
    label: `${label}: ${read()}`,
    keepOpen: true,
    run: () => write(1),
    adjust: (direction) => write(direction),
  };
}

function setSetting(path, value, coalesce) {
  dispatch({ type: 'settings.set', path, value }, coalesce ? { coalesce } : {});
}

// ---------- Channels ----------

function channelItems() {
  return sortedChannels().map((ch) => ({
    label: `CH ${ch.number} · ${(ch.name || 'UNTITLED').toUpperCase()}${ch.hidden ? ' (HIDDEN)' : ''}`,
    // Closes over the channel object: moving it changes its number, and the
    // menu keeps following the same channel.
    submenu: () => channelMenu(ch),
  }));
}

function neighbour(ch, direction) {
  const list = sortedChannels();
  const i = list.indexOf(ch);
  return list[i + direction] || null;
}

function channelMenu(ch) {
  const move = (direction) => {
    const other = neighbour(ch, direction);
    if (other) dispatch({ type: 'channel.swapNumbers', a: ch.number, b: other.number });
  };
  return {
    title: `SETUP · CH ${ch.number} · ${(ch.name || 'UNTITLED').toUpperCase()}`,
    items: [
      // Move mode, remote style: each OK moves the channel one slot.
      { label: neighbour(ch, -1) ? `MOVE UP (SWAP WITH CH ${neighbour(ch, -1).number})` : 'MOVE UP (ALREADY FIRST)', keepOpen: true, disabled: !neighbour(ch, -1), run: () => move(-1) },
      { label: neighbour(ch, 1) ? `MOVE DOWN (SWAP WITH CH ${neighbour(ch, 1).number})` : 'MOVE DOWN (ALREADY LAST)', keepOpen: true, disabled: !neighbour(ch, 1), run: () => move(1) },
      valueItem('SHOWN WHEN SURFING', () => (ch.hidden ? 'NO' : 'YES'), () => dispatch({ type: 'channel.set', channel: ch.number, field: 'hidden', value: !ch.hidden })),
      valueItem('FAVOURITE', () => onOff(ch.favorite), () => dispatch({ type: 'channel.set', channel: ch.number, field: 'favorite', value: !ch.favorite })),
      valueItem('RATING', () => ch.rating || 'NONE', (d) => dispatch({ type: 'channel.set', channel: ch.number, field: 'rating', value: cycleChoice(RATINGS, ch.rating || '', d) || null })),
      {
        label: 'RENAME…',
        keepOpen: true,
        run: async () => {
          const name = await openOnScreenKeyboard({ title: `RENAME CH ${ch.number}`, value: ch.name || '', maxLength: 40 });
          if (name != null && name.trim()) dispatch({ type: 'channel.rename', channel: ch.number, name: name.trim() });
        },
      },
      {
        label: `CALL LETTERS… ${ch.callLetters ? `(${ch.callLetters})` : '(AUTOMATIC)'}`,
        keepOpen: true,
        run: async () => {
          const letters = await openOnScreenKeyboard({ title: `CALL LETTERS FOR CH ${ch.number}`, value: ch.callLetters || '', maxLength: 6 });
          if (letters != null) dispatch({ type: 'channel.set', channel: ch.number, field: 'callLetters', value: letters.trim() || undefined });
        },
      },
      { label: 'MORE ON PHONE OR COMPUTER', run: () => openHandoff() },
    ],
  };
}

// ---------- Picture & sound ----------

function crt(key) {
  return (S.config.crtIntensity && Number.isFinite(S.config.crtIntensity[key])) ? S.config.crtIntensity[key] : 0;
}

function pictureItems() {
  return [
    valueItem('CRT EFFECT', () => onOff(S.config.crtEnabled !== false), () => toggleCrt()),
    valueItem('SCANLINES', () => pct(crt('scanlines')), (d) => { setSetting(['crtIntensity', 'scanlines'], stepNumber(crt('scanlines'), d), 'crt:scanlines'); applyCrtState(); }),
    valueItem('CURVATURE', () => pct(crt('curvature')), (d) => { setSetting(['crtIntensity', 'curvature'], stepNumber(crt('curvature'), d), 'crt:curvature'); applyCrtState(); }),
    valueItem('PICTURE', () => String(S.config.pictureMode || 'normal').toUpperCase(), () => cyclePictureMode()),
    valueItem('ASPECT', () => String(S.config.aspectMode || 'auto').toUpperCase(), () => cycleAspectMode()),
    valueItem('SHOW VOLUME', () => pct((S.config.contentVolume ?? 1) * 100), (d) => { setSetting(['contentVolume'], stepNumber((S.config.contentVolume ?? 1) * 100, d) / 100, 'settings:contentVolume'); applyVolume(); }),
    valueItem('COMMERCIAL VOLUME', () => pct((S.config.adVolume ?? 1) * 100), (d) => { setSetting(['adVolume'], stepNumber((S.config.adVolume ?? 1) * 100, d) / 100, 'settings:adVolume'); applyVolume(); }),
  ];
}

// ---------- Guide & theme ----------

function themeIds() {
  return themePackEntries().map((entry) => entry.id);
}

function themeLabel(id) {
  const entry = themePackEntries().find((e) => e.id === id);
  return (entry && entry.label ? entry.label : id || 'DEFAULT').toUpperCase();
}

function guideItems() {
  const display = () => S.config.display || {};
  return [
    // Live preview: each step applies the theme straight away.
    valueItem('THEME', () => themeLabel(S.config.theme), (d) => { setSetting(['theme'], cycleChoice(themeIds(), S.config.theme, d)); applyTheme(); }),
    valueItem('24-HOUR CLOCK', () => onOff(display().clock24), () => setSetting(['display', 'clock24'], !display().clock24)),
    valueItem('GUIDE WIDTH', () => `${display().guideSlots || 3} HALF-HOURS`, (d) => setSetting(['display', 'guideSlots'], cycleChoice([2, 3, 4], display().guideSlots || 3, d))),
    valueItem('CHANNEL NAMES', () => (display().guideChannelNames === 'short' ? 'CALL LETTERS' : 'FULL'), () => setSetting(['display', 'guideChannelNames'], display().guideChannelNames === 'short' ? 'full' : 'short')),
    valueItem('GROUP SHORTS', () => onOff(display().guideMergeShorts !== false), () => setSetting(['display', 'guideMergeShorts'], display().guideMergeShorts === false)),
    valueItem('SPECIALS AT THE TOP', () => onOff(display().guideSpecialsAtTop), () => setSetting(['display', 'guideSpecialsAtTop'], !display().guideSpecialsAtTop)),
  ];
}

// ---------- Parental lock ----------

function pinItems() {
  const lock = () => S.config.pinLock || { enabled: false, code: '1234' };
  let entry = '';
  const pad = () => {
    const digit = (d) => ({ label: d, keepOpen: true, run: () => { if (entry.length < 8) entry += d; } });
    return {
      title: `NEW PIN: ${entry ? '•'.repeat(entry.length) : '—'}`,
      columns: 3,
      items: [
        ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit),
        { label: '⌫', keepOpen: true, run: () => { entry = entry.slice(0, -1); } },
        digit('0'),
        { label: 'SAVE', run: () => { if (entry.length >= 4) setSetting(['pinLock', 'code'], entry); entry = ''; } },
      ],
    };
  };
  return [
    valueItem('PIN LOCK', () => onOff(lock().enabled), () => setSetting(['pinLock', 'enabled'], !lock().enabled)),
    // onOpen clears the entry once; the pad itself rebuilds on every digit.
    { label: 'CHANGE PIN…', submenu: () => ({ ...pad(), onOpen: () => { entry = ''; } }) },
  ];
}

// ---------- Updates & power ----------

function updateItems() {
  const strategy = () => (S.config.updates && S.config.updates.strategy) || 'startup-auto';
  const items = [valueItem('UPDATES', () => UPDATE_LABELS[strategy()] || strategy().toUpperCase(), (d) => setSetting(['updates', 'strategy'], cycleChoice(UPDATE_STRATEGIES, strategy(), d)))];
  if (window.api && window.api.checkForUpdates) items.push({ label: 'CHECK FOR UPDATES NOW', run: () => window.api.checkForUpdates() });
  return items;
}

function powerItems() {
  const standby = () => S.config.autoStandby || { enabled: false, intervalMinutes: 15 };
  return [
    valueItem('AUTO STANDBY', () => onOff(standby().enabled), () => setSetting(['autoStandby', 'enabled'], !standby().enabled)),
    valueItem('STANDBY AFTER', () => `${standby().intervalMinutes || 15} MIN`, (d) => setSetting(['autoStandby', 'intervalMinutes'], stepNumber(standby().intervalMinutes || 15, d, { min: 15, max: 240, step: 15 }))),
    { label: 'SLEEP TIMER', keepOpen: true, run: () => cycleSleepTimer() },
    valueItem('KEEP DISPLAY AWAKE', () => onOff(S.config.keepDisplayAwake?.enabled !== false), () => { setSetting(['keepDisplayAwake', 'enabled'], S.config.keepDisplayAwake?.enabled === false); applyDisplayWakeLock(); }),
  ];
}

// The SETUP section of the TV menu. Each entry is a menu item; `section` is
// tv-menu.js's helper for a titled submenu.
export function tvSetupItems(section) {
  return [
    section('CHANNELS', 'SETUP · CHANNELS', channelItems),
    section('PICTURE & SOUND', 'SETUP · PICTURE & SOUND', pictureItems),
    section('GUIDE & THEME', 'SETUP · GUIDE & THEME', guideItems),
    section('PARENTAL LOCK', 'SETUP · PARENTAL LOCK', pinItems),
    section('REMOTE', 'SETUP · REMOTE', () => [
      { label: 'REMOTE TEST', run: () => openRemoteTest() },
      { label: 'CUSTOMIZE BUTTONS', run: () => openLearnMode() },
    ]),
    section('UPDATES', 'SETUP · UPDATES', updateItems),
    section('POWER', 'SETUP · POWER', powerItems),
    { label: 'EDIT ON PHONE OR COMPUTER', run: () => openHandoff() },
  ];
}

