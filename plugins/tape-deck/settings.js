// PLUGINS-tab settings for the tape deck: how tapes are recorded, the timer
// that records something later, and the shelf of finished tapes with each
// one's cover art.
//
// Kept out of renderer.js so the deck's playback lifecycle and this panel do
// not share a file, the same split every other first-party plugin uses.
// Recording itself is not reimplemented here — the panel calls through to the
// renderer service the deck registers, so the planner has exactly one home.
const PLUGIN_ID = 'tape-deck';

// A settings SECTION gets a much narrower ctx than a channel does — see
// renderPluginSettings (setup-plugin-settings.js). Its `ctx.settings` is the
// stored VALUES, not a namespace of functions, and there is no ctx.channels
// at all. Worse for a panel like this one, those values are a snapshot taken
// when the section was rendered, so a painter that redraws itself after a
// write would read back what was there before it.
//
// Both problems go away by reading and writing through the renderer-wide ctx,
// which is always current — the same thing film-reel-marks and
// music-choice-channel do for the same reason.
function core() {
  return window.RCBPlugins.ctx;
}

function readSettings() {
  return core().settings.getPluginSettings(PLUGIN_ID) || {};
}

function writeSettings(patch) {
  core().settings.updatePluginSettings(PLUGIN_ID, patch);
}

// Mirrors the renderer's own table for labels and running times. Kept short
// on purpose: the authoritative capacity check lives in renderer.js and the
// encode settings in main.js, and this only needs enough to fill a dropdown.
const MODE_LABELS = [
  ['vhs-sp', 'VHS · SP — BEST PICTURE, UP TO 2 HOURS'],
  ['vhs-lp', 'VHS · LP — SOFTER, UP TO 4 HOURS'],
  ['vhs-ep', 'VHS · EP — ROUGHEST, UP TO 6 HOURS'],
  ['dvd-sd', 'DVD · SD — 720×480, UP TO 2 HOURS'],
  ['bluray', 'BLU-RAY · HD — 1080p, UP TO 4 HOURS'],
  ['unlimited', 'UNLIMITED — ANY LENGTH, QUALITY BELOW'],
];

// Three pictures per tape, all optional: the two faces of its case, and the
// label on the physical cassette or disc inside it — which was never the
// same artwork as the cover.
const ART_SLOTS = [
  ['front', 'FRONT COVER'],
  ['back', 'BACK COVER'],
  ['label', 'CASSETTE / DISC LABEL'],
];

function deckService() {
  return window.RCBPlugins.getRendererService(PLUGIN_ID);
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}h ${pad(m)}m` : `${m}m ${pad(s % 60)}s`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// <input type="datetime-local"> wants a local-time string with no zone, and
// gives one back. Converting by hand rather than through toISOString, which
// would silently shift everything by the UTC offset.
function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function settingsOf() {
  const cfg = readSettings();
  const known = MODE_LABELS.map(([id]) => id);
  return {
    format: cfg.format === 'dvd' ? 'dvd' : 'vhs',
    quality: ['480', '720', '1080'].includes(String(cfg.quality)) ? String(cfg.quality) : '720',
    recordMode: known.includes(cfg.recordMode) ? cfg.recordMode : 'vhs-sp',
    degrade: ['off', 'subtle', 'true'].includes(cfg.degrade) ? cfg.degrade : 'true',
    recordOnto: cfg.recordOnto === 'oldest' ? 'oldest' : 'new',
    defaultMinutes: Number.isFinite(cfg.defaultMinutes) ? cfg.defaultMinutes : 30,
    scheduled: Array.isArray(cfg.scheduled) ? cfg.scheduled : [],
  };
}

function soundsOf() {
  const stored = readSettings().sounds;
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function animationsOf() {
  const stored = readSettings().animations;
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

// Loose on purpose: comparing two folder paths for a UI hint, where Windows
// differs in case and separator without meaning anything by it.
function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// The file picker returns a full path; only its last segment is worth showing
// in a row that already has a label.
function basenameOf(filePath) {
  return String(filePath || '').split(/[\\/]/).pop();
}

function recordableChannels() {
  return core().channels.sortedChannels().filter((channel) => !channel.hidden && (channel.files || []).length);
}

function tapeLine(tape) {
  const wear = tape.media === 'disc' ? 0 : (tape.generation || 0);
  return [
    tape.title || 'UNTITLED',
    `CH ${tape.channelNumber}`,
    new Date(tape.startMs || tape.recordedMs).toLocaleString(),
    formatDuration(tape.durationS || 0),
    wear ? `GEN ${wear}` : 'FIRST RECORDING',
  ].join(' · ');
}

// Draws the sound-slot rows. Standalone, like every other painter here, so a
// handler can redraw through the exact path that drew it.
function paintSounds(container) {
  const service = deckService();
  if (!service || typeof service.soundSlots !== 'function') {
    container.innerHTML = '<span class="panel-status">The tape deck channel has not loaded — is the plugin enabled?</span>';
    return;
  }
  // The slot list comes from the deck itself rather than being restated
  // here, so adding a sound never means editing two files.
  const slots = service.soundSlots();
  const chosen = soundsOf();
  container.innerHTML = `
    <span class="panel-status">Every noise the machine makes has a built-in default, synthesized from the app's own sound primitives — nothing needs to be supplied for the deck to sound like a deck. Point a slot at your own recording and it plays instead. A file that will not load falls back to its default rather than going silent.</span>
    ${slots.map(({ id, label }) => `
      <div class="panel-interval" data-slot="${id}" style="gap:6px;flex-wrap:wrap">
        <span style="min-width:14rem">${escapeHtml(label)}</span>
        <span class="panel-status" style="min-width:10rem">${chosen[id] ? escapeHtml(basenameOf(chosen[id])) : 'BUILT-IN'}</span>
        <button class="btn" data-el="choose">CHOOSE SOUND</button>
        <button class="btn" data-el="test">TEST</button>
        <button class="btn remove-btn" data-el="reset"${chosen[id] ? '' : ' disabled'}>USE BUILT-IN</button>
      </div>
    `).join('')}
    <span class="panel-status">Custom sounds play through the app's own effects channel, so they follow the same mute and volume as everything else.</span>
  `;
  container.querySelectorAll('[data-slot]').forEach((row) => {
    const slot = row.getAttribute('data-slot');
    const save = (value) => {
      const next = { ...soundsOf() };
      if (value) next[slot] = value; else delete next[slot];
      writeSettings({ sounds: next });
      paintSounds(container);
    };
    row.querySelector('[data-el="choose"]').addEventListener('click', async () => {
      const picked = await window.api.selectAudio();
      // A cancelled picker is not a request to clear the slot.
      if (picked) save(picked);
    });
    row.querySelector('[data-el="test"]').addEventListener('click', () => service.previewSound(slot));
    row.querySelector('[data-el="reset"]').addEventListener('click', () => save(null));
  });
}

// Draws the animation-slot rows.
function paintAnimations(container) {
  const service = deckService();
  if (!service || typeof service.animationSlots !== 'function') {
    container.innerHTML = '<span class="panel-status">The tape deck channel has not loaded — is the plugin enabled?</span>';
    return;
  }
  const slots = service.animationSlots();
  const chosen = animationsOf();
  container.innerHTML = `
    <span class="panel-status">The three moments the machine does something on its own. Each has a built-in animation; supply your own picture and it plays over the top for that phase. Use an animated GIF, APNG or WebP — an image rather than a video, so nothing competes with the player about to be handed a file.</span>
    ${slots.map(({ id, label, defaultMs }) => {
    const entry = chosen[id] || {};
    return `
      <div class="panel-interval" data-slot="${id}" style="gap:6px;flex-wrap:wrap">
        <span style="min-width:14rem">${escapeHtml(label)}</span>
        <span class="panel-status" style="min-width:10rem">${entry.path ? escapeHtml(basenameOf(entry.path)) : 'BUILT-IN'}</span>
        <button class="btn" data-el="choose">CHOOSE IMAGE</button>
        <label class="panel-interval" style="gap:4px">LASTS
          <input type="number" min="100" max="20000" step="50" data-el="ms" style="width:84px"
                 value="${Number.isFinite(entry.ms) ? entry.ms : defaultMs}"> MS
        </label>
        <button class="btn remove-btn" data-el="reset"${entry.path || Number.isFinite(entry.ms) ? '' : ' disabled'}>USE BUILT-IN</button>
      </div>
    `;
  }).join('')}
    <span class="panel-status">The length sets how long that phase takes, so a supplied animation runs at its own pace instead of being cut off by the built-in timing.</span>
  `;
  container.querySelectorAll('[data-slot]').forEach((row) => {
    const slot = row.getAttribute('data-slot');
    const defaultMs = (slots.find((entry) => entry.id === slot) || {}).defaultMs;
    const save = (patch) => {
      const next = { ...animationsOf() };
      const merged = { ...(next[slot] || {}), ...patch };
      if (!merged.path && !Number.isFinite(merged.ms)) delete next[slot];
      else next[slot] = merged;
      writeSettings({ animations: next });
      paintAnimations(container);
    };
    row.querySelector('[data-el="choose"]').addEventListener('click', async () => {
      const picked = await window.api.selectImage();
      if (picked) save({ path: picked });
    });
    const msEl = row.querySelector('[data-el="ms"]');
    msEl.addEventListener('change', () => {
      // A number input accepts anything typed; min/max only style it.
      const n = Math.round(Number(msEl.value));
      const value = Number.isFinite(n) ? Math.min(20000, Math.max(100, n)) : defaultMs;
      msEl.value = value;
      save({ ms: value });
    });
    row.querySelector('[data-el="reset"]').addEventListener('click', () => {
      const next = { ...animationsOf() };
      delete next[slot];
      writeSettings({ animations: next });
      paintAnimations(container);
    });
  });
}

// Draws the disc section: what is in a drive right now, and the option to
// point at a VIDEO_TS folder instead.
async function paintDiscs(container) {
  const chosen = readSettings().discFolder || '';
  let drives = [];
  if (typeof window.api.checkPathsExist === 'function') {
    const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    try {
      const found = await window.api.checkPathsExist(letters.map((l) => `${l}:\\VIDEO_TS\\VIDEO_TS.IFO`));
      drives = letters.filter((l, i) => found[i]);
    } catch (e) {
      drives = [];
    }
  }
  container.innerHTML = `
    <span class="panel-status">A DVD shows up on CH 101 next to your tapes. Choose it there and the deck reads what is on the disc, then keeping a title copies it to the shelf as an ordinary tape — with its own chapters, taken from the disc's own tables.</span>
    <div class="panel-interval">
      <span>IN A DRIVE NOW</span>
      <span class="panel-status" data-el="drives">${drives.length ? drives.map((l) => `${escapeHtml(l)}:`).join(', ') : 'NO DISC FOUND'}</span>
      <button class="btn" data-el="rescan">LOOK AGAIN</button>
    </div>
    <div class="panel-interval" style="gap:6px;flex-wrap:wrap">
      <span>OR A VIDEO_TS FOLDER</span>
      <span class="panel-status" style="min-width:16rem">${chosen ? escapeHtml(chosen) : 'NONE'}</span>
      <button class="btn" data-el="choose">CHOOSE FOLDER</button>
      <button class="btn remove-btn" data-el="clear"${chosen ? '' : ' disabled'}>CLEAR</button>
    </div>
    <span class="panel-status">An ISO works the same way once it is mounted — on Windows, double-click it and it appears as a drive. Mounting is left to the system on purpose, so the deck needs no extra permission to do it.</span>
    <span class="panel-status">Two limits worth knowing. Commercially pressed discs are encrypted and this does not decrypt them, so those will not read; home-authored and unprotected discs will. And the menu you get is built from the disc's own title and chapter structure rather than being the disc's pressed menu, which would need a subpicture decoder and the disc's own bytecode interpreter.</span>
  `;
  container.querySelector('[data-el="rescan"]').addEventListener('click', () => paintDiscs(container));
  container.querySelector('[data-el="choose"]').addEventListener('click', async () => {
    const picked = await window.api.selectFolder();
    // A cancelled picker is not a request to clear the folder.
    if (!picked) return;
    writeSettings({ discFolder: picked });
    paintDiscs(container);
  });
  container.querySelector('[data-el="clear"]').addEventListener('click', () => {
    writeSettings({ discFolder: '' });
    paintDiscs(container);
  });
}

// Draws the shelf of finished tapes and their artwork. Standalone rather than
// a section method so every handler below can redraw through the exact path
// that drew the list, and the panel and the disk never disagree.
async function paintLibrary(container) {
  container.innerHTML = '<span class="panel-status">Reading the tape shelf…</span>';
  if (typeof window.api.tapesList !== 'function') {
    container.innerHTML = '<span class="panel-status">The tape shelf is only readable on the machine running RerunTV.</span>';
    return;
  }
  let result;
  try {
    result = await window.api.tapesList();
  } catch (e) {
    container.innerHTML = `<span class="panel-status">Could not read the tape shelf: ${escapeHtml(e.message)}</span>`;
    return;
  }
  const tapes = (result && result.tapes) || [];
  let status = {};
  try { status = await window.api.tapesStatus(); } catch (e) { status = {}; }
  const chosen = readSettings().tapesDir || '';
  // Compared here rather than asked of the recorder: this side holds the
  // value that was just written, while the recorder can only re-read a
  // config whose save is debounced. Loose comparison on purpose — this is a
  // UI hint, and Windows paths differ in case and separator without meaning
  // anything.
  const folderPending = !!chosen && !!status.folder && normalizePath(chosen) !== normalizePath(status.folder);
  container.innerHTML = `
    <span class="panel-status">${tapes.length ? `${tapes.length} TAPE${tapes.length === 1 ? '' : 'S'}.` : 'No recordings yet.'} Tapes are being written to <code>${escapeHtml((result && result.folder) || '')}</code> and play on CH 101.</span>
    <div class="panel-interval" style="gap:6px;flex-wrap:wrap">
      TAPE FOLDER
      <span class="panel-status" style="min-width:16rem">${chosen ? escapeHtml(chosen) : 'THE PLUGIN&rsquo;S OWN FOLDER'}</span>
      <button class="btn" data-el="choose-dir">CHOOSE FOLDER</button>
      <button class="btn remove-btn" data-el="default-dir"${chosen ? '' : ' disabled'}>USE THE DEFAULT</button>
    </div>
    ${folderPending ? '<span class="panel-status">That folder takes effect after a restart. Until then tapes keep going to the folder above — the deck is sandboxed, and the folders it may write to are fixed when the app starts.</span>' : ''}
    <span class="panel-status">Moving the folder does not move the tapes already in the old one. Copy them across yourself if you want them on the shelf.</span>
    <span class="panel-status">Artwork is optional and per tape. FRONT and BACK are the two faces of its case — press D on CH 101 to turn a case over. CASSETTE / DISC LABEL is the picture on the physical media itself, which shows on the cassette or disc lying in the open case, and again on it as it goes into the deck. Cassette colour tints the shell and the case spine; a disc ignores it.</span>
    ${tapes.map((tape) => `
      <div class="panel-body" data-tape="${escapeHtml(tape.id)}" style="margin-bottom:10px">
        <div class="panel-interval"><span>${escapeHtml(tapeLine(tape))}</span></div>
        <div class="panel-interval" style="gap:6px;flex-wrap:wrap">
          ${ART_SLOTS.map(([slot, label]) => `
            <button class="btn" data-art="${slot}">${label}${(tape.art || {})[slot] ? ' ✓' : ''}</button>
          `).join('')}
          <label class="panel-interval" style="gap:4px">CASSETTE COLOUR
            <input type="color" data-el="shell" value="${escapeHtml(tape.shellColor || '#444444')}">
          </label>
          <button class="btn" data-el="clear-art">CLEAR ART</button>
          <button class="btn remove-btn" data-el="erase">ERASE TAPE</button>
        </div>
      </div>
    `).join('')}
  `;

  container.querySelector('[data-el="choose-dir"]').addEventListener('click', async () => {
    const picked = await window.api.selectFolder();
    // A cancelled picker is not a request to reset to the default.
    if (!picked) return;
    writeSettings({ tapesDir: picked });
    paintLibrary(container);
  });
  container.querySelector('[data-el="default-dir"]').addEventListener('click', () => {
    writeSettings({ tapesDir: '' });
    paintLibrary(container);
  });

  container.querySelectorAll('[data-tape]').forEach((row) => {
    const id = row.getAttribute('data-tape');
    const apply = async (art) => {
      const outcome = await window.api.tapesSetArt({ id, art });
      if (outcome && outcome.error) {
        row.insertAdjacentHTML('beforeend', `<span class="panel-status">${escapeHtml(outcome.error)}</span>`);
        return;
      }
      paintLibrary(container);
    };
    row.querySelectorAll('[data-art]').forEach((button) => {
      button.addEventListener('click', async () => {
        const slot = button.getAttribute('data-art');
        const picked = await window.api.selectImage();
        // A cancelled picker is not a request to clear the slot — leave it.
        if (!picked) return;
        apply({ [slot]: picked });
      });
    });
    const shell = row.querySelector('[data-el="shell"]');
    if (shell) shell.addEventListener('change', () => apply({ shellColor: shell.value }));
    row.querySelector('[data-el="clear-art"]').addEventListener('click', () => (
      apply({ front: null, back: null, label: null, shellColor: null })
    ));
    row.querySelector('[data-el="erase"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'ERASING…';
      await window.api.tapesDelete(id);
      paintLibrary(container);
    });
  });
}

window.RCBPlugins.registerPluginSettings(PLUGIN_ID, {
  schemaVersion: 1,
  defaults: {
    format: 'vhs',
    quality: '720',
    recordMode: 'vhs-sp',
    degrade: 'true',
    recordOnto: 'new',
    defaultMinutes: 30,
    scheduled: [],
    sounds: {},
    animations: {},
    tapesDir: '',
    discFolder: '',
  },
  validate(values) {
    const errors = [];
    if (!['vhs', 'dvd'].includes(values.format)) errors.push('format must be vhs or dvd');
    if (!['480', '720', '1080'].includes(String(values.quality))) errors.push('quality must be 480, 720 or 1080');
    if (!MODE_LABELS.some(([id]) => id === values.recordMode)) errors.push('recordMode is not a known format');
    if (!['off', 'subtle', 'true'].includes(values.degrade)) errors.push('degrade must be off, subtle or true');
    if (!['new', 'oldest'].includes(values.recordOnto)) errors.push('recordOnto must be new or oldest');
    if (!(values.defaultMinutes >= 1 && values.defaultMinutes <= 480)) errors.push('defaultMinutes must be 1-480');
    if (!Array.isArray(values.scheduled)) errors.push('scheduled must be a list');
    const isMap = (v) => v == null || (typeof v === 'object' && !Array.isArray(v));
    if (!isMap(values.sounds)) errors.push('sounds must be an object of slot -> file path');
    if (!isMap(values.animations)) errors.push('animations must be an object of slot -> {path, ms}');
    if (values.tapesDir != null && typeof values.tapesDir !== 'string') errors.push('tapesDir must be a folder path');
    if (values.discFolder != null && typeof values.discFolder !== 'string') errors.push('discFolder must be a folder path');
    return errors;
  },
  sections: [
    {
      id: 'deck',
      async render(container) {
        const cfg = settingsOf();
        const missing = typeof window.api.tapesRecord !== 'function';
        // Asked rather than assumed: only the recorder's own process can see
        // whether ffmpeg actually resolved, and reporting it here beats
        // letting the first recording be the thing that finds out.
        let ffmpegReady = true;
        if (!missing) {
          try { ffmpegReady = !!(await window.api.tapesStatus()).ffmpegReady; } catch (e) { ffmpegReady = false; }
        }
        container.innerHTML = `
          <span class="panel-status">Records what a channel actually broadcasts across a time range — the shows plus the bumpers and commercials in between — into one file, by cutting your own source files with ffmpeg and joining them. The schedule is worked out in advance, so a range tapes faster than it would have aired.</span>
          ${missing ? '<span class="panel-status">Recording is unavailable on this device — the tape deck only records on the machine running RerunTV, not in the LAN viewer.</span>' : ''}
          ${!missing && !ffmpegReady ? '<span class="panel-status">ffmpeg is not available right now, so nothing can be recorded. Enable the FFmpeg Transcode plugin, or point it at an ffmpeg binary in its own settings panel, then restart.</span>' : ''}
          <div class="panel-interval">
            RECORDING FORMAT
            <select data-el="mode" style="margin-left:8px">
              ${MODE_LABELS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}
            </select>
          </div>
          <span class="panel-status">A VCR bought running time with picture: LP and EP really do record softer here, not just under a different name. Each format also refuses a range longer than it holds, the way running out of tape did. UNLIMITED has no format and no limit — any length, at the quality below.</span>
          <div class="panel-interval">
            UNLIMITED QUALITY
            <select data-el="quality" style="margin-left:8px">
              <option value="480">480p — SMALLEST, FASTEST</option>
              <option value="720">720p — BALANCED</option>
              <option value="1080">1080p — LARGEST, SLOWEST</option>
            </select>
          </div>
          <div class="panel-interval">
            DECK FOR UNLIMITED RECORDINGS
            <select data-el="format" style="margin-left:8px">
              <option value="vhs">VCR — CASSETTE, TRACKING, AUTO-REWIND</option>
              <option value="dvd">DISC PLAYER — TRAY, TITLE MENU, CHAPTERS</option>
            </select>
          </div>
          <span class="panel-status">Every other format already knows which machine it belongs in, so a shelf can hold cassettes and discs side by side and each loads in its own deck. This only decides where an UNLIMITED recording goes.</span>
          <div class="panel-interval">
            R KEY RECORDS <input type="number" min="1" max="480" data-el="minutes" style="width:70px"> MINUTES ONTO
            <select data-el="onto" style="margin-left:8px">
              <option value="new">A BRAND-NEW BLANK</option>
              <option value="oldest">THE OLDEST TAPE ON THE SHELF</option>
            </select>
          </div>
          <div class="panel-interval">
            WEAR WHEN RECORDING OVER A TAPE
            <select data-el="degrade" style="margin-left:8px">
              <option value="true">TRUE TO LIFE — EACH PASS COSTS PICTURE</option>
              <option value="subtle">SUBTLE — HALF AS MUCH</option>
              <option value="off">OFF — EVERY RECORDING IS CLEAN</option>
            </select>
          </div>
          <span class="panel-status">Recording over a cassette really did cost picture every pass, so the wear is encoded into the file rather than painted over a pristine one — it compounds, and it is permanent. A disc never wears: burning it again writes clean data, so a re-recorded disc looks exactly like a fresh one.</span>
          <span class="panel-status">Cuts are re-encoded rather than stream-copied, so every segment starts on the exact frame the schedule says and the joins are seamless. That costs time: expect roughly a quarter to a half of the recorded duration on a typical machine.</span>
        `;
        const q = (name) => container.querySelector(`[data-el="${name}"]`);
        const modeEl = q('mode');
        const qualityEl = q('quality');
        const formatEl = q('format');
        const minutesEl = q('minutes');
        const ontoEl = q('onto');
        const degradeEl = q('degrade');
        modeEl.value = cfg.recordMode;
        qualityEl.value = cfg.quality;
        formatEl.value = cfg.format;
        minutesEl.value = cfg.defaultMinutes;
        ontoEl.value = cfg.recordOnto;
        degradeEl.value = cfg.degrade;

        const save = (patch) => writeSettings(patch);
        modeEl.addEventListener('change', () => save({ recordMode: modeEl.value }));
        qualityEl.addEventListener('change', () => save({ quality: qualityEl.value }));
        formatEl.addEventListener('change', () => save({ format: formatEl.value === 'dvd' ? 'dvd' : 'vhs' }));
        ontoEl.addEventListener('change', () => save({ recordOnto: ontoEl.value }));
        degradeEl.addEventListener('change', () => save({ degrade: degradeEl.value }));
        minutesEl.addEventListener('change', () => {
          // A number input accepts anything typed; min/max only style it.
          const n = Math.round(Number(minutesEl.value));
          const value = Number.isFinite(n) ? Math.min(480, Math.max(1, n)) : 30;
          minutesEl.value = value;
          save({ defaultMinutes: value });
        });
      },
    },
    {
      id: 'record-now',
      async render(container) {
        const channels = recordableChannels();
        const nowMs = Date.now(); // seeding a form field with the wall clock, not a schedule read
        let tapes = [];
        if (typeof window.api.tapesList === 'function') {
          try { tapes = (await window.api.tapesList()).tapes || []; } catch (e) { tapes = []; }
        }
        container.innerHTML = `
          <span class="panel-status">Record a range straight away, or set a timer for one. A timer fires against the real clock; what it tapes is worked out from the times below either way.</span>
          <div class="panel-interval">
            CHANNEL
            <select data-el="channel" style="margin-left:8px">
              ${channels.map((c) => `<option value="${c.number}">${c.number} · ${escapeHtml(c.name || 'UNTITLED')}</option>`).join('')}
            </select>
          </div>
          <div class="panel-interval">
            FROM <input type="datetime-local" data-el="start" style="margin-left:8px">
          </div>
          <div class="panel-interval">
            FOR <input type="number" min="1" max="480" data-el="length" style="width:70px"> MINUTES
          </div>
          <div class="panel-interval">
            ONTO
            <select data-el="onto" style="margin-left:8px">
              <option value="">A BRAND-NEW BLANK</option>
              ${tapes.map((tape) => `<option value="${escapeHtml(tape.id)}">OVER: ${escapeHtml(tapeLine(tape))}</option>`).join('')}
            </select>
          </div>
          <div class="panel-interval" style="gap:8px">
            <button class="btn btn-primary" data-el="now">RECORD NOW</button>
            <button class="btn" data-el="later">SET TIMER</button>
          </div>
          <span class="panel-status" data-el="status"></span>
          <div data-el="timers"></div>
        `;
        const q = (name) => container.querySelector(`[data-el="${name}"]`);
        const channelEl = q('channel');
        const startEl = q('start');
        const lengthEl = q('length');
        const ontoEl = q('onto');
        const statusEl = q('status');
        const timersEl = q('timers');
        startEl.value = toLocalInputValue(nowMs);
        lengthEl.value = settingsOf().defaultMinutes;

        if (!channels.length) {
          statusEl.textContent = 'No channel has any content yet — add files to a channel first.';
        }

        const readRange = () => {
          const channel = core().channels.getChannel(Number(channelEl.value));
          const startMs = new Date(startEl.value).getTime();
          const minutes = Math.min(480, Math.max(1, Math.round(Number(lengthEl.value)) || 30));
          return { channel, startMs, minutes, overwriteId: ontoEl.value || null };
        };

        function paintTimers() {
          const { scheduled } = settingsOf();
          const pending = scheduled.filter((entry) => entry && !entry.done);
          if (!pending.length) { timersEl.innerHTML = ''; return; }
          timersEl.innerHTML = `
            <span class="panel-status">TIMERS WAITING</span>
            ${pending.map((entry) => `
              <div class="panel-interval">
                <span>CH ${entry.channelNumber} · ${escapeHtml(entry.label || 'RECORDING')} · ${new Date(entry.startMs).toLocaleString()} · ${formatDuration((entry.endMs - entry.startMs) / 1000)}${entry.overwriteId ? ' · OVER AN EXISTING TAPE' : ''}</span>
                <button class="btn remove-btn" data-cancel="${escapeHtml(entry.id)}" style="margin-left:8px">CANCEL</button>
              </div>
            `).join('')}
          `;
          timersEl.querySelectorAll('[data-cancel]').forEach((button) => {
            button.addEventListener('click', () => {
              const id = button.getAttribute('data-cancel');
              const next = settingsOf().scheduled.filter((entry) => entry.id !== id);
              writeSettings({ scheduled: next });
              paintTimers();
            });
          });
        }

        q('now').addEventListener('click', async () => {
          const { channel, startMs, minutes, overwriteId } = readRange();
          if (!channel || !Number.isFinite(startMs)) { statusEl.textContent = 'Pick a channel and a valid start time.'; return; }
          const service = deckService();
          if (!service) { statusEl.textContent = 'The tape deck channel has not loaded — is the plugin enabled?'; return; }
          statusEl.textContent = 'Reading the schedule…';
          const outcome = await service.record({
            channel, startMs, endMs: startMs + minutes * 60000, overwriteId,
          });
          statusEl.textContent = outcome && outcome.error
            ? outcome.error
            : 'Recording started. Watch the progress on live TV, and find the tape on CH 101 when it finishes.';
        });

        q('later').addEventListener('click', () => {
          const { channel, startMs, minutes, overwriteId } = readRange();
          if (!channel || !Number.isFinite(startMs)) { statusEl.textContent = 'Pick a channel and a valid start time.'; return; }
          const entry = {
            // Wall-clock stamp plus a random tail: this is only an id, and
            // two timers set in the same millisecond should not collide.
            id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
            channelNumber: channel.number,
            label: channel.name || `CHANNEL ${channel.number}`,
            startMs,
            endMs: startMs + minutes * 60000,
            overwriteId,
            done: false,
          };
          const next = settingsOf().scheduled.concat([entry]);
          writeSettings({ scheduled: next });
          statusEl.textContent = `Timer set for ${new Date(startMs).toLocaleString()}.`;
          paintTimers();
        });

        paintTimers();
      },
    },
    {
      id: 'sounds',
      render(container) { paintSounds(container); },
    },
    {
      id: 'animations',
      render(container) { paintAnimations(container); },
    },
    {
      id: 'discs',
      render(container) { paintDiscs(container); },
    },
    {
      id: 'library',
      render(container) {
        paintLibrary(container);
      },
    },
  ],
});
