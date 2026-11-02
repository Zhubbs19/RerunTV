(function initUpdateProgress() {
  const title = document.getElementById('update-progress-title');
  const detail = document.getElementById('update-progress-detail');
  const fill = document.getElementById('update-progress-fill');
  const percent = document.getElementById('update-progress-percent');
  const track = document.querySelector('.update-track');
  const fixedText = Array.from(document.querySelectorAll('[data-cg-text]'));
  fixedText.forEach((el) => { el.dataset.legacyText = el.textContent; });
  let lastState = {};

  // The cable-guide skins write titles in title case, not capitals
  // ("PREPARING UPDATE" -> "Preparing Update"); the app's own name keeps its
  // spelling.
  const cableGuide = () => document.documentElement.dataset.ui === 'cable-guide';
  function label(text) {
    if (!cableGuide()) return text;
    return String(text).toLowerCase()
      .replace(/(^|[\s(/-])([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase())
      .replace(/\bReruntv\b/g, 'RerunTV');
  }

  function apply(state) {
    lastState = state || {};
    const value = Math.max(0, Math.min(100, Number(state.percent) || 0));
    document.body.classList.toggle('is-indeterminate', !!state.indeterminate);
    document.body.classList.toggle('is-complete', state.kind === 'complete');
    document.body.classList.toggle('is-error', state.kind === 'error');
    title.textContent = label(state.title || 'UPDATING RERUNTV');
    detail.textContent = state.detail || 'Getting the next broadcast ready…';
    fill.style.width = `${value}%`;
    percent.textContent = state.indeterminate ? label('WORKING…') : `${Math.round(value)}%`;
    track.setAttribute('aria-valuenow', String(Math.round(value)));
    if (state.indeterminate) track.removeAttribute('aria-valuenow');
  }

  // Reskins the window to the app's active theme (themes.js reports the
  // resolved --ink/--gold/--cyan/etc custom properties — core's palette
  // contract every theme pack overrides — on every theme change;
  // main-updater.js caches the latest report and resends it as soon as this
  // window finishes loading). `colors` is a plain {cssVarName: value} map;
  // any name it omits falls back to the CSS default (update-progress.css
  // :root), same names so no translation is needed here.
  const THEME_VARS = [
    '--ink', '--ink-deep', '--gold', '--cyan', '--paper', '--paper-dim', '--line',
    '--gradient-page', '--gradient-panel',
    '--cg-font', '--cg-weight', '--cg-weight-strong', '--cg-text', '--cg-text-dim', '--cg-hilite',
    '--cg-text-shadow', '--cg-dialog', '--cg-dialog-rim', '--cg-radius', '--cg-focus', '--cg-focus-sheen',
    '--cg-sheen', '--cg-lift',
  ];
  function applyTheme(colors) {
    const root = document.documentElement.style;
    THEME_VARS.forEach((name) => {
      const value = colors && colors[name];
      if (value) root.setProperty(name, value);
      else root.removeProperty(name);
    });
    // A cable-guide skin reports its layout and its dialog tokens; anything
    // else keeps this window's own look.
    const layout = colors && colors['--guide-layout'];
    const html = document.documentElement;
    if (layout && colors['--cg-dialog']) {
      html.dataset.ui = 'cable-guide';
      html.dataset.guideLayout = layout;
    } else {
      delete html.dataset.ui;
      delete html.dataset.guideLayout;
    }
    fixedText.forEach((el) => { el.textContent = cableGuide() ? el.dataset.cgText : el.dataset.legacyText; });
    apply(lastState);
  }

  window.updateProgress.onState(apply);
  window.updateProgress.onTheme(applyTheme);
}());
