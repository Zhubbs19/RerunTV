// Field and SettingRow (docs/design/04 §3; SettingRow is docs/design/03 §5.1).
//
// A SettingRow is a short sentence-case label, its control, and an optional
// one-line help text; a longer explanation, when there is one, rides on the
// row's title. Static pages write the markup directly (renderer/index.html);
// code that builds settings at runtime uses SettingRow().
//
//   <div class="setting-row" data-setting="clock24" data-synonyms="time format"
//        data-depends-on="some-checkbox-id">
//     <label class="setting-row-label" for="clock24-enabled">24-hour clock</label>
//     <div class="setting-row-control"><input type="checkbox" id="clock24-enabled"></div>
//     <p class="setting-row-help">Show 18:30 instead of 6:30 PM.</p>
//   </div>
//
// data-setting is the row's stable search id; data-synonyms adds search words
// that aren't in the label. A row with data-depends-on="<checkbox id>" is
// disabled — never hidden — while that checkbox is off.
import { h, nextId } from './kit-core.js';

const LABELLABLE = /^(INPUT|SELECT|TEXTAREA)$/;

function firstLabellable(controls) {
  for (const el of controls) {
    if (!el) continue;
    if (LABELLABLE.test(el.tagName)) return el;
    const inner = el.querySelector && el.querySelector('input, select, textarea');
    if (inner) return inner;
  }
  return null;
}

// Field({ label, help, control, error }) → element with setError(text).
export function Field({ label, help = '', control, error = '', className = '' } = {}) {
  const controls = Array.isArray(control) ? control : [control];
  const target = firstLabellable(controls);
  if (target && !target.id) target.id = nextId('field');
  const labelEl = target ? h('label', { className: 'field-label', text: label, htmlFor: target.id }) : h('span', { className: 'field-label', text: label });
  const wrap = h('div', { className: ['field', className].filter(Boolean).join(' ') }, labelEl, h('div', { className: 'field-control' }, controls.filter(Boolean)));
  let helpEl = null;
  if (help) {
    helpEl = h('p', { className: 'field-help', text: help, id: nextId('field-help') });
    wrap.appendChild(helpEl);
    if (target) target.setAttribute('aria-describedby', helpEl.id);
  }
  const errorEl = h('p', { className: 'field-error', id: nextId('field-error'), attrs: { role: 'alert' } });
  errorEl.hidden = true;
  wrap.appendChild(errorEl);
  wrap.setError = (text) => {
    errorEl.textContent = text || '';
    errorEl.hidden = !text;
    wrap.classList.toggle('has-error', !!text);
    if (target) {
      if (text) target.setAttribute('aria-invalid', 'true'); else target.removeAttribute('aria-invalid');
      const described = [helpEl && helpEl.id, text && errorEl.id].filter(Boolean).join(' ');
      if (described) target.setAttribute('aria-describedby', described); else target.removeAttribute('aria-describedby');
    }
  };
  if (error) wrap.setError(error);
  return wrap;
}

export function SettingRow({ key, label, control, help = '', title = '', dependsOn = '', synonyms = '', searchId } = {}) {
  const row = h('div', { className: 'setting-row' });
  if (key || searchId) row.dataset.setting = key || searchId;
  if (dependsOn) row.dataset.dependsOn = dependsOn;
  if (synonyms) row.dataset.synonyms = synonyms;
  if (title) row.title = title;

  const controls = (Array.isArray(control) ? control : [control]).filter(Boolean);
  const target = firstLabellable(controls);
  let labelEl;
  if (target) {
    if (!target.id) target.id = nextId('setting-row-control');
    labelEl = h('label', { htmlFor: target.id });
  } else {
    labelEl = h('span');
  }
  labelEl.className = 'setting-row-label';
  labelEl.textContent = label;
  row.append(labelEl, h('div', { className: 'setting-row-control' }, controls));
  if (help) row.appendChild(h('p', { className: 'setting-row-help', text: help }));
  return row;
}

// Disables every row whose parent switch is off. Cheap enough to run on any
// change: a few dozen rows.
export function syncSettingDependencies(root = document) {
  root.querySelectorAll('.setting-row[data-depends-on]').forEach((row) => {
    const parent = document.getElementById(row.dataset.dependsOn);
    const enabled = !parent || !!parent.checked;
    row.classList.toggle('is-disabled', !enabled);
    row.querySelectorAll('.setting-row-control input, .setting-row-control select, .setting-row-control textarea, .setting-row-control button')
      .forEach((control) => { control.disabled = !enabled; });
  });
}

// One listener for every row on the page: any checkbox change re-checks the
// rows that depend on it.
let installed = false;
export function installSettingDependencies(root = document) {
  if (installed) return;
  installed = true;
  root.addEventListener('change', (event) => {
    if (event.target && event.target.type === 'checkbox') syncSettingDependencies(root);
  });
  syncSettingDependencies(root);
}

// What settings search needs to know about a row.
export function settingRowSearchText(row) {
  const label = row.querySelector('.setting-row-label');
  const help = row.querySelector('.setting-row-help');
  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  return {
    key: row.dataset.setting || '',
    label: clean(label && label.textContent),
    help: clean(help && help.textContent),
    haystack: clean([label && label.textContent, help && help.textContent, row.dataset.synonyms, row.title].join(' ')).toLowerCase(),
  };
}

export function settingRowControl(row) {
  return row.querySelector('.setting-row-control input:not([type="hidden"]):not([tabindex="-1"]), .setting-row-control select:not([tabindex="-1"]), .setting-row-control textarea, .setting-row-control button');
}
