// The Video Splicer's host side (setup › LIBRARY › SPLICER). One object,
// called through IPC `splicer:call`, that:
//   * turns a request from the page into a splice.js / combine.js command
//     line (jobArgs, pure),
//   * queues it, and runs one at a time in an Electron utility process —
//     Electron's own Node, so no separate Node.js install is needed —
//     streaming its output back as `splicer:job` events (queued, start,
//     progress, log, done),
//   * cancels a run by asking the script to stop its ffmpeg first
//     (ffmpeg-runner.js), with a hard kill as the fallback,
//   * remembers the page's defaults in <userData>/video-splicer/settings.json.
//     That is the folder the old Video Splicer plugin used, so its remembered
//     folders carry over. Nothing here is lineup config, so none of it goes
//     through channels.json or undo.
//
// The scripts stay the source of truth for what a split does; this file only
// decides how to ask them. Electron-free: the process launcher, dialogs and
// shell are injected (main.js passes the real ones; tests pass fakes).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPTS = {
  splice: path.join(__dirname, 'splice.js'),
  combine: path.join(__dirname, 'combine.js'),
};

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'ts', 'm4v', 'wmv', 'webm'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'bmp', 'webp'];

// Page option -> splice.js flag. Every value is checked before it becomes an
// argument: splice.js reads a value starting with "--" as a flag of its own.
const NUMBER_FLAGS = {
  minGap: '--min-gap', minClip: '--min-clip', blackThresh: '--black-thresh', silenceDb: '--silence-db',
  sceneThresh: '--scene-thresh', logoThresh: '--logo-thresh', bumperMax: '--bumper-max', commercialMax: '--commercial-max',
};
const BOOLEAN_FLAGS = {
  reencode: '--reencode', fastCut: '--fast-cut', keepGaps: '--keep-gaps', noBlack: '--no-black', noSilence: '--no-silence', noScene: '--no-scene',
};
// Flags that shape how clips are written, as opposed to how cuts are found.
const WRITE_FLAGS = ['reencode', 'fastCut', 'keepGaps'];
const SETTINGS_KEYS = ['defaultOutDir', 'lastDir', 'detectOptions', 'preset', 'customPresets', 'combineReencode', 'sendTargets'];
const JOB_KINDS = new Set(['detect', 'review', 'split', 'splitPlan', 'findRepeats', 'combine']);
const CLIP_CATEGORIES = new Set(['episodes', 'commercials', 'bumpers', 'skip']);
const MAX_QUEUE = 25;
const CANCEL_GRACE_MS = 3000;
const OUTPUT_DRAIN_MS = 1000;
// A finished job's log is kept this long, so a page that reloads mid-run can
// still collect the result.
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;

function badRequest(message) {
  const error = new Error(message);
  error.badRequest = true;
  return error;
}

function requirePath(value, what) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw badRequest(`Choose ${what} first.`);
  if (text.startsWith('-')) throw badRequest(`${what[0].toUpperCase()}${what.slice(1)} can't start with a dash.`);
  return text;
}

function optionArgs(opts = {}) {
  const args = [];
  for (const [key, flag] of Object.entries(NUMBER_FLAGS)) {
    const raw = opts[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw badRequest(`${key} must be a number.`);
    args.push(flag, String(value));
  }
  if (opts.logoTime !== undefined && String(opts.logoTime).trim() !== '') {
    const times = String(opts.logoTime).split(',').map((t) => t.trim()).filter(Boolean);
    if (!times.length || times.some((t) => !Number.isFinite(Number(t)) || Number(t) < 0)) {
      throw badRequest('Logo times are seconds into the recording, separated by commas (e.g. 9, 40.5).');
    }
    args.push('--logo-time', times.map(Number).join(','));
  }
  if (opts.logoImage) args.push('--logo-image', requirePath(opts.logoImage, 'a logo picture'));
  for (const [key, flag] of Object.entries(BOOLEAN_FLAGS)) {
    if (opts[key] === true) args.push(flag);
  }
  if (opts.noBlack === true && opts.noSilence === true && opts.noScene === true && !args.includes('--logo-time') && !args.includes('--logo-image')) {
    throw badRequest('Every way of finding a cut is turned off. Turn one back on, or give a logo to look for.');
  }
  return args;
}

// An edited cut list from the page: every value checked, nothing else kept.
function validatePlan(plan) {
  const files = plan && Array.isArray(plan.files) ? plan.files : null;
  if (!files || !files.length) throw badRequest('There are no clips to split.');
  if (files.length > 200) throw badRequest('Split at most 200 recordings at once.');
  return {
    files: files.map((file) => {
      const clips = Array.isArray(file.clips) ? file.clips : [];
      if (clips.length > 5000) throw badRequest('A recording can have at most 5,000 clips.');
      return {
        sourcePath: requirePath(file.sourcePath, 'a recording'),
        clips: clips.map((clip) => {
          const start = Number(clip.start);
          const end = Number(clip.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw badRequest('A clip has a start or end that isn’t a time.');
          const category = CLIP_CATEGORIES.has(clip.category) ? clip.category : 'episodes';
          const name = typeof clip.name === 'string' && clip.name.trim() ? clip.name.trim().slice(0, 200) : undefined;
          return { start, end, category, ...(name ? { name } : {}) };
        }),
      };
    }),
  };
}

function writeArgs(opts = {}) {
  const args = [];
  WRITE_FLAGS.forEach((key) => { if (opts[key] === true) args.push(BOOLEAN_FLAGS[key]); });
  ['bumperMax', 'commercialMax'].forEach((key) => {
    if (opts[key] !== undefined && opts[key] !== '' && Number.isFinite(Number(opts[key]))) args.push(NUMBER_FLAGS[key], String(Number(opts[key])));
  });
  return args;
}

// A request from the page -> { script, args }. Throws a person-readable
// error for anything incomplete; the page shows it as-is. Plan jobs name the
// file the service writes the (validated) plan to.
function jobArgs(request = {}, { planFile = '<plan>' } = {}) {
  const { kind } = request;
  if (!JOB_KINDS.has(kind)) throw badRequest(`Unknown splicer job "${kind}".`);
  const out = typeof request.out === 'string' && request.out.trim() ? requirePath(request.out, 'where to save') : null;

  if (kind === 'combine') {
    const files = Array.isArray(request.files) ? request.files : [];
    if (files.length < 2) throw badRequest('Add at least two clips to combine.');
    if (!out) throw badRequest('Choose where to save the combined file.');
    const args = [...files.map((file) => requirePath(file, 'a clip')), '--out', out];
    if (request.reencode === true) args.push('--reencode');
    return { script: 'combine', args };
  }

  if (kind === 'splitPlan' || kind === 'findRepeats') {
    const plan = validatePlan(request.plan);
    if (kind === 'findRepeats') return { script: 'splice', args: ['--find-repeats', planFile], plan };
    const where = out || path.join(path.dirname(plan.files[0].sourcePath), 'output');
    return { script: 'splice', args: ['--plan', planFile, '--out', where, ...writeArgs(request.opts)], plan };
  }

  const target = request.folder
    ? ['--dir', requirePath(request.folder, 'a folder of recordings')]
    : [requirePath(request.input, 'a recording')];
  const mode = kind === 'detect' ? ['--dry-run'] : kind === 'review' ? ['--review'] : [];
  return { script: 'splice', args: [...target, ...mode, ...optionArgs(request.opts), ...(out ? ['--out', out] : [])] };
}

// The scripts print "[current/total]" on the lines that mark progress.
function progressOf(line) {
  const m = /\[(\d+)\/(\d+)\]/.exec(line);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}

// Review results name each thumbnail relative to its folder; the page wants
// a path it can hand to toFileUrl.
function withThumbPaths(result) {
  if (!result) return result;
  const groups = result.files || [result];
  groups.forEach((group) => {
    if (!group || !group.reviewDir || !Array.isArray(group.candidates)) return;
    group.candidates.forEach((c) => { c.thumbPath = path.join(group.reviewDir, c.thumb); });
  });
  return result;
}

// Stops a run and every ffmpeg under it. On Windows a killed parent leaves
// its children running, so the whole tree goes at once.
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { child.kill(); } catch (e) { /* already gone */ }
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function createSplicerService({ dataDir, getFfmpegPath, fork, dialogs = {}, showItemInFolder = () => {}, emit = () => {}, tmpDir = os.tmpdir() }) {
  const settingsPath = path.join(dataDir, 'settings.json');
  const jobs = new Map();

  function loadSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveSettings(patch = {}) {
    const next = { ...loadSettings() };
    for (const key of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
    return next;
  }

  function rememberDir(filePath) {
    if (!filePath) return;
    const dir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    try { saveSettings({ lastDir: dir }); } catch (e) { /* best-effort */ }
  }

  function defaultPath(requested) {
    return requested || loadSettings().lastDir || undefined;
  }

  function send(jobId, type, data) {
    const job = jobs.get(jobId);
    if (job && (type === 'log' || type === 'progress')) {
      job.log.push({ type, ...data });
      if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
      if (type === 'progress') job.progress = { current: data.current, total: data.total };
    }
    emit({ jobId, type, ...data });
  }

  const waiting = () => Array.from(jobs.values()).filter((job) => job.state === 'waiting');
  const running = () => Array.from(jobs.values()).find((job) => job.state === 'running');

  // Checked now, run when its turn comes: a mistake is reported at once, not
  // after an hour in the queue.
  function startJob(request) {
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) throw badRequest('The splicer needs FFmpeg. Turn on FFmpeg Transcode in PLUG-INS, or install FFmpeg there.');
    const jobId = crypto.randomBytes(8).toString('hex');
    const planFile = path.join(tmpDir, `reruntv-splicer-plan-${jobId}.json`);
    const built = jobArgs(request, { planFile });
    if (waiting().length >= MAX_QUEUE) throw badRequest(`${MAX_QUEUE} runs are already waiting. Let some finish first.`);
    const label = typeof request.label === 'string' && request.label.trim() ? request.label.trim().slice(0, 160) : request.kind;
    const ahead = waiting().length + (running() ? 1 : 0);
    const job = {
      id: jobId, kind: request.kind, label, state: 'waiting', built, planFile, ffmpegPath, child: null,
      log: [], progress: null, cancelled: false, result: null,
    };
    jobs.set(jobId, job);
    send(jobId, 'queued', { kind: job.kind, label, ahead });
    pump();
    return { jobId, kind: request.kind, ahead };
  }

  function pump() {
    if (running()) return;
    const next = waiting()[0];
    if (next) launch(next);
  }

  function launch(job) {
    const jobId = job.id;
    const { script, args, plan } = job.built;
    const jsonOut = path.join(tmpDir, `reruntv-splicer-${jobId}.json`);
    job.state = 'running';
    let child;
    try {
      if (plan) fs.writeFileSync(job.planFile, JSON.stringify(plan));
      child = fork(SCRIPTS[script], [...args, '--json-out', jsonOut], {
        stdio: 'pipe',
        serviceName: 'RerunTV Video Splicer',
        env: { ...process.env, RERUNTV_FFMPEG_PATH: job.ffmpegPath },
      });
    } catch (e) {
      job.state = 'done';
      send(jobId, 'done', { code: null, result: null, error: `The splicer couldn't start (${e.message}).`, cancelled: false });
      pump();
      return;
    }
    job.child = child;
    send(jobId, 'start', { kind: job.kind, label: job.label });

    const lineReader = (stream, isError) => {
      if (!stream) return Promise.resolve();
      const handleLine = (raw) => {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) return;
        const progress = !isError && progressOf(line);
        send(jobId, progress ? 'progress' : 'log', { line, ...(progress || {}), ...(isError ? { stderr: true } : {}) });
      };
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          handleLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      return new Promise((resolve) => {
        stream.once('end', () => { handleLine(buf); resolve(); });
        stream.once('close', resolve);
        stream.once('error', resolve);
      });
    };
    const drained = Promise.all([lineReader(child.stdout, false), lineReader(child.stderr, true)]);

    child.once('exit', async (code) => {
      clearTimeout(job.killTimer);
      // The process can exit before its last lines are read — and the last
      // line is often the error worth showing.
      await Promise.race([drained, new Promise((resolve) => { setTimeout(resolve, OUTPUT_DRAIN_MS); })]);
      let result = null;
      try { result = withThumbPaths(JSON.parse(fs.readFileSync(jsonOut, 'utf8'))); } catch (e) { /* no result written */ }
      fs.rm(jsonOut, { force: true }, () => {});
      fs.rm(job.planFile, { force: true }, () => {});
      job.state = 'done';
      job.result = result;
      const error = job.cancelled ? 'Cancelled.'
        : (code !== 0 && !result) ? (lastErrorLine(job) || `The splicer stopped unexpectedly (exit code ${code}).`)
          : null;
      send(jobId, 'done', { code, result, error, cancelled: job.cancelled });
      setTimeout(() => jobs.delete(jobId), FINISHED_JOB_TTL_MS).unref?.();
      pump();
    });
  }

  function lastErrorLine(job) {
    for (let i = job.log.length - 1; i >= 0; i -= 1) {
      const line = job.log[i].line || '';
      if (/error|failed|not found|invalid/i.test(line)) return line.replace(/^\s*(Error:|FAILED:)\s*/i, '');
    }
    return '';
  }

  function cancelJob({ jobId } = {}) {
    const job = jobs.get(jobId);
    if (!job || job.state === 'done') return { cancelled: false };
    job.cancelled = true;
    if (job.state === 'waiting') {
      job.state = 'done';
      send(jobId, 'done', { code: null, result: null, error: 'Cancelled.', cancelled: true });
      return { cancelled: true };
    }
    try { job.child.postMessage('cancel'); } catch (e) { /* already exiting */ }
    job.killTimer = setTimeout(() => killTree(job.child), CANCEL_GRACE_MS);
    return { cancelled: true };
  }

  function listVideos({ dir } = {}) {
    const folder = requirePath(dir, 'a folder');
    const files = fs.readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.includes(path.extname(entry.name).slice(1).toLowerCase()))
      .map((entry) => entry.name)
      .sort(naturalSort)
      .map((name) => path.join(folder, name));
    rememberDir(folder);
    return files;
  }

  const methods = {
    status: () => ({ ffmpeg: !!getFfmpegPath() }),
    // Every run the service still remembers, oldest first — how a page that
    // was re-rendered catches up with the queue.
    listJobs: () => Array.from(jobs.values()).map((job) => ({
      jobId: job.id, kind: job.kind, label: job.label, state: job.state, progress: job.progress, cancelled: job.cancelled,
    })),
    // Whether a typed path is a file or a folder, from the disk that has it.
    pathKind: ({ path: target } = {}) => {
      const text = typeof target === 'string' ? target.trim() : '';
      if (!text) return { kind: 'missing' };
      try { return { kind: fs.statSync(text).isDirectory() ? 'folder' : 'file' }; } catch (e) { return { kind: 'missing' }; }
    },
    getSettings: () => loadSettings(),
    saveSettings: (patch) => saveSettings(patch),
    // A job's log so far and, once finished, its result — how a page that
    // was re-rendered mid-run catches up.
    getJob: ({ jobId } = {}) => {
      const job = jobs.get(jobId);
      return job ? { jobId, kind: job.kind, state: job.state, log: job.log.slice(-400), result: job.result } : null;
    },
    pickFile: async ({ kind = 'video', defaultPath: requested } = {}) => {
      const many = kind === 'videos';
      const extensions = kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
      const picked = await dialogs.open({
        title: kind === 'image' ? 'Choose a logo picture' : many ? 'Choose clips' : 'Choose a recording',
        defaultPath: defaultPath(requested),
        properties: ['openFile', ...(many ? ['multiSelections'] : [])],
        filters: [{ name: kind === 'image' ? 'Pictures' : 'Videos', extensions }, { name: 'All files', extensions: ['*'] }],
      });
      if (!picked || !picked.length) return null;
      rememberDir(picked[0]);
      return many ? picked.slice().sort(naturalSort) : picked[0];
    },
    pickFolder: async ({ defaultPath: requested, title = 'Choose a folder' } = {}) => {
      const picked = await dialogs.open({ title, defaultPath: defaultPath(requested), properties: ['openDirectory', 'createDirectory'] });
      if (!picked || !picked.length) return null;
      rememberDir(picked[0]);
      return picked[0];
    },
    pickSaveFile: async ({ defaultPath: requested } = {}) => {
      const picked = await dialogs.save({
        title: 'Save the combined file as',
        defaultPath: requested || path.join(loadSettings().lastDir || os.homedir(), 'combined.mp4'),
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }, { name: 'Matroska video', extensions: ['mkv'] }],
      });
      if (!picked) return null;
      rememberDir(picked);
      return picked;
    },
    listVideos,
    startJob,
    cancelJob,
    showInFolder: ({ path: target } = {}) => {
      const text = requirePath(target, 'a file or folder');
      if (!fs.existsSync(text)) throw badRequest(`${text} isn't there any more.`);
      showItemInFolder(text);
      return true;
    },
  };

  return {
    async call(method, payload) {
      if (!Object.prototype.hasOwnProperty.call(methods, method)) throw new Error(`Unknown splicer method "${method}".`);
      return methods[method](payload || {});
    },
    // App quit: stop every run, and its ffmpeg with it.
    dispose() {
      for (const job of jobs.values()) {
        if (job.state === 'done') continue;
        job.cancelled = true;
        job.state = 'done';
        if (job.child) killTree(job.child);
      }
    },
  };
}

function registerSplicerIpc(ipcMain, { getService }) {
  ipcMain.handle('splicer:call', async (event, method, payload) => {
    try {
      return { ok: true, result: await getService().call(method, payload) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { createSplicerService, registerSplicerIpc, jobArgs, validatePlan, progressOf };
