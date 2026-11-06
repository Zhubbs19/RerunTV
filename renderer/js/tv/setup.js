// Setup in TV mode (docs/design/01 §6.4): the tasks that make sense with a
// remote, as sections of the TV menu. Values step with ◀▶ (or OK), text uses
// the on-screen keyboard, and every change is a command like any setup edit.
// Heavier work — folders, blocks, flows, the ad pool — is handed off to a
// phone or computer.
import { REMOTE_BUTTON_ACTIONS, REMOTE_BUTTON_SLOTS, defaultButtonAction } from '../remote/input.js';
import { sortedChannels } from '../core/channels.js';
import { openHandoff } from './handoff.js';
import { applyCrtState, applyDisplayWakeLock, applyVolume, cycleAspectMode, cyclePictureMode, refreshPictureArea, toggleCrt } from '../playback/power.js';
import { applyBakedBars } from '../playback/bars.js';
import { pcShutdownAvailable, pcShutdownEnabled, setPcShutdownEnabled, setShutsDownPcWithBox, shutsDownPcWithBox } from '../playback/pc-power.js';
import { themePackEntries } from '../plugin/host.js';
import { S, commitConfigPatch, dispatch } from '../core/state.js';
import { applyTheme } from '../display/themes.js';
import { applyDisplayMode } from '../display/mode.js';
import { applyEra, clearEra, listEras } from '../display/eras.js';
import { cycleChoice, stepNumber } from './setup-model.js';
import { boxValue, tvSettings } from '../core/settings-registry.js';
import { openLearnMode, openRemoteTest } from '../remote/test.js';
import { openOnScreenKeyboard } from '../ui/on-screen-keyboard.js';
import { isFavorite, toggleFavorite } from '../personal/state.js';

const RATINGS = ['', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
const UPDATE_STRATEGIES = ['startup-auto', 'background-auto', 'background-notify', 'manual', 'off'];
const UPDATE_LABELS = {
  'startup-auto': 'INSTALL BEFORE OPENING', 'background-auto': 'INSTALL WHEN I QUIT', 'background-notify': 'ASK WHEN READY', manual: 'ONLY WHEN I ASK', off: 'NEVER',
};

const onOff = (v) => (v ? 'ON' : 'OFF');
const pct = (v) => `${Math.round(v)}%`;

// A menu item for a value: OK and ▶ step forward, ◀ steps back.
function valueItem(label, read, write) {
  const value = read();
  return {
    label: `${label}: ${value}`,
    // The cable-guide menu draws these as `Label:  < value >` rows.
    name: label,
    value,
    keepOpen: true,
    run: () => write(1),
    adjust: (direction) => write(direction),
  };
}

function setSetting(path, value, coalesce) {
  dispatch({ type: 'settings.set', path, value }, coalesce ? { coalesce } : {});
}

// ---------- Channels ----------

const PAUSE_LABELS = { '': 'BOX SETTING', on: 'ON', off: 'OFF' };

function channelItems() {
  return sortedChannels().map((ch) => ({
    label: `CH ${ch.number} · ${(ch.name || 'UNTITLED').toUpperCase()}${ch.hidden ? ' (HIDDEN)' : ''}`,
    text: `CH ${ch.number} · ${ch.name || 'Untitled'}${ch.hidden ? ' (Hidden)' : ''}`,
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
    where: `Setup › CH ${ch.number} · ${ch.name || 'Untitled'}`,
    items: [
      // Move mode, remote style: each OK moves the channel one slot.
      { label: neighbour(ch, -1) ? `MOVE UP (SWAP WITH CH ${neighbour(ch, -1).number})` : 'MOVE UP (ALREADY FIRST)', keepOpen: true, disabled: !neighbour(ch, -1), run: () => move(-1) },
      { label: neighbour(ch, 1) ? `MOVE DOWN (SWAP WITH CH ${neighbour(ch, 1).number})` : 'MOVE DOWN (ALREADY LAST)', keepOpen: true, disabled: !neighbour(ch, 1), run: () => move(1) },
      valueItem('SHOWN WHEN SURFING', () => (ch.hidden ? 'NO' : 'YES'), () => dispatch({ type: 'channel.set', channel: ch.number, field: 'hidden', value: !ch.hidden })),
      valueItem('FAVOURITE', () => onOff(isFavorite(ch.number)), () => toggleFavorite(ch.number)),
      valueItem('RATING', () => ch.rating || 'NONE', (d) => dispatch({ type: 'channel.set', channel: ch.number, field: 'rating', value: cycleChoice(RATINGS, ch.rating || '', d) || null })),
      valueItem('SHOWS PAUSE FOR ADS', () => PAUSE_LABELS[ch.pauseForBreaks || ''], (d) => dispatch({ type: 'channel.set', channel: ch.number, field: 'pauseForBreaks', value: cycleChoice(['', 'on', 'off'], ch.pauseForBreaks || '', d) || null })),
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

// ---------- Settings sections, from the registry ----------
// PICTURE & SOUND, BREAKS, GUIDE & ON SCREEN, CONTROLS and POWER & PLAYBACK
// list the registry's `tv` settings (core/settings-registry.js), so a setting
// gets onto the remote by saying so there, with the same label source, range
// and default as its setup row. `tv.custom` names a builder below for the few
// that need more than stepping a value; `tv.apply` re-applies the change live.

const APPLY = {
  crt: () => applyCrtState(),
  volume: () => applyVolume(),
  pictureArea: () => refreshPictureArea(),
  bars: () => applyBakedBars(),
  wakeLock: () => applyDisplayWakeLock(),
};

function themeIds() {
  return themePackEntries().map((entry) => entry.id);
}

function themeLabel(id) {
  const entry = themePackEntries().find((e) => e.id === id);
  return (entry && entry.label ? entry.label : id || 'DEFAULT').toUpperCase();
}

// docs/design/10 §6: Left/Right steps built-in eras (plus "BOX SETTINGS" for
// no era), applying live behind the menu the same way THEME does.
function eraLabel(id) {
  if (!id) return 'BOX SETTINGS';
  const era = listEras().find((e) => e.id === id);
  return era ? era.label.toUpperCase() : id.toUpperCase();
}

function applyEraVisuals() {
  applyTheme();
  applyCrtState();
  applyDisplayMode();
}

// The settings that need their own handling on the remote.
const CUSTOM = {
  crt: (label) => valueItem(label, () => onOff(S.config.crtEnabled !== false), () => toggleCrt()),
  pictureMode: (label, entry) => valueItem(label, () => choiceLabel(entry, boxValue(entry, S.config)), () => cyclePictureMode()),
  aspectMode: (label, entry) => valueItem(label, () => choiceLabel(entry, boxValue(entry, S.config)), () => cycleAspectMode()),
  // Live preview: each step applies the theme straight away.
  theme: (label) => valueItem(label, () => themeLabel(S.config.theme), (d) => { setSetting(['theme'], cycleChoice(themeIds(), S.config.theme, d)); applyTheme(); }),
  startupChannel: (label) => {
    const c = () => S.config.controls || {};
    const choices = () => ['last', 'first', ...sortedChannels().map((ch) => ch.number)];
    const text = (v) => (v === 'first' ? 'FIRST CHANNEL' : typeof v === 'number' ? `CH ${v}` : 'LAST WATCHED');
    return valueItem(label, () => text(c().startupChannel), (d) => setSetting(['controls', 'startupChannel'], cycleChoice(choices(), c().startupChannel || 'last', d)));
  },
  // Lowering the maximum also brings the current volume under it.
  volumeMax: (label, entry) => valueItem(label, () => pct(boxValue(entry, S.config)), (d) => {
    const next = stepNumber(boxValue(entry, S.config), d, { min: 10, max: 100, step: 10 });
    setSetting(entry.path, next);
    if (typeof S.config.volume === 'number' && S.config.volume > next / 100) { S.config.volume = next / 100; setSetting(['volume'], S.config.volume); applyVolume(); }
  }),
};

function choiceLabel(entry, value) {
  const hit = (entry.choices || []).find(([v]) => String(v) === String(value));
  return (hit ? hit[1] : String(value == null ? '' : value)).toUpperCase();
}

// A choice saved as a number (guide width 3) stays a number.
function choiceValue(entry, value) {
  return typeof entry.default === 'number' ? Number(value) : value;
}

function registryItem(entry) {
  const tv = entry.tv;
  const label = tv.label || entry.label.toUpperCase();
  if (tv.custom) return CUSTOM[tv.custom] ? CUSTOM[tv.custom](label, entry) : null;
  const read = () => boxValue(entry, S.config);
  const done = () => { if (tv.apply && APPLY[tv.apply]) APPLY[tv.apply](); };
  if (entry.type === 'switch') return valueItem(label, () => onOff(read()), () => { setSetting(entry.path, !read()); done(); });
  if (entry.type === 'choice') {
    const values = entry.choices.map(([v]) => String(v));
    return valueItem(label, () => choiceLabel(entry, read()), (d) => { setSetting(entry.path, choiceValue(entry, cycleChoice(values, String(read()), d))); done(); });
  }
  if (entry.type === 'number') {
    const scale = entry.scale || 1;
    const r = entry.range || {};
    const step = tv.step || r.step || 1;
    const min = tv.min ?? r.min ?? 0;
    const max = tv.max ?? r.max ?? min + 100 * step;
    const unit = (r.unit || '').toUpperCase();
    const shown = () => Number(read()) / scale;
    const text = () => (Number.isInteger(step) ? String(Math.round(shown())) : shown().toFixed(1));
    return valueItem(label, () => `${text()}${unit ? ` ${unit}` : ''}`, (d) => {
      const next = Math.round(stepNumber(shown(), d, { min, max, step }) * 1000) / 1000;
      setSetting(entry.path, next * scale, `tv:${entry.id}`);
      done();
    });
  }
  return null;
}

function registryItems(section) {
  return tvSettings(section).map(registryItem).filter(Boolean);
}

function guideItems() {
  return [
    valueItem('ERA', () => eraLabel(S.config.era && S.config.era.id), (d) => {
      const ids = [null, ...listEras().map((e) => e.id)];
      const next = cycleChoice(ids, S.config.era ? S.config.era.id : null, d);
      if (next) applyEra(S.config, next); else clearEra(S.config);
      commitConfigPatch(next ? `Era: ${eraLabel(next)}` : 'Clear era');
      applyEraVisuals();
    }),
    ...registryItems('guide'),
  ];
}

// ---------- Parental lock ----------

function pinItems() {
  const lock = () => S.config.pinLock || { enabled: false, code: '1234' };
  let entry = '';
  const pad = () => {
    const digit = (d) => ({ label: d, keepOpen: true, run: () => { if (entry.length < 4) entry += d; } });
    return {
      title: `NEW PIN: ${entry ? '•'.repeat(entry.length) : '—'}`,
      columns: 3,
      items: [
        ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit),
        { label: '⌫', keepOpen: true, run: () => { entry = entry.slice(0, -1); } },
        digit('0'),
        { label: 'SAVE', run: () => { if (entry.length === 4) setSetting(['pinLock', 'code'], entry); entry = ''; } },
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
  return [
    ...registryItems('power'),
    // Shutting the PC down (playback/pc-power.js): off until allowed here,
    // and then optionally tied to the box's own power-off.
    ...(pcShutdownAvailable() ? [
      valueItem('ALLOW PC SHUTDOWN', () => onOff(pcShutdownEnabled()), () => setPcShutdownEnabled(!pcShutdownEnabled())),
      ...(pcShutdownEnabled() ? [valueItem('POWER OFF SHUTS DOWN PC', () => onOff(shutsDownPcWithBox()), () => setShutsDownPcWithBox(!shutsDownPcWithBox()))] : []),
    ] : []),
  ];
}

// SETUP › REMOTE: what each button does on live TV (remote.buttons, the same
// map as SYSTEM › REMOTE & KEYS). '' is the button's own default.
function remoteButtonItems() {
  const ids = ['', ...REMOTE_BUTTON_ACTIONS.map((a) => a.id)];
  const actionLabel = (id) => (REMOTE_BUTTON_ACTIONS.find((a) => a.id === id) || {}).label || 'nothing';
  return REMOTE_BUTTON_SLOTS.map((slot) => {
    const current = () => (S.config.remote && S.config.remote.buttons && S.config.remote.buttons[slot.key]) || '';
    const text = () => (current() ? actionLabel(current()) : `Default (${actionLabel(defaultButtonAction(slot.key))})`).toUpperCase();
    return valueItem(`${slot.label.toUpperCase()} BUTTON`, text, (d) => {
      const next = cycleChoice(ids, current(), d);
      setSetting(['remote', 'buttons', slot.key], next || undefined);
    });
  });
}

// The SETUP section of the TV menu. Each entry is a menu item; `section` is
// tv-menu.js's helper for a titled submenu.
export function tvSetupItems(section) {
  return [
    section('CHANNELS', 'SETUP · CHANNELS', channelItems),
    section('PICTURE & SOUND', 'SETUP · PICTURE & SOUND', () => registryItems('picture')),
    section('BREAKS', 'SETUP · BREAKS', () => registryItems('breaks')),
    section('GUIDE & ON SCREEN', 'SETUP · GUIDE & ON SCREEN', guideItems),
    section('PARENTAL LOCK', 'SETUP · PARENTAL LOCK', pinItems),
    section('REMOTE', 'SETUP · REMOTE', () => [
      { label: 'REMOTE TEST', run: () => openRemoteTest() },
      { label: 'CUSTOMIZE BUTTONS', run: () => openLearnMode() },
      ...remoteButtonItems(),
    ]),
    section('UPDATES', 'SETUP · UPDATES', updateItems),
    section('CONTROLS', 'SETUP · CONTROLS', () => registryItems('controls')),
    section('POWER & PLAYBACK', 'SETUP · POWER & PLAYBACK', powerItems),
    { label: 'EDIT ON PHONE OR COMPUTER', run: () => openHandoff() },
  ];
}

