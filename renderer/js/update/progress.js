(function initUpdateProgress() {
  const title = document.getElementById('update-progress-title');
  const detail = document.getElementById('update-progress-detail');
  const fill = document.getElementById('update-progress-fill');
  const percent = document.getElementById('update-progress-percent');
  const track = document.querySelector('.update-track');

  function apply(state) {
    const value = Math.max(0, Math.min(100, Number(state.percent) || 0));
    document.body.classList.toggle('is-indeterminate', !!state.indeterminate);
    document.body.classList.toggle('is-complete', state.kind === 'complete');
    document.body.classList.toggle('is-error', state.kind === 'error');
    title.textContent = state.title || 'UPDATING RERUNTV';
    detail.textContent = state.detail || 'Getting the next broadcast ready…';
    fill.style.width = `${value}%`;
    percent.textContent = state.indeterminate ? 'WORKING…' : `${Math.round(value)}%`;
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
  ];
  function applyTheme(colors) {
    const root = document.documentElement.style;
    THEME_VARS.forEach((name) => {
      const value = colors && colors[name];
      if (value) root.setProperty(name, value);
      else root.removeProperty(name);
    });
  }

  window.updateProgress.onState(apply);
  window.updateProgress.onTheme(applyTheme);
}());
