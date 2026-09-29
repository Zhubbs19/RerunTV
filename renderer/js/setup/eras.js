// ERA panel (docs/design/10 §6, Guide & theme tab): pick a decade and the
// theme, CRT look, display mode and clock follow together in one undo step.
// The actual apply/clear/override logic is pure (renderer/js/display/eras.js,
// tested directly) — this file only renders it and makes the visual
// subsystems (theme, CRT, display mode) pick the new config up immediately.
import { S, commitConfigPatch, onHistoryChange } from '../core/state.js';
import {
  applyEra, clearEra, eraFieldLabel, eraFieldSource, listEras, resetEraField,
} from '../display/eras.js';
import { applyTheme } from '../display/themes.js';
import { applyCrtState } from '../playback/power.js';
import { applyDisplayMode } from '../display/mode.js';

const pickerEl = document.getElementById('era-picker');
const notesEl = document.getElementById('era-notes');
const fieldsEl = document.getElementById('era-fields-list');

function applyVisualSubsystems() {
  applyTheme();
  applyCrtState();
  applyDisplayMode();
  // Era-apply writes config.theme/crtEnabled/crtIntensity/displayMode/
  // display.clock24 directly rather than through their own setup-screen
  // input handlers, so those controls (theme select, CRT sliders, display
  // mode selects, the clock checkbox — all owned by settings.js) need a
  // nudge to resync their displayed values. Same cross-module idiom as
  // 'reruntv:plugin-attention' (sidebar.js): a DOM event instead of an
  // import, since settings.js already imports this module.
  window.dispatchEvent(new Event('reruntv:era-applied'));
}

function button(label, run, { active = false, className = 'btn' } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = active ? `${className} active` : className;
  el.textContent = label;
  el.addEventListener('click', run);
  return el;
}

export function renderEraPanel() {
  if (!pickerEl) return;
  const active = S.config.era;
  pickerEl.innerHTML = '';
  listEras().forEach((era) => {
    pickerEl.appendChild(button(era.label.toUpperCase(), () => {
      applyEra(S.config, era.id);
      commitConfigPatch(`Era: ${era.label}`);
      applyVisualSubsystems();
      renderEraPanel();
    }, { active: active && active.id === era.id }));
  });
  pickerEl.appendChild(button('NO ERA (BOX SETTINGS)', () => {
    clearEra(S.config);
    commitConfigPatch('Clear era');
    applyVisualSubsystems();
    renderEraPanel();
  }, { active: !active }));

  if (notesEl) {
    const era = active && listEras().find((e) => e.id === active.id);
    notesEl.innerHTML = '';
    if (era) {
      const heading = document.createElement('p');
      heading.className = 'setting-row-help';
      heading.textContent = `${era.label} (${era.range[0]}–${era.range[1]})`;
      notesEl.appendChild(heading);
      (era.notes || []).forEach((note) => {
        const p = document.createElement('p');
        p.className = 'setting-row-help';
        p.textContent = note;
        notesEl.appendChild(p);
      });
    } else {
      notesEl.textContent = 'No era selected — picture and guide settings can be adjusted individually.';
    }
  }

  if (fieldsEl) {
    fieldsEl.innerHTML = '';
    if (active) {
      active.fields.forEach((key) => {
        const source = eraFieldSource(S.config, key);
        const row = document.createElement('div'); row.className = 'block-row';
        const label = document.createElement('span'); label.className = 'block-count';
        label.textContent = `${eraFieldLabel(key).toUpperCase()} · ${source === 'override' ? 'BOX OVERRIDE' : `SET BY ERA ${active.id.toUpperCase()}`}`;
        row.appendChild(label);
        if (source === 'override') {
          row.appendChild(button('RESET TO ERA', () => {
            resetEraField(S.config, key);
            commitConfigPatch(`Era: reset ${eraFieldLabel(key)}`);
            applyVisualSubsystems();
            renderEraPanel();
          }));
        }
        fieldsEl.appendChild(row);
      });
    }
  }
}

// A hand-edit anywhere else in setup (the CRT checkbox, a resolution
// select…) reaches an override through commands.js's noteEraOverride, not
// through this module — so it needs its own hook to notice and redraw.
onHistoryChange(renderEraPanel);
