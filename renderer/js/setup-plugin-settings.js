// Composes core/plugin settings sections and contains failures so one broken
// plugin section cannot blank the rest of the PLUGINS tab.
import { applyDisplayMode, CHANNEL_DISPLAY_ASPECT_OPTIONS, CHANNEL_RESOLUTION_OPTIONS } from './display-mode.js';
import { applyTheme } from './themes.js';
import {
  getPluginChannelDisplaySettings, getPluginSettings, getRedactedPluginSettings,
  updatePluginChannelDisplaySettings, updatePluginSettings,
} from './plugins.js';
import { S, saveConfigDebounced } from './state.js';

function appendSelectOptions(select, options) {
  options.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
}

function renderChannelDisplaySettings(container, pluginId, channelDefinition) {
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

const THEME_FONT_OPTIONS = [
  { value: '', label: 'THEME DEFAULT' },
  { value: "system-ui, 'Segoe UI', sans-serif", label: 'SYSTEM SANS' },
  { value: "Verdana, Tahoma, system-ui, sans-serif", label: 'HUMANIST SANS' },
  { value: "'Arial Narrow', 'Roboto Condensed', sans-serif", label: 'CONDENSED SANS' },
  { value: "Arial, Helvetica, sans-serif", label: 'CLASSIC SANS' },
  { value: "ui-monospace, 'Cascadia Mono', Consolas, monospace", label: 'MONOSPACE' },
  { value: "Georgia, 'Times New Roman', serif", label: 'SERIF' },
];

function renderThemeFontSettings(container, plugin) {
  const themeId = plugin.id.replace(/^theme-/, '');
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
      saveConfigDebounced();
    });
  });
  container.querySelector('[data-el="reset-fonts"]').addEventListener('click', () => {
    delete S.config.display.themeFontOverrides[themeId];
    applyTheme();
    saveConfigDebounced();
    renderThemeFontSettings(container, plugin);
  });
}

export function renderPluginSettings(container, plugin, channelDefinition, sections) {
  container.innerHTML = '';
  const makeContext = () => ({
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
    try {
      section.render(target, makeContext());
    } catch (error) {
      console.error(`[plugin settings ${plugin.id}/${section.id}] render() threw`, error);
      renderFailure(target, section, error, () => renderSection(target, section));
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
    renderThemeFontSettings(fontSection, plugin);
    container.appendChild(fontSection);
  }
  sections.forEach((section) => {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'plugin-settings-section';
    sectionEl.dataset.layout = section.layout || 'stack';
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
