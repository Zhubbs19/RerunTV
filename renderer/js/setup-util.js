// Small helpers shared across the setup-screen modules (setup-panels.js,
// setup-schedule.js, setup-channels.js, setup-interstitials.js,
// setup-settings.js) — split out of the old monolithic setup.js so none of
// those modules need to import from each other just to get these.
import { S } from './state.js';

// Every distinct tag currently in use anywhere tags mean something —
// per-file tags (TITLES tab), pool-entry contentTags, and preset
// contentTags (PROGRAMMING tab) — so autocomplete (below) can suggest a tag
// that's already established instead of only what's typed so far. Cheap
// enough to recompute on every keystroke even for a large library (a
// few thousand short strings deduped through a Set).
export function collectAllTags() {
  const tags = new Set();
  (S.config.channels || []).forEach((ch) => {
    (ch.files || []).forEach((f) => (f.tags || []).forEach((t) => tags.add(t)));
  });
  ((S.config.interstitials && S.config.interstitials.pool) || []).forEach((e) => {
    (e.contentTags || []).forEach((t) => tags.add(t));
  });
  ((S.config.interstitials && S.config.interstitials.presets) || []).forEach((p) => {
    (p.contentTags || []).forEach((t) => tags.add(t));
  });
  // A curated-but-not-yet-used canonical tag (PROGRAMMING > TAG TAXONOMY)
  // should still autocomplete — that's the whole point of pre-declaring it.
  const tx = S.config.tagTaxonomy;
  if (tx) { [...tx.genres, ...tx.eras, ...tx.moods].forEach((t) => tags.add(t)); }
  return Array.from(tags).sort();
}

// Turns a plain comma-separated tags <input> into one with a suggestion
// dropdown for the tag currently being typed (the text after the last
// comma) — a plain HTML5 <datalist> doesn't work for this shape of field,
// since browsers match a datalist option against the *entire* input value,
// not the last comma-separated segment. Wraps the input in a small
// position:relative span (so the dropdown can anchor under just the input,
// not the whole row) and inserts that wrapper in the input's place in the
// DOM — callers should append/insert the returned wrapper, not the
// original input, and keep using the original input element for its value/
// events exactly as before.
export function attachTagAutocomplete(inputEl) {
  const wrap = document.createElement('span');
  wrap.className = 'tag-ac-wrap';
  if (inputEl.parentNode) inputEl.parentNode.replaceChild(wrap, inputEl);
  wrap.appendChild(inputEl);

  const list = document.createElement('div');
  list.className = 'tag-ac-list hidden';
  wrap.appendChild(list);

  function currentSegment() {
    const parts = inputEl.value.split(',');
    return parts[parts.length - 1].trim().toLowerCase();
  }

  function commitSegment(tag) {
    const parts = inputEl.value.split(',').map((p) => p.trim()).filter(Boolean);
    parts[parts.length - 1] = tag; // replace the in-progress segment with the picked tag
    inputEl.value = parts.join(', ') + ', '; // trailing ", " so the next tag can be typed straight away
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    hide();
    inputEl.focus();
  }

  function hide() { list.classList.add('hidden'); list.innerHTML = ''; }

  function show() {
    const seg = currentSegment();
    if (!seg) { hide(); return; }
    const already = inputEl.value.split(',').map((s) => s.trim().toLowerCase());
    const matches = collectAllTags().filter((t) => t.includes(seg) && !already.includes(t)).slice(0, 8);
    if (!matches.length) { hide(); return; }
    list.innerHTML = '';
    matches.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'tag-ac-item';
      item.textContent = t;
      // mousedown (not click) fires before the input's blur, so the
      // dropdown's own hide-on-blur below doesn't swallow the selection.
      item.addEventListener('mousedown', (e) => { e.preventDefault(); commitSegment(t); });
      list.appendChild(item);
    });
    list.classList.remove('hidden');
  }

  inputEl.addEventListener('input', show);
  inputEl.addEventListener('focus', show);
  inputEl.addEventListener('blur', () => setTimeout(hide, 120));

  return wrap;
}

// Shared show/hide-and-build-once-revealed pattern for a panel toggled by a
// button (day-overrides, block ADS, channel EDIT) — avoids building content
// eagerly for every row up front.
export function toggleLazyPanel(panelEl, buildFn) {
  const willShow = panelEl.classList.contains('hidden');
  panelEl.classList.toggle('hidden');
  if (willShow) buildFn();
}

// Parses a string as a positive integer, falling back when it isn't one —
// used by every box-wide interval field (commercials/standby/stationId/
// ticker/trivia/screensaver) plus the per-block ads interval.
export function parsePositiveInt(str, fallback) {
  const n = parseInt(str, 10);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

// Visual companion to an "AT SET POINTS (%)" breakpoints text field (the
// per-channel ADS panel, setup-panels.js, and the PROGRAMMING tab's
// cadence presets, setup-interstitials.js both have their own) — a
// horizontal track representing a show from 0-100%, with a draggable pin
// per breakpoint. Click empty track to add a point, drag a pin to
// reposition it, click a pin (no drag) to remove it. Kept in sync with
// `syncTextInput` (the plain comma-list field) in both directions rather
// than replacing it — some users will always prefer typing exact numbers,
// and the text field is also what screen readers/keyboard-only editing
// fall back to. `getPoints`/`setPoints` read/write wherever the caller's
// own breakpoints array actually lives (cc.breakpoints vs preset.breakpoints)
// so this stays agnostic to which owner object it's editing.
export function buildBreakpointTrack(getPoints, setPoints, syncTextInput) {
  const track = document.createElement('div');
  track.className = 'breakpoint-track';
  track.title = 'Click to add a break point, drag a pin to move it, click a pin to remove it';

  function commit(pts) {
    const cleaned = pts.filter((v) => Number.isFinite(v) && v > 0 && v < 100).sort((a, b) => a - b);
    setPoints(cleaned.length ? cleaned : null);
    syncTextInput.value = cleaned.join(', ');
    render();
  }

  function pctFromEvent(e) {
    const rect = track.getBoundingClientRect();
    const raw = ((e.clientX - rect.left) / rect.width) * 100;
    return Math.min(99, Math.max(1, Math.round(raw)));
  }

  function render() {
    track.innerHTML = '';
    (getPoints() || []).forEach((pct) => {
      const pin = document.createElement('div');
      pin.className = 'breakpoint-pin';
      pin.style.left = `${pct}%`;
      pin.title = `${pct}% — drag to move, click to remove`;
      pin.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        let moved = false;
        const onMove = (ev) => {
          moved = true;
          pin.style.left = `${pctFromEvent(ev)}%`;
        };
        const onUp = (ev) => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const pts = (getPoints() || []).filter((p) => p !== pct);
          if (moved) pts.push(pctFromEvent(ev));
          commit(pts);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      track.appendChild(pin);
    });
  }

  track.addEventListener('click', (e) => {
    if (e.target !== track) return; // a pin's own mousedown/mouseup handled the click, not this
    commit([...(getPoints() || []), pctFromEvent(e)]);
  });

  render();
  return track;
}

let logoBugProfileIdCounter = 0;
function newLogoBugProfileId() { return `p${Date.now().toString(36)}${(logoBugProfileIdCounter++).toString(36)}`; }

// Drag-and-drop editor for a logoBugProfiles array (box-wide:
// S.config.display.logoBugProfiles — setup-settings.js; per-channel
// override: ch.logoBugProfiles — setup-panels.js). Same drag mechanics as
// buildBreakpointTrack above (plain mousedown/mousemove/mouseup on
// `document` during a drag, direct style mutation while dragging, a real
// commit — persist + re-render — only once the drag ends or the profile
// *set* itself changes), extended to two axes (x/y position) plus a resize
// handle, since a logo bug's placement isn't just "where on a 0-100% line"
// like a break point is. `getProfiles`/`setProfiles` read/write wherever the
// caller's own array actually lives, same indirection buildBreakpointTrack
// uses, so one editor serves both the box-wide default and a per-channel
// override. `onLiveChange` re-applies placement to the real on-screen logo
// bug so dragging reads as instant feedback, same as the old corner
// select/size slider had.
export function buildLogoBugProfileEditor(getProfiles, setProfiles, onLiveChange) {
  const wrap = document.createElement('div');
  let activeId = null;

  function sorted() {
    return (getProfiles() || []).slice().sort((a, b) => (a.maxWidth ?? Infinity) - (b.maxWidth ?? Infinity));
  }

  // Lightweight write path for continuous drag feedback — persists +
  // re-applies the real logo bug's placement, but does NOT rebuild this
  // editor's own DOM (that would fight the drag: the element currently
  // being dragged would get replaced out from under the mouse mid-move).
  function persist(profiles) {
    setProfiles(profiles);
    if (onLiveChange) onLiveChange();
  }

  // Full commit — for anything that changes the *set* of profiles (add/
  // remove/resolution-threshold edit) or which one is active, where a
  // rebuild is exactly what's needed rather than something to avoid.
  function commit(profiles) {
    persist(profiles);
    render();
  }

  function render() {
    wrap.innerHTML = '';
    const profiles = sorted();
    if (!profiles.length) return; // caller always seeds at least a DEFAULT profile
    if (!profiles.some((p) => p.id === activeId)) activeId = profiles[0].id;
    const active = profiles.find((p) => p.id === activeId);

    // ---- profile list: pick which breakpoint the preview below edits ----
    const list = document.createElement('div');
    list.className = 'logobug-editor-profile-list';
    profiles.forEach((p) => {
      const row = document.createElement('div');
      row.className = `block-row logobug-editor-profile-row${p.id === activeId ? ' active' : ''}`;
      row.style.cursor = 'pointer';
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, input')) return; // let the width field/remove button handle their own clicks
        activeId = p.id;
        render();
      });

      const label = document.createElement('span');
      label.className = 'block-count';
      label.textContent = p.maxWidth == null ? 'DEFAULT (any resolution)' : 'UP TO';
      row.appendChild(label);

      if (p.maxWidth != null) {
        const widthInput = document.createElement('input');
        widthInput.type = 'number';
        widthInput.min = '1';
        widthInput.value = p.maxWidth;
        widthInput.title = 'Applies to video this wide or narrower, in pixels';
        widthInput.addEventListener('click', (e) => e.stopPropagation());
        widthInput.addEventListener('change', () => {
          const v = parseInt(widthInput.value, 10);
          if (Number.isFinite(v) && v > 0) commit(sorted().map((x) => (x.id === p.id ? { ...x, maxWidth: v } : x)));
        });
        row.appendChild(widthInput);

        const px = document.createElement('span');
        px.className = 'block-count';
        px.textContent = 'PX WIDE';
        row.appendChild(px);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = 'REMOVE';
        removeBtn.addEventListener('click', () => {
          if (activeId === p.id) activeId = null;
          commit(sorted().filter((x) => x.id !== p.id));
        });
        row.appendChild(removeBtn);
      }
      list.appendChild(row);
    });
    wrap.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn';
    addBtn.textContent = '+ ADD RESOLUTION BREAKPOINT';
    addBtn.title = 'Give this resolution (and anything narrower, unless a narrower breakpoint exists too) its own position/size';
    addBtn.addEventListener('click', () => {
      // Read fresh rather than closing over the outer `profiles`/`active`
      // (captured once, at the top of this render() call) — a drag since
      // the last render only ever calls persist(), never a full render(),
      // specifically so it doesn't fight the in-progress drag; that means
      // this closure's `profiles`/`active` can be stale by the time ADD is
      // clicked, and spreading a stale array here would silently discard
      // whatever the drag just changed.
      const current = sorted();
      const narrowest = current.find((p) => p.maxWidth != null);
      const maxWidth = narrowest ? Math.max(1, Math.round(narrowest.maxWidth / 2)) : 720;
      const base = current.find((p) => p.id === activeId) || current[current.length - 1];
      const fresh = { id: newLogoBugProfileId(), maxWidth, x: base.x, y: base.y, size: base.size };
      activeId = fresh.id;
      commit([...current, fresh]);
    });
    wrap.appendChild(addBtn);

    // ---- drag preview: a 16:9 stand-in for the screen, reference canvas
    // 1920x1080 so a dragged x/y (%) and a resized `size` (px) both mean the
    // same real screen position/size regardless of the preview box's own
    // rendered pixel dimensions. ----
    const preview = document.createElement('div');
    preview.className = 'logobug-editor-preview';

    function xyFromEvent(e) {
      const rect = preview.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
      return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    }

    const handle = document.createElement('div');
    handle.className = 'logobug-editor-handle';
    handle.title = 'Drag to position — drag the corner tab to resize';
    handle.textContent = active.maxWidth == null ? 'DEF' : `≤${active.maxWidth}`;
    handle.style.left = `${active.x}%`;
    handle.style.top = `${active.y}%`;
    handle.style.width = `${(active.size / 1920) * 100}%`;
    handle.style.height = `${(active.size / 1080) * 100}%`;

    const resizeTab = document.createElement('div');
    resizeTab.className = 'logobug-editor-resize';
    handle.appendChild(resizeTab);

    // A drag that ends with the cursor no longer directly over the element
    // mousedown started on (true for a resize — the cursor moves away from
    // the small corner tab — and possible for a move too) still fires a
    // native 'click' afterward, targeted whatever's now under the cursor.
    // Landing on bare `preview` background would trigger its own "click to
    // jump the handle here" listener below, silently overwriting the drag's
    // own result with a second, unwanted write. One flag suppresses exactly
    // that next click, reset immediately after.
    let suppressNextPreviewClick = false;

    handle.addEventListener('mousedown', (e) => {
      if (e.target === resizeTab) return;
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev) => {
        const { x, y } = xyFromEvent(ev);
        handle.style.left = `${x}%`;
        handle.style.top = `${y}%`;
        persist(sorted().map((p) => (p.id === activeId ? { ...p, x, y } : p)));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        suppressNextPreviewClick = true;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    resizeTab.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev) => {
        const previewRect = preview.getBoundingClientRect();
        const handleRect = handle.getBoundingClientRect();
        const pxSize = Math.max(1, ev.clientX - handleRect.left);
        const size = Math.min(96, Math.max(28, Math.round(pxSize * (1920 / previewRect.width))));
        handle.style.width = `${(size / 1920) * 100}%`;
        handle.style.height = `${(size / 1080) * 100}%`;
        persist(sorted().map((p) => (p.id === activeId ? { ...p, size } : p)));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        suppressNextPreviewClick = true;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Click anywhere else in the preview to jump the handle straight there,
    // rather than only ever being able to drag it from its current spot.
    preview.addEventListener('click', (e) => {
      if (suppressNextPreviewClick) { suppressNextPreviewClick = false; return; }
      if (e.target !== preview) return;
      const { x, y } = xyFromEvent(e);
      handle.style.left = `${x}%`;
      handle.style.top = `${y}%`;
      persist(sorted().map((p) => (p.id === activeId ? { ...p, x, y } : p)));
    });

    preview.appendChild(handle);
    wrap.appendChild(preview);
  }

  render();
  return wrap;
}

// Builds a live numeric readout that tracks a range slider's value, kept in
// sync on 'input' — a bare <input type="range"> gives no visual feedback on
// the number it's currently set to, which turns fine-tuning (CRT intensity,
// volume, logo size, per-channel volume) into blind guesswork by track
// position alone. Auto-inserts itself right after the slider ONLY when the
// slider already has a DOM parent (true for every static HTML slider, wired
// at module load) — a freshly `document.createElement`'d slider that hasn't
// been appended anywhere yet has no parent to insert next to, so that case
// (the per-channel volume slider, built fresh per row) gets back `el`
// unattached and must place it explicitly once the slider itself is in the
// DOM. `refresh` lets a caller resync the readout after setting
// slider.value programmatically (e.g. a RESET button), since that doesn't
// fire a real 'input' event.
export function attachSliderReadout(slider, opts) {
  opts = opts || {};
  const suffix = opts.suffix || '';
  const readout = document.createElement('span');
  readout.className = 'slider-readout';
  const update = () => { readout.textContent = slider.value + suffix; };
  update();
  if (slider.parentNode) slider.insertAdjacentElement('afterend', readout);
  // The readout's value comes straight off slider.value, not a JS-set CSS
  // custom property, so a plain CSS transition would be fine here too — but
  // this project has confirmed several of these sliders ALSO drive a
  // --crt-* custom property consumed elsewhere (Chromium doesn't reliably
  // retrigger transitions on those), so the readout gets its own small
  // class-toggle keyframe instead of a transition, to stay consistent with
  // the sliders that can't use one.
  slider.addEventListener('input', () => {
    update();
    readout.classList.remove('pulse');
    void readout.offsetWidth;
    readout.classList.add('pulse');
  });
  return { el: readout, refresh: update };
}

// Probes a file's duration by loading it into a detached <video> element —
// used by every folder/file scan path (channel folders, block folders,
// interstitials pool entries) so a newly-added file's duration is known
// before it's ever scheduled.
export function probeDuration(filePath) {
  return new Promise(async (resolve) => {
    const url = await window.api.toFileUrl(filePath);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    const fallback = setTimeout(() => resolve(180), 4000);
    v.addEventListener('loadedmetadata', () => {
      clearTimeout(fallback);
      const d = isFinite(v.duration) && v.duration > 0 ? v.duration : 180;
      resolve(d);
      v.src = '';
    });
    v.addEventListener('error', () => {
      clearTimeout(fallback);
      resolve(180);
    });
  });
}

// Source-aware sibling of probeDuration above — 'local' defers to the exact
// existing <video>-element probe (byte-identical to every call site before
// this existed), anything else asks that provider's own probe() service via
// the main-process dispatch layer (media:probeDuration, main.js/
// main-media-dispatch.js), since a plugin-sourced ref has no playback
// dispatch path a <video> element could load in the first place.
export async function probeDurationForEntry(source, ref) {
  if (!source || source === 'local') return probeDuration(ref);
  return window.api.probeDuration(source, ref);
}
