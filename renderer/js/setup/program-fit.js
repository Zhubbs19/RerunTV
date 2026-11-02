// Fit to time slots settings (core/fit.js).
//   - renderProgramFitPanel: the box-wide defaults, PROGRAMMING › CADENCE &
//     PRESETS › FIT TO TIME SLOTS (S.config.programFit, settings.set).
//   - buildProgramFitChannelPanel: a channel's own BREAKS › FIT TO TIME SLOTS
//     page (ch.programFit). Every field can follow the box or be set here.
// Both are built from FIT_FIELDS, so a new setting is one entry in that table.
import { S, dispatch, viewNow } from '../core/state.js';
import { FIT_DEFAULTS, fitConfigFor } from '../core/fit.js';
import { getChannelSchedule } from '../core/schedule.js';
import { SettingRow, syncSettingDependencies } from '../ui/field.js';
import { formatClock, getDisplayTitle } from '../core/util.js';
import { commitOwnerFields } from './util.js';

const FIT_FIELDS = [
  {
    key: 'gridMinutes', label: 'Line programs up on', type: 'select',
    options: [[30, 'The half hour (:00 and :30)'], [60, 'The hour (:00)']],
    help: 'Every program ends on one of these boundaries.',
  },
  {
    key: 'strategy', label: 'When a program runs over', type: 'select',
    options: [['auto', 'Shorten or extend, whichever changes it less'], ['extend', 'Always extend to the next boundary'], ['trim', 'Shorten whenever the limits allow']],
    help: 'Shortening speeds up the end credits first, then plays the program slightly fast. Extending turns the spare time into breaks.',
    synonyms: 'trim cut extend pad round',
  },
  { key: 'maxTrimMinutes', label: 'Shorten by at most', type: 'number', unit: 'min', min: 0, max: 30, step: 0.5, help: 'A program that would need more is extended instead.' },
  {
    key: 'maxSpeedupPct', label: 'Play a program faster by at most', type: 'number', unit: '%', min: 0, max: 10, step: 0.5,
    help: 'Stations ran shows a few percent fast to fit them in. Above 5% voices start to sound rushed.', synonyms: 'time compression speed',
  },
  { key: 'minBreakMinutesPerHalfHour', label: 'Break time per half hour, at least', type: 'number', unit: 'min', min: 0, max: 15, step: 0.5, help: 'Reserved for ads in every slot. 0 uses only the time left over.' },
  { key: 'breakPlacement', label: 'Put breaks', type: 'select', options: [['spread', 'Through the program'], ['end', 'All at the end']] },
  { key: 'breaksPerHalfHour', label: 'Breaks per half hour', type: 'number', min: 1, max: 6, step: 1, help: 'When breaks go through the program. Each is at least a minute long.' },
  { key: 'minProgramMinutes', label: 'Group clips shorter than', type: 'number', unit: 'min', min: 0, max: 60, step: 1, help: 'Short clips play back to back, and the next full program ends on the boundary.' },
  {
    key: 'fill', label: 'Fill breaks with', type: 'select',
    options: [['pool', 'Ads and bumpers from the pool'], ['placeholders', 'Placeholder slots only']],
    help: 'Placeholder slots mark where each commercial and bumper would go.', synonyms: 'commercials bumpers filler',
  },
  { key: 'placeholders', label: 'Show placeholder slots', type: 'checkbox', help: 'Where the pool runs out, a card marks each commercial or bumper slot. Off shows one “We’ll be right back” card.' },
  { key: 'placeholderSpotSeconds', label: 'Placeholder commercial length', type: 'number', unit: 's', min: 5, max: 120, step: 1 },
  { key: 'placeholderBumperSeconds', label: 'Placeholder bumper length', type: 'number', unit: 's', min: 0, max: 30, step: 1 },
  { key: 'bumpers', label: 'Bumpers around each break', type: 'checkbox', help: 'A bump-in and bump-out from the pool, or a placeholder for each.' },
  { key: 'disclaimer', label: 'Show the formatted-for-television card', type: 'checkbox', help: 'At the start of any program that was shortened to fit.', synonyms: 'modified edited disclaimer' },
  { key: 'disclaimerText', label: 'Card text', type: 'text', help: 'Blank uses the standard wording.' },
  {
    key: 'creditsApplies', label: 'Speed up end credits', type: 'select',
    options: [['fit', 'Only when a program needs the time'], ['always', 'Always'], ['movies', 'Movies only'], ['never', 'Never']],
    help: 'A channel’s own END CREDITS settings take over when they are on.', synonyms: 'credits squeeze fast forward',
  },
  { key: 'creditsRate', label: 'Credits speed', type: 'number', unit: '×', min: 1, max: 8, step: 0.5 },
  { key: 'creditsLeadSeconds', label: 'Credits length', type: 'number', unit: 's', min: 0, max: 1200, step: 5, help: 'For titles that don’t set their own in the TITLES tab.' },
  { key: 'creditsMaxSqueezeSeconds', label: 'Credits save at most', type: 'number', unit: 's', min: 0, max: 1800, step: 5 },
  {
    key: 'creditsLayout', label: 'While credits run fast', type: 'select',
    options: [['side', 'Credits left, up next on the right'], ['right', 'Credits right, up next on the left'], ['corner', 'Credits in the corner, up next below'], ['banner', 'Credits full screen, up next banner']],
    help: 'The squeeze-back networks use to promote what airs next. Every channel with sped-up credits uses it unless its END CREDITS panel picks another.',
    synonyms: 'squeeze back split screen credits up next promo',
  },
];

function optionLabel(field, value) {
  const hit = (field.options || []).find(([v]) => String(v) === String(value));
  if (hit) return hit[1];
  if (field.type === 'checkbox') return value ? 'On' : 'Off';
  if (field.type === 'text') return value ? `“${value}”` : 'standard';
  return `${value}${field.unit ? ` ${field.unit}` : ''}`;
}

function readControl(field, el) {
  if (field.type === 'checkbox') return el.checked;
  if (field.type === 'number') {
    const n = Number(el.value);
    if (el.value.trim() === '' || !Number.isFinite(n)) return undefined;
    return Math.min(field.max, Math.max(field.min, n));
  }
  if (field.type === 'select' && field.key === 'gridMinutes') return Number(el.value);
  return el.value;
}

function makeControl(field, id) {
  let el;
  if (field.type === 'select') {
    el = document.createElement('select');
    field.options.forEach(([value, label]) => el.appendChild(new Option(label, String(value))));
  } else {
    el = document.createElement('input');
    el.type = field.type === 'number' ? 'number' : field.type;
    if (field.type === 'number') Object.assign(el, { min: field.min, max: field.max, step: field.step });
  }
  el.id = id;
  return el;
}

function withUnit(field, el) {
  if (!field.unit) return el;
  const unit = document.createElement('span');
  unit.className = 'setting-row-unit';
  unit.textContent = field.unit;
  return [el, unit];
}

// ---------- Box-wide panel ----------
const BOX_ENABLED_ID = 'program-fit-enabled';
const boxControls = new Map();
let boxRowsBuilt = false;

function boxSettings() {
  return (S.config && S.config.programFit) || {};
}

function buildBoxRows(host) {
  const enabledEl = document.createElement('input');
  enabledEl.type = 'checkbox';
  enabledEl.id = BOX_ENABLED_ID;
  enabledEl.addEventListener('change', () => {
    dispatch({ type: 'settings.set', path: ['programFit', 'enabled'], value: enabledEl.checked });
    syncSettingDependencies(host);
  });
  boxControls.set('enabled', enabledEl);
  host.appendChild(SettingRow({
    key: 'program-fit-enabled',
    label: 'Fit programs to time slots',
    control: enabledEl,
    help: 'Every program ends on the next :00 or :30. One that runs a little over is shortened (credits sped up, then played slightly fast, within the limits below); anything else is extended and the spare time becomes breaks. Channels can opt in or out under BREAKS.',
    synonyms: 'formatted for television time slot half hour hour boundary fit trim extend align schedule',
  }));
  FIT_FIELDS.forEach((field) => {
    const el = makeControl(field, `program-fit-${field.key}`);
    el.addEventListener('change', () => {
      const value = readControl(field, el);
      dispatch({ type: 'settings.set', path: ['programFit', field.key], value: value === undefined ? FIT_DEFAULTS[field.key] : value });
      if (value === undefined) el.value = FIT_DEFAULTS[field.key];
    });
    boxControls.set(field.key, el);
    host.appendChild(SettingRow({
      key: `program-fit-${field.key}`, label: field.label, control: withUnit(field, el), help: field.help || '',
      dependsOn: BOX_ENABLED_ID, synonyms: `fit time slots ${field.synonyms || ''}`.trim(),
    }));
  });
  boxRowsBuilt = true;
}

export function renderProgramFitPanel() {
  const host = document.getElementById('program-fit-rows');
  if (!host) return;
  if (!boxRowsBuilt) buildBoxRows(host);
  const box = boxSettings();
  boxControls.get('enabled').checked = !!box.enabled;
  FIT_FIELDS.forEach((field) => {
    const el = boxControls.get(field.key);
    const value = box[field.key] != null ? box[field.key] : FIT_DEFAULTS[field.key];
    if (field.type === 'checkbox') el.checked = value !== false;
    else el.value = String(value);
  });
  syncSettingDependencies(host);
}

// ---------- Per-channel panel ----------
// The next few programs as they air with the channel's fit, so the effect of
// a setting is visible before tuning in.
function previewList(ch) {
  const wrap = document.createElement('div');
  wrap.className = 'panel-status';
  const cfg = fitConfigFor(ch);
  if (!cfg) {
    wrap.textContent = 'Programs on this channel air at their own length.';
    return wrap;
  }
  const now = viewNow();
  let entries = [];
  try { entries = getChannelSchedule(ch, now, now + 8 * 3600000).slice(0, 8); } catch (e) { entries = []; }
  if (!entries.length) {
    wrap.textContent = 'Nothing scheduled to preview.';
    return wrap;
  }
  const list = document.createElement('ul');
  list.className = 'program-fit-preview';
  entries.forEach((e) => {
    const plan = e.file.fit;
    const start = e.start;
    const end = start + e.file.duration * 1000;
    let note = 'plays as is';
    if (plan && plan.trimmed) note = `shortened by ${Math.round(plan.savedS)} s`;
    else if (plan && plan.breakS >= 1) note = `${Math.round(plan.breakS / 60)} min of breaks`;
    else if (plan) note = 'fits exactly';
    const li = document.createElement('li');
    li.textContent = `${formatClock(new Date(start))}–${formatClock(new Date(end))}  ${getDisplayTitle(e.file)} · ${note}`;
    list.appendChild(li);
  });
  wrap.appendChild(list);
  return wrap;
}

export function buildProgramFitChannelPanel(ch, panelEl) {
  const save = () => commitOwnerFields(ch, ['programFit']);
  function render() {
    panelEl.innerHTML = '';
    if (!ch.programFit) ch.programFit = {};
    const own = ch.programFit;
    const box = boxSettings();
    const boxValue = (key) => (box[key] != null ? box[key] : FIT_DEFAULTS[key]);
    const rows = document.createElement('div');
    rows.className = 'setting-rows';

    const modeEl = document.createElement('select');
    modeEl.id = `ch-fit-mode-${ch.number}`;
    [['', `Box default (${box.enabled ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']].forEach(([v, l]) => modeEl.appendChild(new Option(l, v)));
    modeEl.value = own.mode === 'on' || own.mode === 'off' ? own.mode : '';
    modeEl.addEventListener('change', () => {
      if (modeEl.value) own.mode = modeEl.value; else delete own.mode;
      save();
      render();
    });
    rows.appendChild(SettingRow({
      key: 'channel-program-fit', label: 'Fit programs to time slots', control: modeEl,
      help: 'Each program ends on the next :00 or :30: shortened a little if it runs just over, otherwise extended with breaks. The box-wide limits are under PROGRAMMING › CADENCE & PRESETS.',
      synonyms: 'formatted for television time slot half hour fit trim extend',
    }));

    const active = !!fitConfigFor(ch);
    FIT_FIELDS.forEach((field) => {
      const id = `ch-fit-${field.key}-${ch.number}`;
      let el;
      const inherited = `Box default (${optionLabel(field, boxValue(field.key))})`;
      if (field.type === 'checkbox' || field.type === 'select') {
        el = document.createElement('select');
        el.id = id;
        el.appendChild(new Option(inherited, ''));
        const opts = field.type === 'checkbox' ? [['on', 'On'], ['off', 'Off']] : field.options;
        opts.forEach(([v, l]) => el.appendChild(new Option(l, String(v))));
        const cur = own[field.key];
        el.value = cur == null ? '' : field.type === 'checkbox' ? (cur ? 'on' : 'off') : String(cur);
      } else {
        el = makeControl(field, id);
        el.placeholder = field.type === 'text' ? 'Box default' : String(boxValue(field.key));
        el.value = own[field.key] != null ? String(own[field.key]) : '';
      }
      el.disabled = !active;
      el.addEventListener('change', () => {
        let value;
        if (field.type === 'checkbox') value = el.value === '' ? undefined : el.value === 'on';
        else if (field.type === 'select') value = el.value === '' ? undefined : (field.key === 'gridMinutes' ? Number(el.value) : el.value);
        else if (field.type === 'text') value = el.value.trim() === '' ? undefined : el.value.trim();
        else value = readControl(field, el);
        if (value === undefined) delete own[field.key]; else own[field.key] = value;
        save();
        render();
      });
      const row = SettingRow({ key: `channel-program-fit-${field.key}`, label: field.label, control: withUnit(field, el), help: field.help || '' });
      if (!active) row.classList.add('is-disabled');
      rows.appendChild(row);
    });
    panelEl.appendChild(rows);
    panelEl.appendChild(previewList(ch));
  }
  render();
}
