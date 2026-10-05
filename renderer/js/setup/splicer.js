// setup › LIBRARY › SPLICER: the Video Splicer, built in (it used to be a
// plugin that opened its own page in a web browser).
//
// SPLIT A RECORDING cuts a compilation — a tape or rip with shows,
// commercials and bumpers back to back — into clips:
//   PREVIEW CUTS finds the cuts and opens them in the editor (below);
//   REVIEW CUTS does the same with a before/after picture of every cut;
//   SPLIT cuts straight away, no editing.
// The editor (a timeline over the recording, the cuts on it and the clips
// between them — library/splice-plan.js is its data) lets a person add,
// nudge, drop and restore cuts, merge clips, name them, say where each goes,
// find commercials that aired twice, and then SPLIT THESE CLIPS exactly.
// After a split, the clips can go straight into RerunTV: episodes onto a
// channel, commercials and bumpers into the ad pool.
// COMBINE CLIPS joins clips into one file, in the order listed.
//
// The work runs on the host (main/splicer/service.js runs splice.js and
// combine.js with ffmpeg), one run at a time with the rest queued in RUNS,
// and reports back as `splicer:job` events. Remembered folders, options and
// presets live in the splicer's own settings file on the host; the only
// channels.json writes are the ones SEND TO RERUNTV makes, through commands.
import { Badge, Button, Chip, EmptyState, IconButton } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Field } from '../ui/field.js';
import { h } from '../ui/kit-core.js';
import { S, dispatch } from '../core/state.js';
import { freshChannel, mediaRefId, newInterstitialPoolEntry } from '../core/channels.js';
import { confirmDialog, promptDialog } from './dialogs.js';
import { beginTask } from './tasks.js';
import { commitOwnerFields, probeDurationForEntry } from './util.js';
import { renderChannelList } from './channels.js';
import {
  addCut, clipsOf, counts, createModel, episodeNames, keptCuts, mergeWithNext, moveCut, planFor, setClipMeta, setKept,
} from '../library/splice-plan.js';

// ---------- What the detectors can be told ----------

// The "look for" and "leave out" switches are shown positively; the scripts
// take no-black / no-silence / no-scene / keep-gaps / fast-cut.
const OPTION_FIELDS = [
  { key: 'useBlack', label: 'Look for black frames', type: 'check', value: true, flag: 'noBlack',
    help: 'The strongest sign of a break on DVDs and broadcast recordings.' },
  { key: 'useSilence', label: 'Look for silence', type: 'check', value: true, flag: 'noSilence',
    help: 'Turn off for recordings with music or hiss under everything.' },
  { key: 'useScene', label: 'Look for hard picture changes', type: 'check', value: true, flag: 'noScene',
    help: 'Catches cuts with no black or silence, but every shot change in a show looks the same. Off for ordinary episodes.' },
  { key: 'minClip', label: 'Shortest clip (seconds)', type: 'number', value: 2, min: 0, step: 1,
    help: 'Cuts closer together than this are merged, so there are no tiny scraps.' },
  { key: 'minGap', label: 'Shortest gap (seconds)', type: 'number', value: 0.4, min: 0, step: 0.1,
    help: 'How long black or silence must last to count, not just a flicker or a pause.' },
  { key: 'blackThresh', label: 'Black level (0–1)', type: 'number', value: 0.1, min: 0, max: 1, step: 0.01,
    help: 'How dark counts as black. Raise it a little if noisy tape black is missed.' },
  { key: 'silenceDb', label: 'Silence below (dB)', type: 'number', value: -30, max: 0, step: 1,
    help: 'The quiet level. Go lower (−40) if background hum hides real silence.' },
  { key: 'sceneThresh', label: 'Picture change sensitivity (0–100)', type: 'number', value: 16, min: 0, max: 100, step: 1,
    help: 'Lower finds more cuts and more false ones on fast motion.' },
  { key: 'logoTime', label: 'Logo appears at (seconds)', type: 'text', value: '', placeholder: '9, 40.5',
    help: 'Times in this recording where a recurring logo or ID card is on screen. Each time it shows up again marks a cut. The editor can fill this in from its player.' },
  { key: 'logoImage', label: 'Or a picture of the logo', type: 'image', value: '',
    help: 'A still of the recurring card, instead of a time.' },
  { key: 'logoThresh', label: 'Logo match (0–255)', type: 'number', value: 18, min: 0, max: 255, step: 1,
    help: 'Lower is stricter. Only used with a logo.' },
  { key: 'bumperMax', label: 'Bumpers are up to (seconds)', type: 'number', value: 20, min: 0, step: 1,
    help: 'Clips this short go in the bumpers folder.' },
  { key: 'commercialMax', label: 'Commercials are up to (seconds)', type: 'number', value: 120, min: 0, step: 1,
    help: 'Longer than a bumper and up to this goes in commercials; anything longer is an episode.' },
  { key: 'trimGaps', label: 'Leave out the gaps', type: 'check', value: true, flag: 'keepGaps',
    help: 'Clips start after the black or silence of a break and end before it, so they don’t air with dead air on each end.' },
  { key: 'exactStart', label: 'Start clips on the exact frame', type: 'check', value: true, flag: 'fastCut',
    help: 'Re-encodes only the first moments of each clip, up to its first keyframe. Off is faster, but clips can start a second or two late.' },
  { key: 'reencode', label: 'Re-encode whole clips', type: 'check', value: false,
    help: 'Slowest. Use it if clips still glitch at the start. Always saves .mp4 (or .mkv/.mov).' },
];
const WRITE_KEYS = ['trimGaps', 'exactStart', 'reencode', 'bumperMax', 'commercialMax'];

// Starting points per kind of recording, from testing on real files (see
// main/splicer/README.md).
const PRESETS = [
  { key: 'mixed', label: 'Mixed tape', values: { useScene: true, useSilence: true, useBlack: true, minClip: 2, sceneThresh: 16 },
    help: 'Episodes, commercials and bumpers together. Uses every signal; preview first, and switch presets if the count looks wrong.' },
  { key: 'dvd', label: 'DVD or broadcast master', values: { useScene: false, useSilence: false, useBlack: true, minClip: 60 },
    help: 'Clean black breaks between episodes. Picture changes are off: every shot change in a show would count as a cut.' },
  { key: 'bumper', label: 'Promo or bumper reel', values: { useScene: true, useSilence: true, useBlack: true, minClip: 2, sceneThresh: 16 },
    help: 'Fast cuts with no gaps. Picture changes find most of them but not all, so REVIEW CUTS before splitting.' },
  { key: 'custom', label: 'My own settings', values: {},
    help: 'Leaves the settings as you set them.' },
];

const CATEGORY = {
  episodes: { label: 'Episode', tone: 'default' },
  commercials: { label: 'Commercial', tone: 'warning' },
  bumpers: { label: 'Bumper', tone: 'success' },
  skip: { label: 'Don’t save', tone: 'default' },
};

// Ad pool types a clip can become (the video ones, interstitials.js).
const POOL_TYPES = [
  { id: 'commercial', label: 'Commercial' },
  { id: 'upNext', label: 'Up next ident' },
  { id: 'adBreakIn', label: 'Ad break bump-in' },
  { id: 'adBreakOut', label: 'Ad break bump-out' },
  { id: 'signOn', label: 'Sign-on' },
  { id: 'signOff', label: 'Sign-off' },
];

// ---------- Pure helpers ----------

export function formatDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

// With tenths, for cut positions a frame or two apart.
export function formatTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  return `${formatDuration(t)}.${Math.floor((t % 1) * 10)}`;
}

// Option values as shown -> what service.js takes.
export function requestOptions(values) {
  const opts = {};
  OPTION_FIELDS.forEach((field) => {
    const value = values[field.key];
    if (field.type === 'check') {
      if (field.flag) { if (value === false) opts[field.flag] = true; } else if (value === true) opts[field.key] = true;
      return;
    }
    if (value !== undefined && value !== null && String(value).trim() !== '') opts[field.key] = String(value).trim();
  });
  return opts;
}

export function countByCategory(segments) {
  const out = { episodes: 0, commercials: 0, bumpers: 0 };
  segments.forEach((s) => { if (out[s.category] !== undefined) out[s.category] += 1; });
  return out;
}

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const basename = (p) => String(p || '').split(/[\\/]/).pop();
const dirname = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

function categorySummary(c) {
  const parts = [];
  if (c.episodes) parts.push(plural(c.episodes, 'episode'));
  if (c.commercials) parts.push(plural(c.commercials, 'commercial'));
  if (c.bumpers) parts.push(plural(c.bumpers, 'bumper'));
  return parts.join(', ');
}

// ---------- State ----------

const V = {
  available: typeof window !== 'undefined' && !!(window.api && typeof window.api.splicerCall === 'function'),
  loaded: false,
  ffmpeg: true,
  settings: {},
  values: {},        // option values, by OPTION_FIELDS key
  sourceIsFolder: false,
  runs: new Map(),   // jobId -> { label, kind, state, progress, lines, status, resolve, reject, task, out }
  edit: null,        // { models, current, selected, repeats, reviewed, failures, out }
  queue: [],         // combine: file paths in order
  dragFrom: null,
};

const $ = (id) => document.getElementById(id);

async function call(method, payload = {}) {
  const response = await window.api.splicerCall(method, payload);
  if (!response || !response.ok) throw new Error((response && response.error) || 'The splicer did not answer.');
  return response.result;
}

function note(text, tone = '') {
  return h('p', { className: `panel-status library-note${tone ? ` text-${tone}` : ''}`, text, attrs: { role: 'status' } });
}

function showError(panel, error) {
  const results = $(`splicer-${panel}-results`);
  if (results) results.replaceChildren(note(error.message || String(error), 'error'));
}

let saveTimer = null;
function saveSettingsSoon(patch) {
  Object.assign(V.settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { call('saveSettings', V.settings).catch(() => {}); }, 400);
}

function writeOptions() {
  const opts = requestOptions(V.values);
  const out = {};
  WRITE_KEYS.forEach((key) => {
    const field = OPTION_FIELDS.find((f) => f.key === key);
    const flag = field.flag || key;
    if (opts[flag] !== undefined) out[flag] = opts[flag];
  });
  return out;
}

const editOpts = () => ({ trimGaps: V.values.trimGaps !== false, bumperMax: Number(V.values.bumperMax) || 20, commercialMax: Number(V.values.commercialMax) || 120 });

// ---------- SPLIT: inputs, presets and options ----------

function sourceRequest() {
  const source = $('splicer-source').value.trim();
  const out = $('splicer-out').value.trim();
  return { ...(V.sourceIsFolder ? { folder: source } : { input: source }), out, opts: requestOptions(V.values) };
}

function setSource(path, isFolder, missing = false) {
  $('splicer-source').value = path;
  V.sourceIsFolder = !!isFolder;
  $('splicer-source-help').textContent = missing
    ? 'Nothing is there. Check the path, or use FILE… or FOLDER….'
    : isFolder ? 'This folder: every video in it is split with the same settings.' : 'A folder splits every video in it with the same settings.';
  $('splicer-source-help').classList.toggle('text-error', missing);
}

const allPresets = () => [...PRESETS.filter((p) => p.key !== 'custom'), ...(V.settings.customPresets || []), PRESETS.find((p) => p.key === 'custom')];

function renderPresetSelect() {
  const select = $('splicer-preset');
  const mine = V.settings.customPresets || [];
  const option = (p) => h('option', { value: p.key, text: p.label });
  select.replaceChildren(
    ...PRESETS.filter((p) => p.key !== 'custom').map(option),
    ...(mine.length ? [h('optgroup', { attrs: { label: 'My presets' } }, mine.map(option))] : []),
    option(PRESETS.find((p) => p.key === 'custom')),
  );
  select.value = allPresets().some((p) => p.key === V.settings.preset) ? V.settings.preset : 'mixed';
  paintPresetHelp();
}

function paintPresetHelp() {
  const preset = allPresets().find((p) => p.key === $('splicer-preset').value);
  $('splicer-preset-help').textContent = preset ? (preset.help || 'Your saved settings.') : '';
  $('splicer-preset-delete-btn').hidden = !(preset && preset.key.startsWith('user-'));
}

function applyPreset(key) {
  const preset = allPresets().find((p) => p.key === key);
  if (!preset) return;
  Object.assign(V.values, preset.values);
  paintPresetHelp();
  saveSettingsSoon({ preset: key, detectOptions: { ...V.values } });
  renderOptions();
  if (V.edit) renderEditor({ keepVideo: true });
}

async function savePreset() {
  const label = await promptDialog({ title: 'SAVE AS A PRESET', message: 'A name for these settings, like “My VHS tapes”.', placeholder: 'Preset name' });
  if (!label) return;
  const mine = (V.settings.customPresets || []).filter((p) => p.label.toLowerCase() !== label.toLowerCase());
  const preset = { key: `user-${Date.now().toString(36)}`, label: label.slice(0, 60), values: { ...V.values } };
  saveSettingsSoon({ customPresets: [...mine, preset].slice(-30), preset: preset.key });
  renderPresetSelect();
}

async function deletePreset() {
  const key = $('splicer-preset').value;
  const preset = (V.settings.customPresets || []).find((p) => p.key === key);
  if (!preset || !await confirmDialog({ message: `Delete the preset “${preset.label}”? Your current settings stay as they are.`, confirmText: 'DELETE' })) return;
  saveSettingsSoon({ customPresets: V.settings.customPresets.filter((p) => p.key !== key), preset: 'custom' });
  renderPresetSelect();
}

function renderOptions() {
  const root = $('splicer-options-root');
  root.replaceChildren(...OPTION_FIELDS.map((field) => {
    const value = V.values[field.key];
    const changed = (next) => {
      V.values[field.key] = next;
      // Touching a setting by hand means the preset no longer describes it.
      if ($('splicer-preset').value !== 'custom') {
        $('splicer-preset').value = 'custom';
        paintPresetHelp();
      }
      saveSettingsSoon({ preset: 'custom', detectOptions: { ...V.values } });
      if (V.edit && ['trimGaps', 'bumperMax', 'commercialMax'].includes(field.key)) renderEditor({ keepVideo: true });
    };
    if (field.type === 'check') {
      const input = h('input', { type: 'checkbox', checked: value !== undefined ? !!value : field.value });
      input.addEventListener('change', () => changed(input.checked));
      return Field({ label: field.label, help: field.help, control: input, className: 'splicer-check-field' });
    }
    if (field.type === 'image') {
      const input = h('input', { type: 'text', className: 'title-row-input', value: value || '', placeholder: 'No picture', spellcheck: false, autocomplete: 'off' });
      input.addEventListener('change', () => changed(input.value.trim()));
      const pick = Button({
        label: 'CHOOSE…',
        onPress: async () => {
          const picked = await call('pickFile', { kind: 'image' }).catch((e) => { showError('split', e); return null; });
          if (picked) { input.value = picked; changed(picked); }
        },
      });
      return Field({ label: field.label, help: field.help, control: [input, pick], className: 'splicer-path-field' });
    }
    const input = h('input', {
      type: field.type === 'number' ? 'number' : 'text',
      className: 'title-row-input',
      value: value !== undefined ? value : field.value,
      placeholder: field.placeholder || '',
      spellcheck: false,
      autocomplete: 'off',
    });
    ['min', 'max', 'step'].forEach((attr) => { if (field[attr] !== undefined) input[attr] = field[attr]; });
    input.addEventListener('change', () => changed(input.value));
    return Field({ label: field.label, help: field.help, control: input });
  }));
}

// ---------- RUNS: the queue ----------

const RUN_VERBS = {
  detect: 'Finding cuts', review: 'Making cut pictures', split: 'Splitting', splitPlan: 'Splitting', findRepeats: 'Looking for repeats', combine: 'Combining',
};

function runStatus(run) {
  if (run.state === 'waiting') return run.ahead ? `Waiting · ${plural(run.ahead, 'run')} ahead` : 'Waiting';
  if (run.state === 'done') return run.error ? (run.cancelled ? 'Cancelled' : `Failed: ${run.error}`) : 'Done';
  return run.status || `${RUN_VERBS[run.kind] || 'Working'}…`;
}

function renderRuns() {
  const panel = $('splicer-runs-panel');
  const list = $('splicer-runs');
  if (!panel || !list) return;
  const runs = Array.from(V.runs.values());
  panel.hidden = !runs.length;
  list.replaceChildren(...runs.map((run) => {
    const pct = run.state === 'running' && run.progress && run.progress.total ? Math.round((run.progress.current / run.progress.total) * 100) : null;
    const bar = h('progress', { className: 'splicer-progress', max: 100, attrs: { 'aria-label': run.label } });
    if (pct !== null) bar.value = pct;
    else if (run.state === 'waiting') bar.value = 0;
    const actions = h('span', { className: 'library-row-actions' });
    if (run.state !== 'done') actions.appendChild(Button({ label: 'CANCEL', variant: 'danger', disabled: !!run.cancelling, onPress: () => cancelRun(run.jobId) }));
    if (run.state === 'done' && run.out) actions.appendChild(openFolderButton(run.out, 'OPEN FOLDER'));
    const row = h('li', { className: `splicer-run-row is-${run.state}${run.error && !run.cancelled ? ' is-failed' : ''}`, dataset: { jobId: run.jobId } },
      h('div', { className: 'splicer-run-head' },
        h('span', { className: 'splicer-run-label', text: run.label }),
        h('span', { className: 'splicer-run-status', text: runStatus(run), attrs: { role: 'status', 'aria-live': 'polite' } }),
        pct !== null ? h('span', { className: 'splicer-run-pct', text: `${pct}%` }) : null,
        actions),
      run.state === 'done' ? null : bar);
    if (run.lines.length) {
      const log = h('pre', { className: 'splicer-log', text: run.lines.slice(-200).join('\n') });
      const details = h('details', { className: 'splicer-disclosure splicer-log-wrap', open: !!run.logOpen }, h('summary', { text: 'DETAILS' }), log);
      details.addEventListener('toggle', () => { run.logOpen = details.open; if (details.open) log.scrollTop = log.scrollHeight; });
      row.appendChild(details);
      if (details.open) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }
    return row;
  }));
}

let renderQueued = false;
function renderRunsSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderRuns(); });
}

// Queues a host job; resolves with its done event.
function startRun(request, label) {
  return new Promise((resolve, reject) => {
    call('startJob', { ...request, label }).then(({ jobId, ahead }) => {
      const existing = V.runs.get(jobId) || {};
      const run = { state: 'waiting', progress: null, lines: [], task: null, ...existing, jobId, kind: request.kind, label, resolve, reject };
      if (run.ahead === undefined) run.ahead = ahead;
      V.runs.set(jobId, run);
      // Events can beat startJob's own reply: a run that already finished.
      if (run.doneEvent) settle(run, run.doneEvent);
      renderRuns();
    }).catch(reject);
  });
}

function settle(run, event) {
  if (!run.resolve) { run.doneEvent = event; return; }
  if (event.cancelled) run.reject(Object.assign(new Error('Cancelled.'), { cancelled: true }));
  else if (event.error && !event.result) run.reject(new Error(event.error));
  else run.resolve(event);
  run.resolve = null;
}

// One event from main/splicer/service.js.
function onJobEvent(event) {
  let run = V.runs.get(event.jobId);
  if (!run) {
    run = { jobId: event.jobId, kind: event.kind, label: event.label || 'Splicer run', state: 'waiting', lines: [], progress: null, task: null };
    V.runs.set(event.jobId, run);
  }
  if (event.type === 'queued') {
    run.ahead = event.ahead;
  } else if (event.type === 'start') {
    run.state = 'running';
    run.task = beginTask(`VIDEO SPLICER · ${(RUN_VERBS[run.kind] || 'WORKING').toUpperCase()}…`);
  } else if (event.type === 'log' || event.type === 'progress') {
    run.lines.push(event.line);
    if (run.lines.length > 1000) run.lines.splice(0, run.lines.length - 1000);
    if (event.type === 'progress') {
      run.progress = { current: event.current, total: event.total };
      const reading = /scanning/i.test(event.line);
      run.status = reading ? `Reading the recording… ${event.current}%` : `${RUN_VERBS[run.kind] || 'Working'} · ${event.current} of ${event.total}`;
      if (run.task) run.task.update(`VIDEO SPLICER · ${reading ? `READING ${event.current}%` : `${event.current} / ${event.total}`}`);
    } else if (/^=== (.+) ===$/.test(event.line.trim())) {
      run.status = `Working on ${event.line.trim().slice(4, -4)}…`;
      run.progress = null;
    }
  } else if (event.type === 'done') {
    run.state = 'done';
    run.error = event.error;
    run.cancelled = !!event.cancelled;
    run.out = event.result && event.result.out;
    if (run.task) { run.task.end(); run.task = null; }
    // Everyone behind it moves up.
    V.runs.forEach((other) => { if (other.state === 'waiting' && other.ahead) other.ahead -= 1; });
    settle(run, event);
  }
  renderRunsSoon();
}

async function cancelRun(jobId) {
  const run = V.runs.get(jobId);
  if (!run) return;
  run.cancelling = true;
  if (run.state === 'running') run.status = 'Stopping…';
  renderRuns();
  await call('cancelJob', { jobId }).catch(() => {});
}

async function runAction(panel, fn) {
  try {
    await fn();
  } catch (e) {
    if (e.cancelled) $(`splicer-${panel}-results`).replaceChildren(note('Cancelled. Clips already written are still there.', 'warning'));
    else showError(panel, e);
  }
}

function openFolderButton(target, label = 'SHOW IN FOLDER') {
  return Button({ label, onPress: () => call('showInFolder', { path: target }).catch((e) => showError('split', e)) });
}

function failuresBlock(failures) {
  if (!failures || !failures.length) return null;
  return h('div', { className: 'library-root' },
    note(`${plural(failures.length, 'recording')} couldn’t be read:`, 'error'),
    h('ul', { className: 'library-item-list' }, failures.map((f) => h('li', {}, h('span', { className: 'library-ref', text: basename(f.input) }), h('span', { className: 'library-reason', text: f.error })))));
}

const sourceLabel = () => basename($('splicer-source').value.trim()) || 'recording';

// ---------- SPLIT: find cuts, then edit ----------

async function findCuts(review) {
  await runAction('split', async () => {
    const request = { kind: review ? 'review' : 'detect', ...sourceRequest() };
    const { result } = await startRun(request, `${review ? 'Review' : 'Preview'} ${sourceLabel()}`);
    const files = (result.files || [result]).filter((f) => f && f.sourcePath);
    if (!files.length) {
      $('splicer-split-results').replaceChildren(note('No recordings could be read.', 'error'), failuresBlock(result.failures) || '');
      return;
    }
    editorVideo()?.pause();
    V.edit = { models: files.map(createModel), current: 0, selected: null, repeats: {}, reviewed: !!review, failures: result.failures || [], out: request.out };
    await renderEditor();
  });
}

const currentModel = () => V.edit && V.edit.models[V.edit.current];
const editorVideo = () => document.getElementById('splicer-edit-video');

function seek(t) {
  const video = editorVideo();
  if (video) video.currentTime = Math.max(0, t);
}

function selectCut(id, { seekTo = true } = {}) {
  V.edit.selected = id;
  const cut = currentModel().cuts.find((c) => c.id === id);
  if (cut && seekTo) seek(Math.max(0, cut.from - 1.5));
  renderEditor({ keepVideo: true, focusCut: id });
}

const frameStep = (model) => 1 / (model.fps || 30);

// The recording as a strip: clips coloured by where they go, gaps dark,
// cuts as focusable markers; the playhead follows the player.
function timeline(model, clips) {
  const pct = (t) => `${(t / model.duration) * 100}%`;
  const strip = h('div', { className: 'splicer-timeline', attrs: { role: 'group', 'aria-label': 'Recording timeline. Click to move the player; a selected cut moves with the arrow keys (Shift for a second), Delete removes it.' } });
  clips.forEach((clip) => strip.appendChild(h('div', {
    className: `splicer-tl-clip cat-${clip.category}`,
    style: { left: pct(clip.start), width: pct(clip.duration) },
    attrs: { title: `#${clip.index} · ${CATEGORY[clip.category].label} · ${formatDuration(clip.duration)}` },
  })));
  model.cuts.forEach((cut) => {
    const marker = h('button', {
      type: 'button',
      className: `splicer-tl-cut${cut.kept ? '' : ' is-dropped'}${V.edit.selected === cut.id ? ' is-selected' : ''}`,
      style: { left: pct(cut.at) },
      dataset: { cutId: cut.id },
      attrs: { 'aria-label': `Cut at ${formatTime(cut.at)}${cut.kept ? '' : ', removed'}`, 'aria-pressed': String(V.edit.selected === cut.id) },
    });
    marker.addEventListener('click', (event) => { event.stopPropagation(); selectCut(cut.id); });
    marker.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 1 : frameStep(model);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        V.edit.selected = cut.id;
        moveCut(model, cut.id, event.key === 'ArrowLeft' ? -step : step);
        seek(cut.from - 1);
        renderEditor({ keepVideo: true, focusCut: cut.id });
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        setKept(model, cut.id, !cut.kept);
        renderEditor({ keepVideo: true });
      }
    });
    strip.appendChild(marker);
  });
  const head = h('div', { className: 'splicer-tl-playhead', attrs: { 'aria-hidden': 'true' } });
  strip.appendChild(head);
  strip.addEventListener('click', (event) => {
    if (event.target !== strip && !event.target.classList.contains('splicer-tl-clip')) return;
    const rect = strip.getBoundingClientRect();
    seek(((event.clientX - rect.left) / rect.width) * model.duration);
  });
  return { strip, head };
}

function cutToolbar(model) {
  const bar = h('div', { className: 'library-actions splicer-cut-tools' });
  bar.append(
    Button({ label: 'ADD A CUT HERE', id: 'splicer-add-cut-btn', onPress: () => {
      const cut = addCut(model, editorVideo()?.currentTime || 0);
      if (cut) { V.edit.selected = cut.id; renderEditor({ keepVideo: true, focusCut: cut.id }); }
      else $('splicer-edit-note').textContent = 'There is already a cut there.';
    } }),
    Button({ label: 'USE THIS FRAME AS THE LOGO', variant: 'quiet', title: 'Adds the player’s time to “Logo appears at”. Preview again to use it.', onPress: () => {
      const t = Math.round((editorVideo()?.currentTime || 0) * 10) / 10;
      const times = String(V.values.logoTime || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!times.includes(String(t))) times.push(String(t));
      V.values.logoTime = times.join(', ');
      saveSettingsSoon({ preset: 'custom', detectOptions: { ...V.values } });
      $('splicer-preset').value = 'custom';
      paintPresetHelp();
      renderOptions();
      $('splicer-edit-note').textContent = `Added ${t} s as a logo time. PREVIEW CUTS again to find every place it shows up.`;
    } }),
  );
  const cut = model.cuts.find((c) => c.id === V.edit.selected);
  if (cut) {
    const nudge = (delta) => () => { moveCut(model, cut.id, delta); seek(cut.from - 1); renderEditor({ keepVideo: true, focusCut: cut.id }); };
    const f = frameStep(model);
    bar.append(
      h('span', { className: 'splicer-cut-label', text: `Cut at ${formatTime(cut.at)}${cut.moved ? ' (moved)' : ''}` }),
      IconButton({ icon: '⏪', label: 'Move the cut 1 second earlier', onPress: nudge(-1) }),
      IconButton({ icon: '◀', label: 'Move the cut 1 frame earlier', onPress: nudge(-f) }),
      IconButton({ icon: '▶', label: 'Move the cut 1 frame later', onPress: nudge(f) }),
      IconButton({ icon: '⏩', label: 'Move the cut 1 second later', onPress: nudge(1) }),
      Button({ label: 'PLAY ACROSS IT', onPress: () => { seek(cut.from - 2); editorVideo()?.play().catch(() => {}); } }),
      Button({ label: cut.kept ? 'REMOVE CUT' : 'RESTORE CUT', variant: cut.kept ? 'danger' : 'default', id: 'splicer-cut-toggle-btn', onPress: () => { setKept(model, cut.id, !cut.kept); renderEditor({ keepVideo: true }); } }),
    );
  }
  return bar;
}

async function thumbUrl(path) {
  try { return await window.api.toFileUrl(path); } catch (e) { return ''; }
}

async function pictureGrid(model) {
  const withPictures = model.cuts.filter((c) => c.thumbPath);
  if (!withPictures.length) return null;
  const grid = h('div', { className: 'splicer-thumbs' });
  const urls = await Promise.all(withPictures.map((c) => thumbUrl(c.thumbPath)));
  withPictures.forEach((cut, i) => {
    const title = `Cut at ${formatTime(cut.at)}`;
    const checkbox = h('input', { type: 'checkbox', checked: cut.kept });
    checkbox.addEventListener('change', () => { setKept(model, cut.id, checkbox.checked); renderEditor({ keepVideo: true }); });
    const img = h('img', { src: urls[i], alt: `Before and after the ${title.toLowerCase()}`, loading: 'lazy' });
    const zoom = h('button', { type: 'button', className: 'splicer-thumb-zoom', attrs: { 'aria-label': `See the ${title.toLowerCase()} larger` } }, img);
    zoom.addEventListener('click', async () => {
      const keep = await Dialog({
        title: title.toUpperCase(),
        body: h('img', { className: 'splicer-thumb-large', src: urls[i], alt: `Before and after the ${title.toLowerCase()}` }),
        kind: 'alert',
        dismissValue: null,
        actions: [
          { label: 'REMOVE THIS CUT', value: false },
          { label: 'KEEP THIS CUT', variant: 'primary', value: true, isDefault: cut.kept },
        ],
      }).result;
      if (keep !== null && keep !== undefined) { setKept(model, cut.id, keep); renderEditor({ keepVideo: true }); }
    });
    grid.appendChild(h('div', { className: `splicer-thumb${cut.kept ? '' : ' is-dropped'}${V.edit.selected === cut.id ? ' is-selected' : ''}` },
      zoom,
      h('div', { className: 'splicer-thumb-meta' },
        h('label', {}, checkbox, h('span', { text: title })),
        cut.moved ? Chip({ text: 'MOVED', tone: 'accent', title: 'The picture is from before the cut was moved.' }) : null,
        Button({ label: 'SHOW', variant: 'quiet', onPress: () => selectCut(cut.id) }))));
  });
  return grid;
}

function clipsTable(model, clips, fileIndex) {
  const repeatOf = (clip) => V.edit.repeats[`${fileIndex}:${clip.index - 1}`];
  const rows = clips.map((clip) => {
    const name = h('input', { type: 'text', className: 'title-row-input splicer-clip-name', value: clip.name, placeholder: 'Automatic name', spellcheck: false, attrs: { 'aria-label': `Name for clip ${clip.index}` } });
    name.addEventListener('change', () => { setClipMeta(model, clip.key, { name: name.value.trim() }); });
    const category = h('select', { attrs: { 'aria-label': `Where clip ${clip.index} goes` } },
      Object.entries(CATEGORY).map(([id, c]) => h('option', { value: id, text: c.label, selected: id === clip.category })));
    category.addEventListener('change', () => { setClipMeta(model, clip.key, { category: category.value }); renderEditor({ keepVideo: true }); });
    const repeat = repeatOf(clip);
    return h('tr', { className: clip.category === 'skip' ? 'is-skipped' : '' },
      h('td', { className: 'num', text: String(clip.index) }),
      h('td', { className: 'num', text: formatTime(clip.start) }),
      h('td', { className: 'num', text: formatDuration(clip.duration) }),
      h('td', {}, name),
      h('td', {}, h('span', { className: 'splicer-clip-where' }, category,
        repeat ? Chip({ text: `REPEAT OF #${Number(repeat.split(':')[1]) + 1}`, tone: 'warning', title: 'The same thing aired earlier on this tape.' }) : null)),
      h('td', {}, h('span', { className: 'library-row-actions' },
        IconButton({ icon: '▶', label: `Play clip ${clip.index}`, onPress: () => { seek(clip.start); editorVideo()?.play().catch(() => {}); } }),
        clip.nextId !== 'end' ? Button({ label: 'MERGE WITH NEXT', variant: 'quiet', onPress: () => { mergeWithNext(model, clip); renderEditor({ keepVideo: true }); } }) : null)));
  });
  return h('table', { className: 'library-table splicer-table' },
    h('thead', {}, h('tr', {}, ['#', 'Starts', 'Length', 'Name', 'Goes to', ''].map((label) => h('th', { text: label, attrs: { scope: 'col' } })))),
    h('tbody', {}, rows));
}

function namingRow(model) {
  const series = h('input', { type: 'text', className: 'title-row-input', placeholder: 'Series name', spellcheck: false, attrs: { 'aria-label': 'Series name' } });
  const season = h('input', { type: 'number', className: 'title-row-input splicer-num', value: 1, min: 0, attrs: { 'aria-label': 'Season' } });
  const episode = h('input', { type: 'number', className: 'title-row-input splicer-num', value: 1, min: 0, attrs: { 'aria-label': 'First episode number' } });
  return h('div', { className: 'library-actions splicer-naming' },
    h('span', { className: 'splicer-naming-label', text: 'Name the episodes' }), series,
    h('span', { text: 'Season' }), season, h('span', { text: 'from episode' }), episode,
    Button({ label: 'NUMBER THEM', id: 'splicer-number-btn', onPress: () => {
      const names = episodeNames(clipsOf(model, editOpts()), series.value.trim(), { season: Number(season.value) || 1, episode: Number(episode.value) || 1 });
      Object.entries(names).forEach(([key, value]) => setClipMeta(model, key, { name: value }));
      renderEditor({ keepVideo: true });
    } }));
}

let editorRender = 0;
async function renderEditor({ keepVideo = false, focusCut = null } = {}) {
  const results = $('splicer-split-results');
  if (!V.edit) return;
  const renderId = ++editorRender;
  const model = currentModel();
  const clips = clipsOf(model, editOpts());
  const c = counts(clips);
  const kept = keptCuts(model).length;

  // The player survives re-renders, so editing never interrupts playback.
  let video = keepVideo ? editorVideo() : null;
  if (!video || video.dataset.source !== model.sourcePath) {
    video = h('video', { id: 'splicer-edit-video', className: 'splicer-edit-video', controls: true, preload: 'metadata', dataset: { source: model.sourcePath } });
    video.src = await thumbUrl(model.sourcePath);
  }
  const { strip, head } = timeline(model, clips);
  const moveHead = () => { head.style.left = `${(video.currentTime / model.duration) * 100}%`; };
  video.ontimeupdate = moveHead;
  moveHead();

  const fileSelect = V.edit.models.length > 1 ? h('select', { attrs: { 'aria-label': 'Recording to edit' } },
    V.edit.models.map((m, i) => h('option', { value: String(i), text: m.sourceFile, selected: i === V.edit.current }))) : null;
  if (fileSelect) fileSelect.addEventListener('change', () => { V.edit.current = Number(fileSelect.value); V.edit.selected = null; renderEditor(); });

  const pictures = await pictureGrid(model);
  if (renderId !== editorRender) return;
  const total = V.edit.models.reduce((n, m) => n + clipsOf(m, editOpts()).filter((x) => x.category !== 'skip').length, 0);
  const noteText = document.getElementById('splicer-edit-note')?.textContent || '';

  results.replaceChildren(...[
    h('div', { className: 'splicer-editor-head' },
      fileSelect,
      note(`${model.sourceFile}: ${plural(clips.length, 'clip')} — ${categorySummary(c) || 'nothing'}${c.skip ? `, ${c.skip} not saved` : ''}. ${plural(kept, 'cut')}${model.cuts.length > kept ? ` (${model.cuts.length - kept} removed)` : ''}. Nothing is written until you split.`, 'success')),
    h('div', { className: 'splicer-player' }, video, strip),
    cutToolbar(model),
    h('p', { id: 'splicer-edit-note', className: 'panel-status', text: noteText, attrs: { role: 'status', 'aria-live': 'polite' } }),
    pictures ? h('details', { className: 'splicer-disclosure', open: true }, h('summary', { text: `CUT PICTURES (${model.cuts.filter((x) => x.thumbPath).length})` }), pictures) : null,
    namingRow(model),
    clipsTable(model, clips, V.edit.current),
    failuresBlock(V.edit.failures),
    h('div', { className: 'library-actions splicer-edit-actions' },
      Badge({ text: `${total} TO SAVE`, tone: 'success' }),
      Button({ label: 'FIND REPEATS', id: 'splicer-find-repeats-btn', title: 'Look for commercials and bumpers that aired more than once', onPress: findRepeatsNow }),
      Object.keys(V.edit.repeats).length ? Button({ label: 'DON’T SAVE REPEATS', variant: 'quiet', id: 'splicer-skip-repeats-btn', onPress: skipRepeats }) : null,
      Button({ label: 'DISCARD EDITS', variant: 'quiet', onPress: async () => {
        if (await confirmDialog({ message: 'Close the editor? The cuts you changed are lost; nothing has been written.', confirmText: 'DISCARD' })) { editorVideo()?.pause(); V.edit = null; results.replaceChildren(); }
      } }),
      Button({ label: `SPLIT THESE CLIPS (${total})`, variant: 'primary', id: 'splicer-plan-split-btn', disabled: !V.ffmpeg || !total, onPress: splitEdited })),
  ].filter(Boolean));
  if (focusCut) results.querySelector(`.splicer-tl-cut[data-cut-id="${focusCut}"]`)?.focus();
}

const planForEdit = () => planFor(V.edit.models, editOpts());
const editLabel = () => (V.edit.models.length === 1 ? V.edit.models[0].sourceFile : plural(V.edit.models.length, 'recording'));

async function findRepeatsNow() {
  await runAction('split', async () => {
    const { result } = await startRun({ kind: 'findRepeats', plan: planForEdit() }, `Find repeats in ${editLabel()}`);
    if (!V.edit) return;
    V.edit.repeats = (result && result.repeats) || {};
    const n = Object.keys(V.edit.repeats).length;
    await renderEditor({ keepVideo: true });
    $('splicer-edit-note').textContent = n ? `${plural(n, 'clip')} aired earlier on the same tape. DON’T SAVE REPEATS skips them.` : 'No repeats found.';
  });
}

function skipRepeats() {
  V.edit.models.forEach((model, fileIndex) => {
    clipsOf(model, editOpts()).forEach((clip) => {
      if (V.edit.repeats[`${fileIndex}:${clip.index - 1}`]) setClipMeta(model, clip.key, { category: 'skip' });
    });
  });
  renderEditor({ keepVideo: true });
}

async function splitEdited() {
  const plan = planForEdit();
  const label = `Split ${editLabel()}`;
  const out = V.edit.out;
  editorVideo()?.pause();
  V.edit = null;
  $('splicer-split-results').replaceChildren(note('Splitting — see RUNS.'));
  await runAction('split', async () => {
    const { result } = await startRun({ kind: 'splitPlan', plan, out, opts: writeOptions() }, label);
    splitDone(result);
  });
}

// ---------- SPLIT: straight away ----------

async function splitNow() {
  await runAction('split', async () => {
    const { result } = await startRun({ kind: 'split', ...sourceRequest() }, `Split ${sourceLabel()}`);
    if (!V.edit) splitDone(result);
    else $('splicer-edit-note').textContent = `Split ${sourceLabel()}: ${plural((result.manifest || []).length, 'clip')} written to ${result.out}.`;
  });
}

function splitDone(result) {
  const results = $('splicer-split-results');
  const manifest = result.manifest || [];
  const c = countByCategory(manifest);
  results.replaceChildren(
    note(`Wrote ${plural(manifest.length, 'clip')} (${categorySummary(c) || 'none'}) to ${result.out}.`, manifest.length ? 'success' : 'warning'),
    h('div', { className: 'library-actions' }, result.out ? openFolderButton(result.out, 'OPEN CLIPS FOLDER') : null),
  );
  const send = sendPanel(manifest);
  if (send) results.appendChild(send);
  const failed = failuresBlock(result.failures);
  if (failed) results.appendChild(failed);
  if (result.out) saveSettingsSoon({ defaultOutDir: $('splicer-out').value.trim() || V.settings.defaultOutDir || '' });
}

// ---------- Sending clips into RerunTV ----------

function channelOptions(selected) {
  return [
    h('option', { value: 'new', text: 'A new channel', selected: selected === 'new' }),
    ...(S.config.channels || []).map((ch) => h('option', { value: String(ch.number), text: `CH ${ch.number} · ${ch.name || 'Untitled'}`, selected: String(ch.number) === String(selected) })),
  ];
}

// Durations are read from the files themselves: a channel's schedule is
// built from them, so the splice plan's times aren't good enough.
async function probeAll(items) {
  const files = [];
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    const duration = await probeDurationForEntry('local', item.path, { fallback: item.duration });
    files.push({ path: item.path, duration: Number.isFinite(duration) && duration > 0 ? duration : item.duration });
  }
  return files;
}

async function addEpisodesToChannel(items, target, suggestedName) {
  const folder = dirname(items[0].path);
  const entry = { id: mediaRefId('local', folder), source: 'local', ref: folder, label: null };
  const probed = await probeAll(items);
  if (target === 'new') {
    const channel = freshChannel();
    channel.name = suggestedName;
    channel.folders = [entry];
    channel.files = probed.map((f) => ({ ...f, folder: entry.id, source: 'local' }));
    channel.anchor = Date.now(); // channel anchor: real time, when it got content
    dispatch({ type: 'channel.insert', channel }, { label: `Add channel ${channel.name} from the splicer` });
    S.setupSelectedChannel = channel.number;
    renderChannelList();
    return `Made CH ${channel.number} · ${channel.name} with ${plural(probed.length, 'episode')}.`;
  }
  const ch = (S.config.channels || []).find((c) => String(c.number) === String(target));
  if (!ch) throw new Error('That channel is gone.');
  if (!ch.folders.some((e) => e.source === 'local' && e.ref === folder)) ch.folders.push(entry);
  const known = new Set((ch.files || []).map((f) => f.path));
  const fresh = probed.filter((f) => !known.has(f.path)).map((f) => ({ ...f, folder: entry.id, source: 'local' }));
  ch.files = (ch.files || []).concat(fresh);
  // Anchor is set once, the first time a channel gets any content — the
  // loop then extends from the same reference point.
  if (!ch.anchor) ch.anchor = Date.now();
  commitOwnerFields(ch, ['folders', 'files', 'anchor'], { label: `Add splicer episodes to CH ${ch.number}` });
  renderChannelList();
  return `Added ${plural(fresh.length, 'episode')} to CH ${ch.number} · ${ch.name || 'Untitled'}.`;
}

async function addToAdPool(items, type, channelAffinity) {
  const known = new Set((S.config.interstitials?.pool || []).map((e) => e.file && e.file.path));
  const fresh = await probeAll(items.filter((item) => !known.has(item.path)));
  if (!fresh.length) return 'They are already in the ad pool.';
  dispatch(fresh.map((f) => ({
    type: 'item.insert', collection: 'pool',
    item: newInterstitialPoolEntry({ file: { path: f.path, source: 'local', duration: f.duration }, type, channelAffinity }),
  })), { label: `Add ${fresh.length} splicer clip${fresh.length === 1 ? '' : 's'} to the ad pool` });
  return `Added ${plural(fresh.length, 'clip')} to the ad pool as ${POOL_TYPES.find((t) => t.id === type).label.toLowerCase()}s.`;
}

function sendPanel(manifest) {
  if (!manifest.length || !S.config) return null;
  const targets = V.settings.sendTargets || {};
  const byCat = (cat) => manifest.filter((m) => m.category === cat && m.path);
  const rows = [];
  const status = h('p', { className: 'panel-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const act = (btn, fn) => async () => {
    btn.disabled = true;
    try {
      status.textContent = await fn();
      status.className = 'panel-status library-note text-success';
    } catch (e) {
      btn.disabled = false;
      status.textContent = e.message;
      status.className = 'panel-status library-note text-error';
    }
  };

  const episodes = byCat('episodes');
  if (episodes.length) {
    const select = h('select', { attrs: { 'aria-label': 'Channel for the episodes' } }, channelOptions(targets.episodes || 'new'));
    const btn = Button({ label: `ADD ${plural(episodes.length, 'EPISODE', 'EPISODES')}`, id: 'splicer-send-episodes-btn' });
    btn.addEventListener('click', act(btn, () => {
      saveSettingsSoon({ sendTargets: { ...V.settings.sendTargets, episodes: select.value } });
      const suggested = (episodes[0].name || '').replace(/\s*-\s*S\d+E\d+$/i, '') || basename(episodes[0].sourceFile).replace(/\.[^.]+$/, '');
      return addEpisodesToChannel(episodes, select.value, suggested);
    }));
    rows.push(h('div', { className: 'splicer-send-row' }, h('span', { className: 'splicer-send-what', text: 'Episodes onto' }), select, btn));
  }
  ['commercials', 'bumpers'].forEach((cat) => {
    const items = byCat(cat);
    if (!items.length) return;
    const typeSelect = h('select', { attrs: { 'aria-label': `Ad pool type for the ${cat}` } },
      POOL_TYPES.map((t) => h('option', { value: t.id, text: t.label, selected: t.id === (targets[`${cat}Type`] || (cat === 'bumpers' ? 'adBreakIn' : 'commercial')) })));
    const chSelect = h('select', { attrs: { 'aria-label': `Channel for the ${cat}` } },
      h('option', { value: 'any', text: 'Any channel' }),
      (S.config.channels || []).map((ch) => h('option', { value: String(ch.number), text: `CH ${ch.number} only`, selected: String(ch.number) === String(targets[`${cat}Channel`]) })));
    const btn = Button({ label: `ADD ${plural(items.length, cat === 'bumpers' ? 'BUMPER' : 'COMMERCIAL', cat === 'bumpers' ? 'BUMPERS' : 'COMMERCIALS')}`, id: `splicer-send-${cat}-btn` });
    btn.addEventListener('click', act(btn, () => {
      saveSettingsSoon({ sendTargets: { ...V.settings.sendTargets, [`${cat}Type`]: typeSelect.value, [`${cat}Channel`]: chSelect.value } });
      return addToAdPool(items, typeSelect.value, chSelect.value === 'any' ? 'any' : Number(chSelect.value));
    }));
    rows.push(h('div', { className: 'splicer-send-row' }, h('span', { className: 'splicer-send-what', text: cat === 'bumpers' ? 'Bumpers into the ad pool as' : 'Commercials into the ad pool as' }), typeSelect, chSelect, btn));
  });
  if (!rows.length) return null;
  return h('div', { className: 'library-card splicer-send' },
    h('div', { className: 'library-card-title', text: 'SEND TO RERUNTV' }),
    h('p', { className: 'panel-status', text: 'Put the new clips to work. Each can be undone with Ctrl+Z like any other edit.' }),
    ...rows, status);
}

// ---------- COMBINE ----------

async function previewClip(path) {
  const video = $('splicer-preview');
  video.src = await thumbUrl(path);
  video.hidden = false;
}

function moveClip(from, to) {
  if (to < 0 || to >= V.queue.length || from === to) return;
  const [moved] = V.queue.splice(from, 1);
  V.queue.splice(to, 0, moved);
  renderQueue();
}

function renderQueue() {
  const list = $('splicer-queue');
  if (!V.queue.length) {
    list.replaceChildren(h('li', { className: 'splicer-queue-empty' }, EmptyState({ message: 'No clips yet. Add clips or a folder of them, in the order they should play.' })));
    return;
  }
  list.replaceChildren(...V.queue.map((path, i) => {
    const name = basename(path);
    const row = h('li', { className: 'splicer-queue-row', draggable: true, dataset: { index: i } },
      h('span', { className: 'splicer-queue-num', text: String(i + 1), attrs: { 'aria-hidden': 'true' } }),
      h('span', { className: 'splicer-queue-name', text: name, attrs: { title: path } }),
      h('span', { className: 'library-row-actions' },
        IconButton({ icon: '▶', label: `Preview ${name}`, onPress: () => previewClip(path) }),
        IconButton({ icon: '▲', label: `Move ${name} earlier`, disabled: i === 0, onPress: () => moveClip(i, i - 1) }),
        IconButton({ icon: '▼', label: `Move ${name} later`, disabled: i === V.queue.length - 1, onPress: () => moveClip(i, i + 1) }),
        IconButton({ icon: '✕', label: `Remove ${name}`, onPress: () => { V.queue.splice(i, 1); renderQueue(); } })));
    row.addEventListener('dragstart', (event) => { V.dragFrom = i; row.classList.add('is-dragging'); event.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); V.dragFrom = null; });
    row.addEventListener('dragover', (event) => { if (V.dragFrom !== null) event.preventDefault(); });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      if (V.dragFrom !== null) moveClip(V.dragFrom, i);
    });
    return row;
  }));
}

// Exported for tests/ui/verify-splicer.mjs: native pickers can't be driven
// over CDP, and window.api is frozen by the context bridge.
export function addClips(paths) {
  const known = new Set(V.queue);
  const fresh = (paths || []).filter((p) => !known.has(p));
  V.queue.push(...fresh);
  if (fresh.length && !$('splicer-combine-out').value.trim()) $('splicer-combine-out').value = `${dirname(fresh[0])}${fresh[0].includes('\\') ? '\\' : '/'}combined.mp4`;
  renderQueue();
}

async function combine() {
  await runAction('combine', async () => {
    $('splicer-combine-results').replaceChildren();
    const out = $('splicer-combine-out').value.trim();
    const files = V.queue.slice();
    const { result } = await startRun({ kind: 'combine', files, out, reencode: $('splicer-combine-reencode').checked }, `Combine ${plural(files.length, 'clip')} into ${basename(out) || 'one file'}`);
    const how = result.method === 'copy' ? 'joined as they were'
      : result.method === 'convert' ? `joined, ${plural(result.converted || 0, 'clip')} converted to match`
        : 're-encoded to match';
    $('splicer-combine-results').replaceChildren(
      note(`Wrote ${basename(result.out)}${result.duration ? ` (${formatDuration(result.duration)})` : ''} — ${plural(files.length, 'clip')} ${how}.`, 'success'),
      h('div', { className: 'library-actions' }, openFolderButton(result.out, 'SHOW FILE')),
    );
  });
}

// ---------- Wiring ----------

async function refresh() {
  if (!V.available) return;
  try {
    const [status, settings, jobs] = await Promise.all([call('status'), V.loaded ? Promise.resolve(V.settings) : call('getSettings'), call('listJobs')]);
    V.ffmpeg = status.ffmpeg;
    // Runs this page didn't start (a reload mid-run) still show up.
    (jobs || []).forEach((job) => {
      if (!V.runs.has(job.jobId)) V.runs.set(job.jobId, { ...job, lines: [], task: null });
    });
    if (!V.loaded) {
      V.settings = settings || {};
      const preset = [...PRESETS, ...(V.settings.customPresets || [])].find((p) => p.key === V.settings.preset) || PRESETS[0];
      V.values = { ...Object.fromEntries(OPTION_FIELDS.map((f) => [f.key, f.value])), ...preset.values, ...(V.settings.detectOptions || {}) };
      if (V.settings.defaultOutDir) $('splicer-out').value = V.settings.defaultOutDir;
      $('splicer-combine-reencode').checked = !!V.settings.combineReencode;
      renderPresetSelect();
      renderOptions();
      renderQueue();
      V.loaded = true;
    }
  } catch (e) {
    V.ffmpeg = false;
    showError('split', e);
  }
  const ffmpegNote = $('splicer-ffmpeg-note');
  ffmpegNote.classList.toggle('hidden', V.ffmpeg);
  ffmpegNote.textContent = V.ffmpeg ? '' : 'The splicer needs FFmpeg. Turn on FFmpeg Transcode in PLUG-INS, or install FFmpeg from its settings there.';
  ['splicer-detect-btn', 'splicer-review-btn', 'splicer-split-btn', 'splicer-combine-btn'].forEach((id) => { $(id).disabled = !V.ffmpeg; });
  renderRuns();
}

function wire() {
  const panel = document.querySelector('[data-subtab-panel="librarysplicer"]');
  if (!panel) return;
  if (!V.available) {
    // A LAN viewer: the splicer works on the host's disk.
    panel.querySelector('.settings-grid').replaceChildren(h('div', { className: 'panel span-full' },
      h('div', { className: 'panel-toggle', text: 'VIDEO SPLICER' }),
      EmptyState({ message: 'The Video Splicer works on the computer RerunTV runs on. Open setup there to split or combine recordings.' })));
    return;
  }
  window.api.onSplicerJob(onJobEvent);

  $('splicer-source-file-btn').addEventListener('click', async () => {
    const picked = await call('pickFile', { kind: 'video' }).catch((e) => { showError('split', e); return null; });
    if (picked) setSource(picked, false);
  });
  $('splicer-source-folder-btn').addEventListener('click', async () => {
    const picked = await call('pickFolder', { title: 'Choose a folder of recordings' }).catch((e) => { showError('split', e); return null; });
    if (picked) setSource(picked, true);
  });
  // Typed or pasted: the host says whether it's a file or a folder.
  $('splicer-source').addEventListener('change', async () => {
    const value = $('splicer-source').value.trim();
    if (!value) { setSource('', false); return; }
    const { kind } = await call('pathKind', { path: value }).catch(() => ({ kind: 'missing' }));
    setSource(value, kind === 'folder', kind === 'missing');
  });
  $('splicer-out-btn').addEventListener('click', async () => {
    const picked = await call('pickFolder', { title: 'Save clips to', defaultPath: $('splicer-out').value.trim() || undefined }).catch((e) => { showError('split', e); return null; });
    if (picked) { $('splicer-out').value = picked; saveSettingsSoon({ defaultOutDir: picked }); }
  });
  $('splicer-out').addEventListener('change', () => saveSettingsSoon({ defaultOutDir: $('splicer-out').value.trim() }));
  $('splicer-preset').addEventListener('change', () => applyPreset($('splicer-preset').value));
  $('splicer-preset-save-btn').addEventListener('click', savePreset);
  $('splicer-preset-delete-btn').addEventListener('click', deletePreset);
  $('splicer-detect-btn').addEventListener('click', () => findCuts(false));
  $('splicer-review-btn').addEventListener('click', () => findCuts(true));
  $('splicer-split-btn').addEventListener('click', splitNow);
  $('splicer-runs-clear-btn').addEventListener('click', () => {
    V.runs.forEach((run, id) => { if (run.state === 'done') V.runs.delete(id); });
    renderRuns();
  });

  $('splicer-add-clips-btn').addEventListener('click', async () => {
    const picked = await call('pickFile', { kind: 'videos' }).catch((e) => { showError('combine', e); return null; });
    if (picked) addClips(picked);
  });
  $('splicer-add-folder-btn').addEventListener('click', async () => {
    const dir = await call('pickFolder', { title: 'Add every video in a folder' }).catch((e) => { showError('combine', e); return null; });
    if (!dir) return;
    const files = await call('listVideos', { dir }).catch((e) => { showError('combine', e); return []; });
    if (!files.length) $('splicer-combine-results').replaceChildren(note('That folder has no videos in it.', 'warning'));
    addClips(files);
  });
  $('splicer-clear-btn').addEventListener('click', () => {
    V.queue = [];
    const video = $('splicer-preview');
    video.removeAttribute('src');
    video.hidden = true;
    renderQueue();
  });
  $('splicer-combine-out-btn').addEventListener('click', async () => {
    const picked = await call('pickSaveFile', { defaultPath: $('splicer-combine-out').value.trim() || undefined }).catch((e) => { showError('combine', e); return null; });
    if (picked) $('splicer-combine-out').value = picked;
  });
  $('splicer-combine-reencode').addEventListener('change', () => saveSettingsSoon({ combineReencode: $('splicer-combine-reencode').checked }));
  $('splicer-combine-btn').addEventListener('click', combine);

  document.querySelector('.setup-subtab-btn[data-subtab="librarysplicer"]')?.addEventListener('click', refresh);
}

// Called from renderSettingsPanels whenever the setup screen opens.
export function renderSplicerPanels() {
  refresh();
}

if (typeof document !== 'undefined') wire();
