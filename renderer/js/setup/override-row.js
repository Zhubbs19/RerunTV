// A channel's or block's own value for a box-wide setting (docs/design/14 §3-4):
// one row built from the settings registry entry, the same everywhere. Its
// control starts on "Box default (value)" (or "Channel setting" for a block),
// and choosing anything else stores the override under the entry's
// `override[level]` key path on the owner; going back to the default deletes it.
import { S } from '../core/state.js';
import { SettingRow } from '../ui/field.js';
import { boxValue, overrideValue, readPath, settingFor, toOverride } from '../core/settings-registry.js';
import { commitOwnerFields } from './util.js';

/**
 * How a setting's value reads in an "inherited" label.
 * @param {object} entry The registry entry.
 * @param {*} value The value.
 * @returns {string} Its display text.
 */
export function displayValue(entry, value) {
  if (entry.type === 'switch') return value ? 'on' : 'off';
  if (entry.choices) {
    const hit = entry.choices.find(([v]) => String(v) === String(value));
    if (hit) return hit[1].toLowerCase();
  }
  if (value == null || value === '') return 'not set';
  const shown = typeof value === 'number' && entry.scale ? value / entry.scale : value;
  return `${shown}${entry.range && entry.range.unit ? ` ${entry.range.unit}` : ''}`;
}

/**
 * Writes an override at a key path inside a channel or block, creating objects along the way;
 * undefined deletes it.
 * @param {object} owner The channel or block config object.
 * @param {string[]} key The path inside `owner`.
 * @param {*} value The value to store, or undefined to remove it.
 */
function writeOverride(owner, key, value) {
  let node = owner;
  for (let i = 0; i < key.length - 1; i += 1) {
    if (node[key[i]] == null || typeof node[key[i]] !== 'object') node[key[i]] = {};
    node = node[key[i]];
  }
  const last = key[key.length - 1];
  if (value === undefined) delete node[last];
  else node[last] = value;
}

/**
 * One override row for `owner` (a channel or a block).
 * @param {object} entry The registry entry (it must have `override[level]`).
 * @param {object} owner The channel or block config object.
 * @param {object} [opts] Options.
 * @param {string} [opts.level='channel'] 'channel' or 'block'.
 * @param {object} [opts.channel] For a block: its channel, so "Channel setting" can show the channel's value.
 * @param {Function} [opts.onChange] Called after each saved change.
 * @returns {HTMLElement} The SettingRow.
 */
export function OverrideRow(entry, owner, { level = 'channel', channel = null, onChange } = {}) {
  const key = entry.override[level];
  const inherited = level === 'block'
    ? `Channel setting (${displayValue(entry, settingFor(entry, { ch: channel, config: S.config }))})`
    : `Box default (${displayValue(entry, boxValue(entry, S.config))})`;
  const own = overrideValue(entry, owner, level);
  const id = `${level}-${entry.id}-${level === 'block' ? owner.id : owner.number}`;
  let control;
  let read;
  if (entry.type === 'number') {
    control = document.createElement('input');
    control.type = 'number';
    const r = entry.range || {};
    if (r.min != null) control.min = String(r.min);
    if (r.max != null) control.max = String(r.max);
    if (r.step != null) control.step = String(r.step);
    control.placeholder = inherited;
    const scale = entry.scale || 1;
    control.value = own == null ? '' : String(own / scale);
    read = () => {
      if (control.value.trim() === '') return undefined;
      const n = Number(control.value);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(r.max ?? Infinity, Math.max(r.min ?? -Infinity, n)) * scale;
    };
  } else {
    control = document.createElement('select');
    control.appendChild(new Option(inherited, ''));
    const options = entry.type === 'switch' ? [['true', 'On'], ['false', 'Off']] : (entry.choices || []);
    options.forEach(([v, l]) => control.appendChild(new Option(l, String(v))));
    control.value = own == null ? '' : String(own);
    read = () => {
      if (control.value === '') return undefined;
      if (entry.type === 'switch') return control.value === 'true';
      const hit = (entry.choices || []).find(([v]) => String(v) === control.value);
      return hit ? hit[0] : control.value;
    };
  }
  control.id = id;
  control.addEventListener('change', () => {
    const value = read();
    writeOverride(owner, key, value === undefined ? undefined : toOverride(entry, value));
    if (entry.type === 'number') control.value = value === undefined ? '' : String(value / (entry.scale || 1));
    commitOwnerFields(owner, [key[0]]);
    if (onChange) onChange(value);
  });
  const unit = entry.type === 'number' && entry.range && entry.range.unit ? Object.assign(document.createElement('span'), { className: 'setting-row-unit', textContent: entry.range.unit }) : null;
  const row = SettingRow({ key: id, label: entry.label, control: unit ? [control, unit] : control, help: entry.help || '', synonyms: entry.synonyms || '' });
  row.dataset.override = entry.id;
  if (readPath(owner, key) != null) row.classList.add('is-overridden');
  return row;
}
