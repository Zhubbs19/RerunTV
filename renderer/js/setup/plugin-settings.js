// Composes core/plugin settings sections and contains failures so one broken
// plugin section cannot blank the rest of the PLUGINS tab.
import { applyDisplayMode, CHANNEL_DISPLAY_ASPECT_OPTIONS, CHANNEL_RESOLUTION_OPTIONS } from '../display/mode.js';
import { applyTheme } from '../display/themes.js';
import {
  getPluginChannelDisplaySettings, getPluginSettings, getRedactedPluginSettings,
  updatePluginChannelDisplaySettings, updatePluginSettings,
} from '../plugin/host.js';
import { S, commitInPlace, saveConfigDebounced } from '../core/state.js';
import { coerceFieldValue, readSettingPath, settingPathPatch } from '../plugin/settings-schema.js';
import { NumberStepper, Select, Slider, Toggle } from '../ui/controls.js';
import { SettingRow, syncSettingDependencies } from '../ui/field.js';
import { h } from '../ui/kit-core.js';

// ---------- Declarative fields (docs/design/04 §5) ----------
// A section's fields become SettingRows of kit controls. Each change writes
// one dotted path through updatePluginSettings, so the plugin's validate()
// still gates every write; a rejected value shows under its row and the
// control goes back to the saved value.
function fieldControl(field, value, onValue, id) {
  if (field.type === 'toggle') return Toggle({ id, checked: !!value, onChange: onValue });
  if (field.type === 'slider') {
    const slider = Slider({ id, min: field.min, max: field.max, step: field.step, value, format: (v) => `${v}${field.unit}`, onChange: onValue, label: field.label });
    return slider;
  }
  if (field.type === 'number') return NumberStepper({ id, value, min: field.min, max: field.max, step: field.step, onChange: onValue, label: field.label });
  if (field.type === 'select') return Select({ id, options: field.options, value, onChange: (v) => onValue(coerceFieldValue(field, v)) });
  const input = h('input', { type: field.type === 'color' ? 'color' : 'text', value: value == null ? '' : String(value), className: 'title-row-input', placeholder: field.placeholder || '' });
  input.id = id;
  input.addEventListener('change', () => onValue(input.value));
  return input;
}

function renderFieldsSection(target, pluginId, section, errors = {}) {
  target.innerHTML = '';
  const idFor = (key) => `plugin-${pluginId}-${key.replace(/\./g, '-')}`;
  section.fields.forEach((field) => {
    const settings = getPluginSettings(pluginId);
    const value = coerceFieldValue(field, readSettingPath(settings, field.key));
    const id = idFor(field.key);
    const error = h('p', { className: 'setting-row-error', attrs: { role: 'alert' }, text: errors[field.key] || '' });
    error.hidden = !errors[field.key];
    const onValue = (next) => {
      try {
        updatePluginSettings(pluginId, settingPathPatch(getPluginSettings(pluginId), field.key, coerceFieldValue(field, next)));
        error.hidden = true;
        row.classList.remove('has-error');
        syncSettingDependencies(target);
      } catch (e) {
        // Rejected: redraw from what's saved, with the reason under this row.
        const message = e && e.message ? e.message.replace(/^.*settings are invalid: /, '') : String(e);
        renderFieldsSection(target, pluginId, section, { [field.key]: message });
      }
    };
    const row = SettingRow({
      key: `${pluginId}.${field.key}`,
      label: field.label,
      help: field.help,
      synonyms: field.synonyms,
      dependsOn: field.dependsOn ? idFor(field.dependsOn) : '',
      control: fieldControl(field, value, onValue, id),
    });
    row.classList.toggle('has-error', !!errors[field.key]);
    row.appendChild(error);
    target.appendChild(row);
  });
  syncSettingDependencies(target);
}

function appendSelectOptions(select, options) {
  options.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
}

// Exported for reuse by setup-channels.js's PLUGIN CHANNELS section (the
// same RESOLUTION/DISPLAY ASPECT override UI a channel-type plugin already
// gets in its own PLUGINS-tab row, surfaced again next to the plugin's
// name/number override there so both live together in the channel list).
export function renderChannelDisplaySettings(container, pluginId, channelDefinition) {
  const values = getPluginChannelDisplaySettings(pluginId, channelDefinition);
  container.innerHTML = `
    <label class="panel-toggle" style="cursor:default;">CHANNEL DISPLAY</label>
    <span class="panel-status">Overrides apply only while this plugin channel is tuned. INHERIT uses the box-wide display setting.</span>
    <div class="panel-interval">RESOLUTION OVERRIDE<select data-el="resolution" class="title-row-input"></select></div>
    <div class="panel-interval">DISPLAY ASPECT OVERRIDE<select data-el="aspect" class="title-row-input"></select></div>
  `;
  const resolutionEl = container.querySelector('[data-el="resolution"]');
  const aspectEl = container.querySelector('[data-el="aspect"]');
  appendSelectOptions(resolutionEl, CHANNEL_RESOLUTION_OPTIONS);
  appendSelectOptions(aspectEl, CHANNEL_DISPLAY_ASPECT_OPTIONS);
  resolutionEl.value = values.resolutionOverride || '';
  aspectEl.value = values.displayAspectOverride || '';
  resolutionEl.addEventListener('change', () => {
    updatePluginChannelDisplaySettings(pluginId, { resolutionOverride: resolutionEl.value || null });
    applyDisplayMode();
  });
  aspectEl.addEventListener('change', () => {
    updatePluginChannelDisplaySettings(pluginId, { displayAspectOverride: aspectEl.value || null });
    applyDisplayMode();
  });
}

// Every option here is either a font this app already bundles as a local
// woff2 (tokens.css) — so picking it never triggers a network fetch, per the
// app's offline-first rule — or a generic OS-installed stack. The bundled
// faces are listed first since they're the ones that actually look
// distinctive against a theme's chrome; the generic stacks after them are
// for someone who just wants plainer/more legible text than a stylized
// theme's own default.
export const THEME_FONT_OPTIONS = [
  { value: '', label: 'THEME DEFAULT' },
  { value: "'Archivo Black', sans-serif", label: 'BOLD DISPLAY (ARCHIVO BLACK)' },
  { value: "'Barlow', sans-serif", label: 'CLEAN GROTESK (BARLOW)' },
  { value: "'Barlow Condensed', sans-serif", label: 'CONDENSED GROTESK (BARLOW CONDENSED)' },
  { value: "'Archivo Narrow', sans-serif", label: 'NARROW GROTESK — REAL GUIDE FACE (ARCHIVO NARROW)' },
  { value: "'Fjalla One', sans-serif", label: 'CONDENSED DISPLAY (FJALLA ONE)' },
  { value: "'IBM Plex Mono', monospace", label: 'TECHNICAL MONOSPACE (IBM PLEX MONO)' },
  { value: "'VT323', monospace", label: 'TELETEXT / CHARACTER GENERATOR (VT323)' },
  { value: "'Monoton', cursive", label: 'NEON TUBE — DISPLAY SIZES ONLY (MONOTON)' },
  { value: "'Comfortaa', sans-serif", label: 'ROUNDED SANS (COMFORTAA)' },
  { value: "system-ui, 'Segoe UI', sans-serif", label: 'SYSTEM SANS' },
  { value: "Verdana, Tahoma, system-ui, sans-serif", label: 'HUMANIST SANS' },
  { value: "'Arial Narrow', 'Roboto Condensed', sans-serif", label: 'CONDENSED SANS' },
  { value: "Arial, Helvetica, sans-serif", label: 'CLASSIC SANS' },
  { value: "ui-monospace, 'Cascadia Mono', Consolas, monospace", label: 'SYSTEM MONOSPACE' },
  { value: "Georgia, 'Times New Roman', serif", label: 'SERIF' },
];

export function renderThemeFontSettings(container, themeId) {
  if (!S.config.display.themeFontOverrides) S.config.display.themeFontOverrides = {};
  const values = S.config.display.themeFontOverrides[themeId] || {};
  container.innerHTML = `
    <label class="panel-toggle" style="cursor:default;">THEME TYPOGRAPHY</label>
    <span class="panel-status">Override this theme's typography without changing its colors or layout. THEME DEFAULT restores the plugin's intended font.</span>
    <div class="theme-font-settings-grid">
      <div class="panel-interval">DISPLAY / NUMBERS<select data-font-role="display"></select></div>
      <div class="panel-interval">BUTTONS / GUIDE<select data-font-role="ui"></select></div>
      <div class="panel-interval">BODY / DESCRIPTIONS<select data-font-role="body"></select></div>
    </div>
    <button type="button" class="btn" data-el="reset-fonts">RESET TYPOGRAPHY</button>
  `;
  container.querySelectorAll('[data-font-role]').forEach((select) => {
    appendSelectOptions(select, THEME_FONT_OPTIONS);
    const role = select.dataset.fontRole;
    select.value = values[role] || '';
    select.addEventListener('change', () => {
      const next = { ...(S.config.display.themeFontOverrides[themeId] || {}) };
      if (select.value) next[role] = select.value;
      else delete next[role];
      if (Object.keys(next).length) S.config.display.themeFontOverrides[themeId] = next;
      else delete S.config.display.themeFontOverrides[themeId];
      applyTheme();
      commitInPlace({ type: 'settings.set', path: ['display','themeFontOverrides'], value: S.config.display.themeFontOverrides });
    });
  });
  container.querySelector('[data-el="reset-fonts"]').addEventListener('click', () => {
    delete S.config.display.themeFontOverrides[themeId];
    applyTheme();
    commitInPlace({ type: 'settings.set', path: ['display','themeFontOverrides'], value: S.config.display.themeFontOverrides }, { label: 'Reset theme fonts' });
    renderThemeFontSettings(container, themeId);
  });
}

export function renderPluginSettings(container, plugin, channelDefinition, sections) {
  container.innerHTML = '';
  // Plugin CSS scopes itself to [data-plugin="id"]; global selectors are unsupported.
  container.dataset.plugin = plugin.id;
  const makeContext = () => ({
    ui: window.RCBPlugins.ctx.ui,
    S,
    player: window.RCBPlugins.ctx.player,
    saveConfigDebounced,
    selectExecutable: window.api.selectExecutable,
    pluginId: plugin.id,
    settings: getPluginSettings(plugin.id),
    getRedactedPluginSettings,
    updateSettings: (patch) => updatePluginSettings(plugin.id, patch),
  });
  const renderFailure = (target, section, error, retry) => {
    target.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'plugin-settings-failure';
    const title = document.createElement('strong');
    title.textContent = 'SETTINGS SECTION FAILED';
    const details = document.createElement('div');
    details.textContent = `${plugin.id} · ${plugin.settings || plugin.renderer || 'registered settings'} · ${section.id}`;
    const message = document.createElement('div');
    message.className = 'plugin-settings-failure-message';
    message.textContent = error && error.message ? error.message : String(error);
    const guidance = document.createElement('div');
    guidance.textContent = 'Retry this section. If it fails again, restart RerunTV and review the plugin entry point.';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn';
    retryBtn.textContent = 'RETRY SECTION';
    retryBtn.addEventListener('click', retry);
    card.append(title, details, message, guidance, retryBtn);
    target.appendChild(card);
  };
  const renderSection = (target, section) => {
    target.innerHTML = '';
    const fail = (error) => {
      console.error(`[plugin settings ${plugin.id}/${section.id}] render() threw`, error);
      renderFailure(target, section, error, () => renderSection(target, section));
    };
    try {
      if (section.fields && !section.render) { renderFieldsSection(target, plugin.id, section); return; }
      const result = section.render(target, makeContext());
      // An async render rejects rather than throwing, so the catch below
      // never sees it: the section silently rendered nothing and the real
      // error went to an unhandled rejection. Found exactly that way — two
      // broken sections showed as empty gaps while two identically broken
      // synchronous ones showed a failure card.
      if (result && typeof result.then === 'function') result.then(null, fail);
    } catch (error) {
      fail(error);
    }
  };
  if (!channelDefinition && sections.length === 1 && sections[0].legacy) {
    renderSection(container, sections[0]);
    return;
  }
  if (channelDefinition) {
    const channelSection = document.createElement('section');
    channelSection.className = 'plugin-settings-section';
    renderChannelDisplaySettings(channelSection, plugin.id, channelDefinition);
    container.appendChild(channelSection);
  }
  if (plugin.category === 'theme') {
    const fontSection = document.createElement('section');
    fontSection.className = 'plugin-settings-section';
    renderThemeFontSettings(fontSection, plugin.id.replace(/^theme-/, ''));
    container.appendChild(fontSection);
  }
  sections.forEach((section) => {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'plugin-settings-section';
    sectionEl.dataset.layout = section.layout || 'stack';
    sectionEl.dataset.sectionId = section.id;
    if (section.label) {
      const heading = document.createElement('label');
      heading.className = 'panel-toggle';
      heading.style.cursor = 'default';
      heading.textContent = section.label;
      sectionEl.appendChild(heading);
    }
    const content = document.createElement('div');
    content.className = 'plugin-settings-section-content';
    sectionEl.appendChild(content);
    container.appendChild(sectionEl);
    renderSection(content, section);
  });
}
