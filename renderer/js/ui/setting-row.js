// SettingRow — the one pattern for a single setting (docs/design/03 §5.1,
// docs/design/04's component kit). A row is a short sentence-case label, its
// control, and an optional one-line help text; a longer explanation, when there
// is one, rides on the row's title. Static pages write the markup directly
// (renderer/index.html); code that builds settings at runtime uses SettingRow().
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

let rowCounter = 0;

export function SettingRow({ key, label, control, help = '', title = '', dependsOn = '', synonyms = '' }) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  if (key) row.dataset.setting = key;
  if (dependsOn) row.dataset.dependsOn = dependsOn;
  if (synonyms) row.dataset.synonyms = synonyms;
  if (title) row.title = title;

  const controls = Array.isArray(control) ? control : [control];
  const first = controls.find((el) => el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
  let labelEl;
  if (first) {
    if (!first.id) first.id = `setting-row-control-${++rowCounter}`;
    labelEl = document.createElement('label');
    labelEl.htmlFor = first.id;
  } else {
    labelEl = document.createElement('span');
  }
  labelEl.className = 'setting-row-label';
  labelEl.textContent = label;

  const controlWrap = document.createElement('div');
  controlWrap.className = 'setting-row-control';
  controls.filter(Boolean).forEach((el) => controlWrap.appendChild(el));
  row.append(labelEl, controlWrap);

  if (help) {
    const helpEl = document.createElement('p');
    helpEl.className = 'setting-row-help';
    helpEl.textContent = help;
    row.appendChild(helpEl);
  }
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
