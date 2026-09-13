// Narrow windows (docs/design/03 §4): below 900 px a list + detail page shows
// the list, and choosing a row swaps to that row's editor with a Back button.
// Wide windows ignore the is-detail-open class entirely (setup.css).
const WRAPPERS = '.channel-master-detail, .list-detail';
const ROWS = '.channel-list-item, .interstitial-card-summary, .flow-list-item, .backup-list-item, .plugin-row';
const SELECTED_ROW = '.channel-list-item.selected, .interstitial-card.selected .interstitial-card-summary, .flow-list-item.selected, .backup-list-item.selected, .plugin-entry.selected .plugin-row';

export function closeNarrowDetail(wrapper, { focusRow = true } = {}) {
  if (!wrapper || !wrapper.classList.contains('is-detail-open')) return;
  wrapper.classList.remove('is-detail-open');
  if (focusRow) wrapper.querySelector(SELECTED_ROW)?.focus();
}

function openFromRow(event) {
  const row = event.target.closest(ROWS);
  if (!row) return;
  // The enable checkbox on a plugin row, drag handles and row buttons keep their own jobs.
  if (event.target.closest('input, select, textarea') || (event.target.closest('button') && !event.target.closest('button').matches(ROWS))) return;
  const wrapper = row.closest(WRAPPERS);
  if (!wrapper || row.closest('.list-detail-detail, .channel-detail-pane')) return;
  wrapper.classList.add('is-detail-open');
}

document.querySelectorAll('#setup-screen').forEach((screen) => {
  screen.querySelectorAll(WRAPPERS).forEach((wrapper) => {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn list-detail-back';
    back.textContent = '‹ BACK TO LIST';
    back.addEventListener('click', () => closeNarrowDetail(wrapper));
    wrapper.prepend(back);
  });
  // Capture phase: a channel row is re-rendered by its own click handler, so by
  // the time the event bubbled here the row would already be detached.
  screen.addEventListener('click', openFromRow, true);
  screen.addEventListener('keydown', (event) => { if (event.key === 'Enter') openFromRow(event); }, true);
});
