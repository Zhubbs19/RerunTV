# Video Splicer

Part of RerunTV: setup › LIBRARY › SPLICER. It chops a compilation recording —
episodes, commercials, and bumpers all mashed together on one tape/file — into
individual clips you can drop into your channel media folders, and joins clips
back into one file.

It looks for up to four signals at segment boundaries: a run of black frames,
a beat of silence, hard visual scene changes (frame-to-frame content
difference via ffmpeg's `scdet` filter), and — if you give it a reference
image — occurrences of a recurring logo/bumper card via template matching.
It needs FFmpeg: inside RerunTV that is the FFmpeg Transcode plug-in's copy
(or one core finds on PATH); from a terminal, `ffmpeg-static` if installed,
else `ffmpeg` on PATH.

For content where none of the automatic signals are reliable enough on their
own (see "known hard case" below), there's also a review workflow: generate
before/after thumbnails for every candidate cut, skim them, then split using
only the ones you confirm are real. See "Review workflow" below.

`combine.js` does the reverse operation — joining clips (e.g. ones this tool
split out, or any other video files) back into one file. See "Combining
clips" below.

## Files

| File | What it is |
|---|---|
| `splice.js` | Detect, review, split, split an exact plan, find repeats (command line; the source of truth for what a split does) |
| `combine.js` | Join clips into one file |
| `logo-detect.js` | Diagnostic for picking `--logo-thresh` |
| `cuts.js` | The pure decisions: merging signals into cuts, clips between cuts, sorting, logo runs, repeats (tested in `tests/splicer.test.js`) |
| `smart-cut.js` | Frame-accurate clips at nearly copy speed (see "How clips are cut") |
| `ffmpeg-runner.js` | The one ffmpeg launcher the scripts share, including cancel |
| `service.js` | RerunTV's host side: checks a page request, queues it, runs it, streams its output as `splicer:job` events |

The page's cut editor keeps its own copy of the clip math in
`renderer/js/library/splice-plan.js`; `tests/splicer.test.js` checks the two agree.

## In RerunTV

setup › LIBRARY › SPLICER (`renderer/js/setup/splicer.js`) is a front end over
the scripts: every action runs `splice.js`/`combine.js` in an Electron utility
process (Electron's own Node, so nothing else to install), one at a time, with
the rest waiting in RUNS. Runs keep going while you use the rest of RerunTV;
any of them can be cancelled, waiting or running.

- **SPLIT A RECORDING**: pick a recording (FILE…, or type a path — the host
  says whether it's a file or a folder) or a folder of them (FOLDER…, same as
  `--dir`), where the clips go, and a kind of recording (the presets below, or
  one of your own: SAVE AS… keeps the current settings under a name).
  DETECTION AND CLIP SETTINGS has every option in the table further down, in
  plain words. Then:
  - PREVIEW CUTS (`--dry-run`) and REVIEW CUTS (`--review`, with a
    before/after picture per cut) open the **cut editor**: the recording in a
    player over a timeline of its clips and cuts. Select a cut and nudge it a
    frame or a second (or with ←/→, Shift for a second), remove or restore it,
    ADD A CUT HERE at the player's position, MERGE WITH NEXT, name clips (or
    NUMBER THEM as "Series - S01E01"…), change where a clip goes including
    "Don't save", FIND REPEATS (`--find-repeats`) to mark commercials and
    bumpers that aired twice, and USE THIS FRAME AS THE LOGO to add a logo
    time. SPLIT THESE CLIPS then writes exactly that (`--plan`).
  - SPLIT cuts straight away.
  After a split, **SEND TO RERUNTV** puts the clips to work: episodes onto a
  channel (or a new one), commercials and bumpers into the ad pool as the type
  you pick. Each is an ordinary undoable edit.
- **COMBINE CLIPS**: add clips or a whole folder (filename order), reorder
  with ▲▼ or by dragging, preview any clip, choose where to save, COMBINE.
- CANCEL stops the run *and* its ffmpeg (the script is asked to stop its
  children first; the whole process tree is killed if it doesn't).
- The page remembers the output folder, the preset, your presets, every
  setting and where SEND TO RERUNTV last sent things in
  `<userData>/video-splicer/settings.json` — not in `channels.json`, and not
  part of undo.

## How clips are cut

- **Gaps are left out.** A cut is a stretch of black or silence (`from`..`to`)
  around a boundary. A clip ends where the gap starts and the next begins where
  it ends, so neither airs with dead air on its ends. Black at the very start
  or end of the recording is trimmed too. `--keep-gaps` cuts in the middle of
  the gap instead.
- **Exact starts by default ("smart cut").** A stream copy can only start on a
  keyframe, so it starts late. Instead the head of each clip, from the cut to
  its first keyframe, is re-encoded and the rest copied, then the join is
  checked (it has a picture, decodes cleanly, is the right length). H.264
  sources only; anything else, or a join that doesn't check out, is
  re-encoded whole. `--fast-cut` is the plain copy; `--reencode` re-encodes
  everything.
- Re-encoded clips always land in a container that holds H.264/AAC (`.mp4`
  unless the source was `.mkv`/`.mov`/`.m4v`).

It used to be a plug-in that started a local web server and opened a page in
your browser. That plug-in, if still installed, is ignored now
(`main/plugins/plugins.js`, `FOLDED_INTO_CORE`), and its remembered folders
carry over (same settings folder).

## Which signals to use — it depends on your source

These are the presets on the SPLICER page ("DVD or broadcast master", "Promo
or bumper reel", "Mixed tape"). Tested against two very different real files,
with real accuracy numbers:

- **DVD/broadcast masters with editor-inserted breaks** (e.g. a ripped
  episode disc): black-frame detection alone was highly accurate — 18
  clean, correctly-placed segments on a 2h46m SpongeBob disc. Leaving
  scene-change detection on made this *worse* (1073 segments!) because
  ordinary shot cuts within an episode — which happen constantly in any
  normal TV content — look identical to a scene-change cut. For this kind
  of source, run with `--no-scene --no-silence` and let black-frame
  detection do the work alone.
- **Fast promo/bumper reels with no clean gaps between segments** (e.g. a
  compilation of CG channel bumpers): there's often no black frame or
  silence at all between segments, so black-frame detection alone finds
  almost nothing. Scene-change detection helps but has a real accuracy
  ceiling on this content — internal motion within one bumper can score as
  high as an actual cut to the next one, and no threshold cleanly separates
  the two. Expect to skim and merge a handful of clips by hand.

The tool prints a warning when scene-change cuts vastly outnumber
black-frame cuts, since that's usually a sign the source is normal episodic
content and you should re-run with `--no-scene`.

## Combining clips

`combine.js` joins multiple video files into one, in order — the reverse of
`splice.js`. Useful for rejoining clips that got split too aggressively, or
just for stitching separate files together (e.g. several bumpers that only
ever need to be one file).

```bash
node main/splicer/combine.js clip1.mp4 clip2.mp4 clip3.mp4 --out combined.mp4
node main/splicer/combine.js --dir "C:\path\to\clips" --out combined.mp4
node main/splicer/combine.js --list order.txt --out combined.mp4
```

`--dir` combines every video in a folder, sorted by filename (so
`splice.js` output like `clip_001...`, `clip_002...` combines back in the
right order automatically). `--list` takes a text file with one path per
line (blank lines and `#` comments ignored) for explicit ordering that
doesn't follow filename sort.

It probes each input's codec/resolution/audio format first. If they all
match, it does a fast stream-copy join (no quality loss, no re-encode). If
they don't — or the stream-copy attempt fails — it automatically falls back
to re-encoding via ffmpeg's concat filter, which is slower but always works
regardless of mismatched sources. Pass `--reencode` to always re-encode
(useful if a stream-copy join *succeeds* but has playback issues, which can
happen with borderline-compatible sources ffmpeg doesn't catch upfront).

## Usage

From the repo root:

```bash
node main/splicer/splice.js "C:\path\to\compilation.mp4" --dry-run
```

Do a `--dry-run` first — it prints every detected cut point and which
category (`bumpers` / `commercials` / `episodes`) each resulting clip would
land in, without writing anything. Tune the flags below until the cut list
looks right, then drop `--dry-run` to actually split the file.

```bash
node main/splicer/splice.js "C:\path\to\compilation.mp4" --out "C:\path\to\output"
```

## Bulk mode

Process a whole folder of tapes/rips in one run — pass `--dir`, or just list
multiple files:

```bash
node main/splicer/splice.js --dir "C:\path\to\tapes" --out "C:\path\to\output" --dry-run
node main/splicer/splice.js "tape1.mp4" "tape2.mp4" "tape3.mp4" --out "C:\path\to\output"
```

`--dir` matches `.mp4 .mkv .mov .avi .ts .m4v .wmv` by default; narrow it with
`--ext mp4,ts` if a folder has other junk in it.

All inputs in a batch share one output tree — every clip still lands in
`episodes/` / `commercials/` / `bumpers/`, just prefixed with its source
file's name (`tape1_clip_001_6s.mp4`, `tape2_clip_001_6s.mp4`, ...) so
nothing collides. One `manifest.json` covers the whole batch, with a
`sourceFile` field per clip. If one file in the batch fails (corrupt file,
unreadable, etc.) it's reported and skipped — the rest of the batch still
runs.

Output layout:

```
output/
  episodes/clip_003_602s.mp4
  commercials/clip_002_31s.mp4
  bumpers/clip_001_8s.mp4
  manifest.json   <- start/end/duration/category for every clip
```

Category assignment is just a duration heuristic (see `--bumper-max` /
`--commercial-max` below) — it's meant to get most clips into roughly the
right bucket, not to be authoritative. Skim the output before moving clips
into your real channel folders, especially anything near a threshold
boundary.

## Logo/bumper-card matching

If your source has a recurring logo card or ID bumper between segments (a
channel bug, a station ID, a "next up" card), point the detector at it and
it'll catch boundaries the other signals miss — with a much lower
false-positive rate than scene-change detection, since it's matching a known
image rather than just measuring how different two frames are.

```bash
node main/splicer/splice.js "compilation.mp4" --dry-run --logo-time 9.0
```

`--logo-time <sec>` grabs a reference frame from the input itself at that
timestamp; `--logo-image <path>` uses an existing image file instead. Both
accept a comma-separated list if the card appears in more than one visual
style (e.g. different color variants) — every sampled frame is compared
against all references and the closest match wins. Use `logo-detect.js` (see
below) first to find a good `--logo-thresh` and check the score distribution
before committing to a value.

This only helps if your source actually has a recurring card — it does
nothing for content that cuts directly between segments.

### `logo-detect.js` — standalone diagnostic

A companion script for picking logo-match parameters before wiring them into
`splice.js`: prints the score distribution across the whole file and lists
every detected occurrence, so you can sanity-check a threshold without
committing to a full run.

```bash
node main/splicer/logo-detect.js "compilation.mp4" --logo-time 9.0 --fps 5
```

## Review workflow

For content where blind auto-split isn't accurate enough on its own (see
"known hard case" below) — generate a before/after thumbnail for every
candidate cut, look through them, then split using only the ones that are
real:

```bash
node main/splicer/splice.js "compilation.mp4" --review --out "C:\path\to\output"
```

This writes `output/review/<filename>/cut_001.jpg`, `cut_002.jpg`, ... (each
showing the frame just before and just after that candidate cut,
side-by-side) plus a `candidates.json` listing every candidate's timestamp.
Skim the thumbnails, note which indices are false positives, then split
using everything except those:

```bash
node main/splicer/splice.js --split-candidates "C:\path\to\output\review\compilation\candidates.json" --exclude 3,7,12 --out "C:\path\to\output"
```

`--exclude` takes a comma-separated list of candidate indices (the numbers
in the `cut_NNN.jpg` filenames) to drop. Everything not excluded gets used
as a split point. `--split-candidates` re-reads the source file path from
`candidates.json`, so you don't need to pass the input again; `--out`,
`--reencode`, `--bumper-max`, and `--commercial-max` all apply as usual.

Review mode uses whatever detection flags you pass alongside `--review`
(`--logo-time`, `--scene-thresh`, etc.) — tune those the same way you would
for a normal run to get a good candidate list before reviewing it.

## Options

| Flag | Default | What it does |
|---|---|---|
| `--out <dir>` | `<input dir>/output` | Where clips get written |
| `--dry-run` | off | Print cut points only, don't split |
| `--min-gap <sec>` | `0.4` | Minimum black/silence duration to count as a cut |
| `--min-clip <sec>` | `2` | Discard cuts that would produce a clip shorter than this |
| `--black-thresh <0-1>` | `0.10` | `blackdetect` sensitivity — lower = stricter about "black" |
| `--silence-db <dB>` | `-30` | `silencedetect` noise floor — raise (e.g. `-40`) if the source is noisy |
| `--scene-thresh <0-100>` | `16` | `scdet` sensitivity for hard visual cuts — lower = more sensitive (more false positives on fast motion/pans), higher = stricter |
| `--logo-time <sec[,sec...]>` | none | Timestamp(s) in the input to use as logo/bumper-card reference frame(s) |
| `--logo-image <path[,path...]>` | none | Reference image(s) instead of a timestamp |
| `--logo-thresh <0-255>` | `18` | Max mean-pixel-diff to count as a logo match — lower = stricter |
| `--bumper-max <sec>` | `20` | Clips at or under this length land in `bumpers/` |
| `--commercial-max <sec>` | `120` | Clips at or under this (and over bumper-max) land in `commercials/`; longer clips land in `episodes/` |
| `--reencode` | off | Re-encode whole clips (slowest; see "How clips are cut") |
| `--fast-cut` | off | Plain stream copy: fastest, but clips start on the first keyframe after the cut |
| `--keep-gaps` | off | Cut in the middle of a black/silent gap instead of leaving it out of both clips |
| `--plan <path>` | none | Split exactly the clips in a plan file (what the cut editor sends) — used instead of an input |
| `--find-repeats <path>` | none | Report clips in a plan that aired twice; writes nothing |
| `--no-black` | off | Disable black-frame detection |
| `--no-silence` | off | Disable silence detection |
| `--no-scene` | off | Disable visual scene-change detection |
| `--review` | off | Write before/after thumbnails for every candidate cut instead of splitting — see "Review workflow" |
| `--review-out <dir>` | `<out>/review` | Where review thumbnails/candidates.json get written |
| `--split-candidates <path>` | none | Split using a `candidates.json` from a previous `--review` run (see "Review workflow") — used instead of an input file |
| `--exclude <list>` | none | Comma-separated candidate indices to drop, only used with `--split-candidates` |

Detection priority when signals overlap: black-frame cuts win, then
logo-match cuts fill in gaps, then scene-change cuts, then silence cuts fill
in whatever's left — so a boundary flagged by multiple signals only produces
one cut, not several.

## Tips

- Splitting starts clips on the exact frame (see "How clips are cut"). If a
  clip still starts with a stray black flash or clipped audio, re-run with
  `--reencode`.
- If detection finds too many/few cuts, `--dry-run` repeatedly while
  adjusting `--min-gap`, `--black-thresh`, `--silence-db`, and
  `--scene-thresh` is much faster than re-splitting every time.
- Scene-change detection is what catches clean digital splices with no black
  frame or silence gap, but it's also the noisiest signal — fast pans, hard
  motion, or flash cuts within a show can trigger false positives. If you're
  getting too many spurious cuts mid-episode, raise `--scene-thresh` (e.g.
  `20`) or pass `--no-scene` to fall back to black/silence only.
- **Known hard case**: fast, colorful, highly-animated content (e.g. CG promo
  bumpers with constant on-screen motion) can produce false-cut scores in the
  same range as real cuts — there is no `--scene-thresh` value that cleanly
  separates the two on this kind of source, since the false positives come
  from motion within a single shot scoring as high as an actual cut to a new
  shot. Tuning reduces the worst offenders but won't eliminate them. If the
  source has a recurring logo/bumper card, add `--logo-time`/`--logo-image`
  to catch boundaries scene-detection misses — but logo-matching only helps
  where the card actually appears, so it's a supplement to the other
  signals, not a replacement. For this content type, `--review` plus
  `--split-candidates` is the realistic path to an accurate result: it turns
  "tune blindly and hope" into "skim ~20 thumbnails and confirm," which is
  both faster and actually reliable.
