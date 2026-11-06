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
import { SETTINGS } from '../core/settings-registry.js';

// The fields come from the settings registry (core/settings-registry.js, the
// `fit: true` entries), in the shape this file has always used.
const FIT_FIELDS = SETTINGS.filter((entry) => entry.fit).map((entry) => ({
  key: entry.path[1],
  label: entry.label,
  type: entry.type === 'switch' ? 'checkbox' : entry.type === 'choice' ? 'select' : entry.type,
  options: entry.choices,
  ...(entry.range || {}),
  help: entry.help,
  synonyms: entry.synonyms ? entry.synonyms.replace(/^fit time slots ?/, '') : '',
  credits: entry.home === 'programming/credits',
}));

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

function buildBoxRows(host, creditsHost) {
  const enabledEl = document.createElement('input');
  enabledEl.type = 'checkbox';
  enabledEl.id = BOX_ENABLED_ID;
  enabledEl.addEventListener('change', () => {
    dispatch({ type: 'settings.set', path: ['programFit', 'enabled'], value: enabledEl.checked });
    syncSettingDependencies(host);
    if (creditsHost) syncSettingDependencies(creditsHost);
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
    (field.credits && creditsHost ? creditsHost : host).appendChild(SettingRow({
      key: `program-fit-${field.key}`, label: field.label, control: withUnit(field, el), help: field.help || '',
      dependsOn: BOX_ENABLED_ID, synonyms: `fit time slots ${field.synonyms || ''}`.trim(),
    }));
  });
  boxRowsBuilt = true;
}

export function renderProgramFitPanel() {
  const host = document.getElementById('program-fit-rows');
  if (!host) return;
  // BREAKS › END CREDITS holds the credits fields (docs/design/14 §4).
  const creditsHost = document.getElementById('program-credits-rows');
  if (!boxRowsBuilt) buildBoxRows(host, creditsHost);
  const box = boxSettings();
  boxControls.get('enabled').checked = !!box.enabled;
  FIT_FIELDS.forEach((field) => {
    const el = boxControls.get(field.key);
    const value = box[field.key] != null ? box[field.key] : FIT_DEFAULTS[field.key];
    if (field.type === 'checkbox') el.checked = value !== false;
    else el.value = String(value);
  });
  syncSettingDependencies(host);
  if (creditsHost) syncSettingDependencies(creditsHost);
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
  let entries;
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
