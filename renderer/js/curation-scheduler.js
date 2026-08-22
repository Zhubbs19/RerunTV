// Phase 3 of auto-curation — background scheduling. A profile with
// regenerationMode: 'scheduled' re-runs itself automatically on its own
// scheduleInterval (daily/weekly/monthly), with no user action, and
// auto-applies the result — unattended operation is the whole point of
// "scheduled", so unlike the AUTO-CURATE wizard's PREVIEW/APPLY flow there's
// no review step here. It's still fully undoable (Ctrl+Z, state.js) like any
// other config mutation, and still add-only (curateChannel/
// applyCurationProposal, curation.js) so it can never remove anything a
// scheduled run didn't itself just add.
import { S, saveConfigDebounced } from './state.js';
import { applyCurationProposal, curateChannel } from './curation.js';
import { renderChannelList } from './setup-channels.js';
import { renderInterstitialsList } from './setup-interstitials.js';
import { renderAutoCurateList } from './setup-autocurate.js';
import { funToastEl, setupScreen } from './dom.js';
import { autoHideAfter } from './util.js';

const SCHEDULE_INTERVAL_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

// Coarse-grained on purpose — the shortest interval a profile can have is
// 'daily', so checking every half hour keeps a run from landing more than
// ~30 minutes late without polling for no reason.
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 20 * 1000; // let boot/plugin-load settle first

let toastTimer = null;
function showCurationToast(text) {
  if (!funToastEl) return;
  funToastEl.textContent = text;
  funToastEl.classList.add('show');
  toastTimer = autoHideAfter(toastTimer, 6000, () => funToastEl.classList.remove('show'));
}

export function isDue(profile, now) {
  if (profile.regenerationMode !== 'scheduled') return false;
  const intervalMs = SCHEDULE_INTERVAL_MS[profile.scheduleInterval] || SCHEDULE_INTERVAL_MS.weekly;
  return !profile.lastRunAt || now - profile.lastRunAt >= intervalMs;
}

function setupVisible() {
  return !!(setupScreen && !setupScreen.classList.contains('hidden'));
}

// Runs every due scheduled profile once. lastRunAt always advances for a
// due profile regardless of outcome, so a profile that matches nothing (or
// whose target channel was deleted) doesn't get retried on every single
// check tick until its next real interval boundary — same "don't spin on a
// no-op" reasoning as the manual wizard disabling APPLY when there's
// nothing to add (setup-autocurate.js).
export function runScheduledCuration() {
  const profiles = S.config.curationProfiles || [];
  // Deliberately Date.now(), not viewNow() — a scheduled background
  // regeneration should track real wall-clock elapsed time (has a day/week/
  // month actually passed since lastRunAt?) regardless of whatever the
  // time-machine's simulated clock is showing, unlike on-screen "what's
  // airing right now" calculations.
  const now = Date.now();
  const appliedNames = [];
  profiles.forEach((profile) => {
    if (!isDue(profile, now)) return;
    const proposal = curateChannel(profile, now);
    profile.lastRunAt = now;
    if (proposal.targetMissing) return;
    const hasContent = proposal.channelPatch.files.length > 0 || proposal.newInterstitialEntries.length > 0;
    if (!hasContent) return;
    applyCurationProposal(proposal);
    appliedNames.push(profile.name || `channel ${proposal.channelNumber}`);
  });
  if (!appliedNames.length) return;
  saveConfigDebounced();
  if (setupVisible()) {
    renderChannelList();
    renderInterstitialsList();
    renderAutoCurateList();
  }
  showCurationToast(`AUTO-CURATED: ${appliedNames.join(', ')}`);
}

// A LAN viewer never owns config (every save-side window.api method is a
// no-op there, browser-api-shim.js) and shouldn't be the one deciding when
// a scheduled profile is "due" either, so it doesn't self-start this at all.
if (!window.__isViewer) {
  setTimeout(runScheduledCuration, INITIAL_CHECK_DELAY_MS);
  setInterval(runScheduledCuration, CHECK_INTERVAL_MS);
}
