// HOUSEHOLD profiles, personal DVR requests and LAN shared sessions
// (docs/design/09). Storage and conflict checks live on the host; this module
// only renders the selected profile and sends named personal commands.
import { S, getClientId } from '../core/state.js';
import {
  currentProfile, joinSharedSession, leaveSharedSession, onPersonalStateChange, personalCommand,
  profiles, startSharedSession, switchProfile,
} from '../personal/state.js';
import { alertDialog, confirmDialog, promptDialog } from './dialogs.js';
import { getRendererService, themePackEntries } from '../plugin/host.js';
import { applyTheme } from '../display/themes.js';
import { showTvScreen } from '../app.js';

const listEl = document.getElementById('household-profiles-list');
const addBtn = document.getElementById('household-add-profile');
const recordingsEl = document.getElementById('household-recordings-list');
const quotaBtn = document.getElementById('household-dvr-quota');
const keepBtn = document.getElementById('household-dvr-keep');
const tunersBtn = document.getElementById('household-dvr-tuners');
const startSessionBtn = document.getElementById('household-start-session');
const joinSessionBtn = document.getElementById('household-join-session');
const leaveSessionBtn = document.getElementById('household-leave-session');
const sessionStatusEl = document.getElementById('household-session-status');
let wired = false;

async function call(method, payload = {}) {
  const response = await window.api.personalCall(method, payload);
  if (!response || !response.ok) throw new Error((response && response.error) || 'The profile store did not answer.');
  return response.result;
}

function button(label, run, className = 'btn') {
  const el = document.createElement('button');
  el.type = 'button'; el.className = className; el.textContent = label; el.addEventListener('click', run);
  return el;
}

async function currentPinFor(profile, title = 'PROFILE PIN') {
  if (!profile.hasPin) return null;
  return promptDialog({ title, message: `Enter ${profile.name}'s current PIN.`, placeholder: '4 digits', inputType: 'password' });
}

function renderProfiles() {
  if (!listEl) return;
  listEl.innerHTML = '';
  const active = currentProfile();
  profiles().forEach((profile) => {
    const row = document.createElement('div'); row.className = 'block-row';
    const swatch = document.createElement('span'); swatch.className = 'badge-dot'; swatch.style.background = profile.color;
    const label = document.createElement('span'); label.className = 'block-count';
    label.textContent = `${profile.name.toUpperCase()}${profile.restriction !== 'none' ? ` · ${profile.restriction.toUpperCase()}` : ''}${profile.id === active?.id ? ' · WATCHING' : ''}`;
    row.append(swatch, label);
    if (profile.id !== active?.id) row.appendChild(button('SWITCH', async () => {
      let pin = null;
      if (active && active.restriction !== 'none' && active.hasPin) {
        pin = await promptDialog({ title: 'LEAVE RESTRICTED PROFILE', message: `Enter ${active.name}'s PIN.`, placeholder: '4 digits', inputType: 'password' });
        if (pin == null) return;
      }
      try { await switchProfile(profile.id, { pin }); renderHouseholdPanel(); }
      catch (e) { await alertDialog(e.message, { variant: 'error' }); }
    }));
    row.appendChild(button('EDIT…', async () => {
      const name = await promptDialog({ title: 'EDIT PROFILE', message: 'Profile name', defaultValue: profile.name });
      if (!name) return;
      const currentPin = await currentPinFor(profile, 'EDIT PROFILE');
      if (profile.hasPin && currentPin == null) return;
      try { await call('updateProfile', { id: profile.id, name, currentPin }); await reloadProfiles(profile.id === active?.id ? profile.id : active?.id); }
      catch (e) { await alertDialog(e.message, { variant: 'error' }); }
    }));
    row.appendChild(button(`RESTRICTION: ${profile.restriction.toUpperCase()}`, async () => {
      const levels = ['none', 'kids', 'teen'];
      const restriction = levels[(levels.indexOf(profile.restriction) + 1) % levels.length];
      const currentPin = await currentPinFor(profile, 'CHANGE RESTRICTION');
      if (profile.hasPin && currentPin == null) return;
      try { await call('updateProfile', { id: profile.id, restriction, currentPin }); await reloadProfiles(active?.id); }
      catch (e) { await alertDialog(e.message, { variant: 'error' }); }
    }));
    row.appendChild(button(profile.hasPin ? 'CHANGE PIN…' : 'SET PIN…', async () => {
      const currentPin = await currentPinFor(profile, 'CHANGE PROFILE PIN');
      if (profile.hasPin && currentPin == null) return;
      const pin = await promptDialog({ title: profile.hasPin ? 'CHANGE PROFILE PIN' : 'SET PROFILE PIN', message: profile.hasPin ? 'Enter four digits, or leave blank to remove the PIN.' : 'Enter four digits.', placeholder: '4 digits', inputType: 'password' });
      if (pin == null || (!profile.hasPin && !pin)) return;
      try { await call('updateProfile', { id: profile.id, currentPin, pin }); await reloadProfiles(active?.id); }
      catch (e) { await alertDialog(e.message, { variant: 'error' }); }
    }));
    if (profile.id === active?.id) row.appendChild(button(`THEME: ${(active.state.theme || 'BOX DEFAULT').toUpperCase()}`, async () => {
      const ids = [null, ...themePackEntries().map((entry) => entry.id)];
      const current = ids.indexOf(active.state.theme || null);
      await personalCommand({ type: 'state.set', key: 'theme', value: ids[(current + 1) % ids.length] });
      applyTheme();
      renderHouseholdPanel();
    }));
    listEl.appendChild(row);
  });
}

function renderRecordings() {
  if (!recordingsEl) return;
  recordingsEl.innerHTML = '';
  const profile = currentProfile();
  const recordings = Object.entries(profile?.state.recordings || {});
  const policy = profile?.state.dvrPolicy || {};
  if (quotaBtn) quotaBtn.textContent = `QUOTA: ${policy.quotaGb ? `${policy.quotaGb} GB` : 'OFF'}`;
  if (keepBtn) keepBtn.textContent = `KEEP: ${policy.keepEpisodes ? `${policy.keepEpisodes} / RULE` : 'ALL'}`;
  if (tunersBtn) tunersBtn.textContent = `SIMULATED TUNERS: ${policy.tunerLimit || 'OFF'}`;
  const requests = currentProfile()?.state.recordingRequests || [];
  if (!requests.length && !recordings.length) {
    const empty = document.createElement('div'); empty.className = 'titles-empty'; empty.textContent = 'NO SHOWS OR RECORDING REQUESTS FOR THIS PROFILE.'; recordingsEl.appendChild(empty); return;
  }
  recordings.forEach(([key, recording]) => {
    const row = document.createElement('div'); row.className = 'block-row';
    const resume = recording.tapeId ? profile.state.resumePoints?.[`tape:${recording.tapeId}`] : null;
    const label = document.createElement('span'); label.className = 'block-count';
    label.textContent = `${String(recording.title || key).toUpperCase()} · ${recording.status.toUpperCase()}${resume?.watched ? ' · WATCHED' : resume?.positionMs ? ' · CONTINUE' : ''}`;
    row.appendChild(label);
    if (recording.status === 'ready' && recording.tapeId) row.appendChild(button(resume?.positionMs ? 'CONTINUE' : 'PLAY', async () => {
      const deck = getRendererService('tape-deck');
      const { tuneToChannel } = await import('../playback/core.js');
      showTvScreen(); // tuneToChannel is a no-op while Setup is open
      tuneToChannel(101);
      setTimeout(() => deck?.play?.(recording.tapeId, resume?.positionMs || 0), 250);
    }));
    if (recording.status !== 'queued') row.appendChild(button('ERASE', async () => {
      if (!(await confirmDialog({
        title: 'ERASE RECORDING?',
        message: `Erase "${String(recording.title || key)}"? The recording is deleted and can't be brought back.`,
        confirmText: 'ERASE',
      }))) return;
      const deck = getRendererService('tape-deck');
      if (recording.tapeId) await deck?.delete?.(recording.tapeId);
      await personalCommand({ type: 'recording.remove', key });
      renderHouseholdPanel();
    }));
    recordingsEl.appendChild(row);
  });
  requests.forEach((request) => {
    const row = document.createElement('div'); row.className = 'block-row';
    const label = document.createElement('span'); label.className = 'block-count';
    label.textContent = `${request.type.toUpperCase()} · CH ${request.channel} · ${new Date(request.start).toLocaleString()} · ${request.breaks === 'program' ? 'PROGRAM ONLY' : 'AS AIRED'}`;
    row.append(label, button('CANCEL', async () => {
      const profile = currentProfile();
      const response = await call('command', { profileId: profile.id, baseRevision: profile.revision, command: { type: 'recording.cancel', id: request.id } });
      if (response.ok) { S.personalProfile = response.profile; renderHouseholdPanel(); }
      else {
        // Stale revision or an already-gone request: say so, and show what is current.
        if (response.profile) S.personalProfile = response.profile;
        renderHouseholdPanel();
        await alertDialog(response.error || "That request couldn't be cancelled. Its latest state has been reloaded.", { variant: 'error' });
      }
    }));
    recordingsEl.appendChild(row);
  });
}

async function reloadProfiles(activeId) {
  S.personalProfiles = await call('listProfiles');
  if (activeId) await switchProfile(activeId);
  renderHouseholdPanel();
}

// The tab click handler in settings.js calls this so a profile created on
// another paired screen (LAN control panel, another window) isn't missed —
// S.personalProfiles is otherwise only refreshed by this module's own
// ADD PROFILE flow and the initial boot fetch.
export async function refreshHouseholdPanel() {
  try { S.personalProfiles = await call('listProfiles'); } catch (e) { /* offline: render what we have */ }
  renderHouseholdPanel();
}

function wire() {
  if (wired) return; wired = true;
  addBtn?.addEventListener('click', async () => {
    const name = await promptDialog({ title: 'ADD PROFILE', message: 'Who is this profile for?', placeholder: 'Name' });
    if (!name) return;
    const pin = await promptDialog({ title: 'OPTIONAL PROFILE PIN', message: 'Enter four digits to protect this profile, or leave blank for no PIN.', placeholder: '4 digits', inputType: 'password' });
    if (pin == null) return;
    try { const created = await call('createProfile', { name, pin: pin || null }); await reloadProfiles(created.id); }
    catch (e) { await alertDialog(e.message, { variant: 'error' }); }
  });
  const cyclePolicy = async (key, values) => {
    const profile = currentProfile();
    if (!profile) return;
    const policy = { ...(profile.state.dvrPolicy || {}) };
    const index = values.indexOf(Number(policy[key]) || 0);
    policy[key] = values[(index + 1) % values.length];
    await personalCommand({ type: 'state.set', key: 'dvrPolicy', value: policy });
    renderHouseholdPanel();
  };
  quotaBtn?.addEventListener('click', () => cyclePolicy('quotaGb', [0, 25, 50, 100]));
  keepBtn?.addEventListener('click', () => cyclePolicy('keepEpisodes', [0, 5, 10, 20]));
  tunersBtn?.addEventListener('click', () => cyclePolicy('tunerLimit', [0, 1, 2, 4]));
  startSessionBtn?.addEventListener('click', async () => {
    try {
      await startSharedSession();
      renderHouseholdPanel();
    } catch (e) { await alertDialog(e.message, { variant: 'error' }); }
  });
  joinSessionBtn?.addEventListener('click', async () => {
    const id = await promptDialog({ title: 'JOIN WATCH SESSION', message: 'Enter the session id shown on the other screen.' });
    if (!id) return;
    try { await joinSharedSession(id); renderHouseholdPanel(); }
    catch (e) { await alertDialog(e.message, { variant: 'error' }); }
  });
  leaveSessionBtn?.addEventListener('click', async () => {
    try { await leaveSharedSession(); } catch (e) {}
    renderHouseholdPanel();
  });
  onPersonalStateChange(() => renderHouseholdPanel());
}

export function renderHouseholdPanel() {
  wire(); renderProfiles(); renderRecordings();
  const activeSession = S.sharedSession;
  if (sessionStatusEl) sessionStatusEl.textContent = activeSession
    ? `${activeSession.leader === getClientId() ? 'LEADING' : 'JOINED'} ${activeSession.id} · CH ${activeSession.channel} · ${activeSession.members.length} SCREEN${activeSession.members.length === 1 ? '' : 'S'}`
    : 'No shared session.';
  leaveSessionBtn?.classList.toggle('hidden', !activeSession);
}
