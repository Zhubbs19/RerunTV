// Setup sidebar attention badges (docs/design/03 §4): a count on a section when
// something there needs a look. The count is a data-badge attribute drawn by
// CSS, so the button's text — which the breadcrumb, search paths and tooltips
// read — stays just the section name.
import { parseMediaRef } from '../core/channels.js';
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

// Files the last quiet existence check couldn't find. Runs when setup opens (a
// moved drive shows up before anyone goes looking); the full CHANNEL HEALTH
// check on the CHANNELS page lists them and offers the relink.
let missingFiles = 0;
let missingCheckRunning = false;
export async function refreshMissingFileBadge() {
  if (missingCheckRunning || !window.api || typeof window.api.checkPathsExist !== 'function') return;
  missingCheckRunning = true;
  try {
    const paths = new Set();
    (S.config?.channels || []).forEach((ch) => {
      (ch.files || []).forEach((f) => f && f.path && paths.add(f.path));
      (ch.blocks || []).forEach((b) => (b.files || []).forEach((f) => f && f.path && paths.add(f.path)));
    });
    // Local disk only: asking a media-source plugin about every file on open would be slow.
    const refs = Array.from(paths).map((p) => parseMediaRef(p)).filter((r) => r.source === 'local');
    const results = refs.length ? await window.api.checkPathsExist(refs) : [];
    missingFiles = Array.isArray(results) ? results.filter((ok) => ok === false).length : 0;
  } catch {
    missingFiles = 0; // an unanswered check says nothing, so it raises no badge
  } finally {
    missingCheckRunning = false;
  }
  refreshSidebarBadges();
}

const BADGES = {
  channels: () => [emptyChannelCount() + missingFiles, 'needing a look (empty, or files not found)'],
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
