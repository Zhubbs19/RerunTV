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

  window.updateProgress.onState(apply);
}());
