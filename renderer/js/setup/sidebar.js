// Setup sidebar attention badges (docs/design/03 §4): a count on a section when
// something there needs a look. The count is a data-badge attribute drawn by
// CSS, so the button's text — which the breadcrumb, search paths and tooltips
// read — stays just the section name.
import { S } from '../core/state.js';

let pluginAttention = 0;

// Channels with nothing to play: no folder yet, or a folder with no videos.
function emptyChannelCount() {
  return (S.config?.channels || []).filter((ch) => !(ch.files || []).length).length;
}

// The last library sync's missing files and folder errors, until the next run.
function librarySyncWarnings() {
  const summary = S.config?.librarySync?.lastSummary;
  return summary ? (summary.missing || 0) + (summary.errors || 0) : 0;
}

const BADGES = {
  channels: () => [emptyChannelCount(), 'with nothing to play'],
  library: () => [librarySyncWarnings(), 'sync warnings'],
  plugins: () => [pluginAttention, 'need attention'],
};

export function refreshSidebarBadges() {
  document.querySelectorAll('#setup-tabs .setup-tab-btn').forEach((btn) => {
    const badge = BADGES[btn.dataset.tab];
    const [count, what] = badge ? badge() : [0, ''];
    const name = btn.textContent.trim();
    if (count > 0) {
      btn.dataset.badge = count > 99 ? '99+' : String(count);
      btn.setAttribute('aria-label', `${name}, ${count} ${what}`);
    } else {
      delete btn.dataset.badge;
      btn.removeAttribute('aria-label');
    }
  });
}

// setup-plugins.js reports its count whenever it lists plugins.
window.addEventListener('reruntv:plugin-attention', (event) => {
  pluginAttention = event.detail?.count || 0;
  refreshSidebarBadges();
});
