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

  // Reskins the window to the app's active theme pack (themes.js reports its
  // `preview` swatch on every theme change; main-updater.js caches the latest
  // report and resends it as soon as this window finishes loading). `colors`
  // is null when no pack is active or the pack defines no preview, in which
  // case the CSS fallback palette (update-progress.css :root) stands.
  function applyTheme(colors) {
    const root = document.documentElement.style;
    if (colors && colors.background) root.setProperty('--theme-bg', colors.background);
    else root.removeProperty('--theme-bg');
    if (colors && colors.accent) root.setProperty('--theme-accent', colors.accent);
    else root.removeProperty('--theme-accent');
    if (colors && colors.secondary) root.setProperty('--theme-secondary', colors.secondary);
    else root.removeProperty('--theme-secondary');
  }

  window.updateProgress.onState(apply);
  window.updateProgress.onTheme(applyTheme);
}());
