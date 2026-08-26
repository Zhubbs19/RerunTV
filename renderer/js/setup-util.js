// Small helpers shared across the setup-screen modules (setup-panels.js,
// setup-schedule.js, setup-channels.js, setup-interstitials.js,
// setup-settings.js) — split out of the old monolithic setup.js so none of
// those modules need to import from each other just to get these.
import { S, saveConfigDebounced } from './state.js';

const IMAGE_MEDIA_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const AUDIO_MEDIA_RE = /\.(?:mp3|wav|ogg|m4a|aac|flac)$/i;

// A single lazy media-preview implementation shared by channel titles, the
// bumper/ad pool, tag-usage reporting, and flow-builder match previews. Video
// thumbnails seek to an early frame after metadata loads so they do not all
// appear as the same black first frame. Failed or non-file sources degrade to
// a labelled placeholder instead of leaving a broken media element behind.
export function buildMediaThumbnail(filePath, { label = 'MEDIA', className = '' } = {}) {
  const thumb = document.createElement('div');
  thumb.className = `media-thumbnail${className ? ` ${className}` : ''}`;
  const fallback = (text = label) => {
    thumb.innerHTML = '';
    thumb.classList.add('placeholder');
    thumb.textContent = String(text || 'MEDIA').slice(0, 5).toUpperCase();
  };
  if (!filePath) {
    fallback();
    return thumb;
  }
  if (AUDIO_MEDIA_RE.test(filePath)) {
    fallback('♪');
    return thumb;
  }

  const media = document.createElement(IMAGE_MEDIA_RE.test(filePath) ? 'img' : 'video');
  media.alt = '';
  if (media.tagName === 'VIDEO') {
    media.muted = true;
    media.playsInline = true;
    media.preload = 'metadata';
    media.addEventListener('loadedmetadata', () => {
      if (media.duration > 1) media.currentTime = Math.min(1, media.duration / 4);
    }, { once: true });
  }
  media.addEventListener('error', () => fallback(), { once: true });
  thumb.appendChild(media);

  const load = () => Promise.resolve(window.api.toFileUrl(filePath))
    .then((url) => { media.src = url; })
    .catch(() => fallback());
  if (window.IntersectionObserver) {
    const observer = new IntersectionObserver((records) => {
      if (!records.some((record) => record.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: '160px' });
    observer.observe(thumb);
  } else load();
  return thumb;
}

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

async function openLiveLogoBugEditor({ getProfiles, setProfiles, onLiveChange }) {
  const profileSnapshot = (getProfiles() || []).map((profile) => ({ ...profile }));
  const displayModeSnapshot = { ...(S.config.displayMode || {}) };
  const autoAdjustSnapshot = Boolean(S.config.display && S.config.display.logoBugAutoAdjust);
  const snapIncrementSnapshot = Number(S.config.display && S.config.display.overlaySnapIncrement) || 0;
  const overlayLayoutsSnapshot = JSON.parse(JSON.stringify((S.config.display && S.config.display.overlayLayouts) || {}));
  const [{ showSetupScreen, showTvScreen }, displayMode, channels] = await Promise.all([
    import('./app.js'), import('./display-mode.js'), import('./channels.js'),
  ]);

  await showTvScreen();
  const currentIsReal = (S.config.channels || []).some((channel) => channel.number === S.currentNumber);
  if (!currentIsReal && S.config.channels && S.config.channels.length && window.tuneToChannel) {
    await window.tuneToChannel(S.config.channels[0].number, { silent: true });
  }

  const crt = document.querySelector('.crt');
  const app = document.getElementById('app');
  const logo = document.getElementById('logo-bug');
  if (!crt || !app || !logo) return;
  const previewElements = new Map(['logo-bug', ...displayMode.OVERLAY_LAYOUT_TARGETS.map(({ id }) => id)].map((id) => {
    const element = document.getElementById(id);
    return [id, element && { className: element.className, style: element.getAttribute('style') }];
  }));

  const overlay = document.createElement('div');
  overlay.className = 'logobug-live-overlay';
  overlay.setAttribute('role', 'application');
  overlay.setAttribute('aria-label', 'Live channel logo placement editor');

  const selection = document.createElement('div');
  selection.className = 'logobug-live-selection';
  selection.setAttribute('aria-label', 'Drag to move the channel logo');
  const resizeEdges = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const handles = resizeEdges.map((edge) => {
    const handle = document.createElement('div');
    handle.className = `logobug-live-anchor logobug-live-anchor-${edge}`;
    handle.dataset.edge = edge;
    handle.setAttribute('aria-label', `Resize logo from ${edge.toUpperCase()} anchor`);
    selection.appendChild(handle);
    return handle;
  });
  overlay.appendChild(selection);

  const toolbar = document.createElement('div');
  toolbar.className = 'logobug-live-toolbar';
  const title = document.createElement('div');
  title.className = 'logobug-live-title';
  title.textContent = 'LIVE OVERLAY LAYOUT';
  const status = document.createElement('div');
  status.className = 'logobug-live-status';
  toolbar.append(title, status);

  const targetField = document.createElement('label');
  targetField.className = 'logobug-live-field';
  targetField.appendChild(document.createTextNode('OVERLAY ELEMENT'));
  const targetSelect = document.createElement('select');
  [{ id: 'logo-bug', label: 'CHANNEL LOGO' }, ...displayMode.OVERLAY_LAYOUT_TARGETS].forEach(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    targetSelect.appendChild(option);
  });
  targetField.appendChild(targetSelect);
  toolbar.appendChild(targetField);

  function addSelect(label, key, options) {
    const field = document.createElement('label');
    field.className = 'logobug-live-field';
    field.appendChild(document.createTextNode(label));
    const select = document.createElement('select');
    options.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    });
    select.value = (S.config.displayMode && S.config.displayMode[key]) || options[0][0];
    select.addEventListener('change', async () => {
      S.config.displayMode = { ...(S.config.displayMode || {}), [key]: select.value };
      await displayMode.applyDisplayModeSettled();
      selectProfileForContext();
    });
    field.appendChild(select);
    toolbar.appendChild(field);
    return select;
  }

  addSelect('ASPECT', 'aspect', [['16:9', '16:9'], ['4:3', '4:3'], ['auto', 'AUTO']]);
  addSelect('WINDOW', 'windowMode', [['letterbox', 'LETTERBOX'], ['lockWindow', 'LOCK WINDOW']]);
  addSelect('RESOLUTION', 'resolution', [['native', 'NATIVE'], ['sd480', 'SD 480'], ['sd240', 'SD 240'], ['auto', 'AUTO']]);

  const snapField = document.createElement('label');
  snapField.className = 'logobug-live-field logobug-live-snap';
  snapField.appendChild(document.createTextNode('SNAP GRID'));
  const snapSelect = document.createElement('select');
  [[0, 'OFF'], [1, '1%'], [2.5, '2.5%'], [5, '5%'], [10, '10%']].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = text;
    snapSelect.appendChild(option);
  });
  snapSelect.value = String(snapIncrementSnapshot);
  snapField.appendChild(snapSelect);
  toolbar.appendChild(snapField);

  const autoField = document.createElement('label');
  autoField.className = 'logobug-live-auto';
  const autoAdjust = document.createElement('input');
  autoAdjust.type = 'checkbox';
  autoAdjust.checked = autoAdjustSnapshot;
  autoField.append(autoAdjust, document.createTextNode(' AUTO MATCH CONTENT'));
  toolbar.appendChild(autoField);

  const actions = document.createElement('div');
  actions.className = 'logobug-live-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'CANCEL';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'btn btn-primary';
  apply.textContent = 'APPLY PLACEMENT';
  actions.append(cancel, apply);
  toolbar.appendChild(actions);

  const logoWasHidden = logo.classList.contains('hidden');
  logo.classList.remove('hidden');
  let activeId = null;
  let activeTarget = 'logo-bug';

  function snapIncrement() {
    return Number(snapSelect.value) || 0;
  }

  function snapPercent(value, max, bypass = false) {
    const increment = bypass ? 0 : snapIncrement();
    const snapped = increment ? Math.round(value / increment) * increment : value;
    return Math.min(max, Math.max(0, snapped));
  }

  function snapLogoSize(value, bypass = false) {
    const increment = bypass ? 0 : snapIncrement();
    if (!increment) return Math.round(value);
    const cellSize = Math.min(overlay.clientWidth, overlay.clientHeight) * increment / 100;
    return Math.round(value / cellSize) * cellSize;
  }

  function snapScale(value, bypass = false) {
    const increment = bypass ? 0 : snapIncrement() / 100;
    return increment ? Math.round(value / increment) * increment : value;
  }

  function syncSnapGrid() {
    const increment = snapIncrement();
    overlay.classList.toggle('snap-enabled', increment > 0);
    overlay.style.setProperty('--overlay-grid-step', increment ? `${increment}%` : '5%');
    S.config.display.overlaySnapIncrement = increment;
    renderProfile();
  }

  function currentContext() {
    return autoAdjust.checked
      ? displayMode.resolveContentDisplayMode()
      : displayMode.resolveEffectiveDisplayMode();
  }

  function activeProfile() {
    return targetProfiles().find((profile) => profile.id === activeId);
  }

  function targetElement() {
    return document.getElementById(activeTarget);
  }

  function targetProfiles() {
    if (activeTarget === 'logo-bug') return channels.normalizeLogoBugProfiles(getProfiles());
    return (((S.config.display || {}).overlayLayouts || {})[activeTarget] || []).map((profile) => ({ ...profile }));
  }

  function setTargetProfiles(profiles) {
    if (activeTarget === 'logo-bug') {
      setProfiles(profiles);
      return;
    }
    S.config.display.overlayLayouts = { ...(S.config.display.overlayLayouts || {}), [activeTarget]: profiles };
  }

  function restorePreviewElement(id) {
    const element = document.getElementById(id);
    const snapshot = previewElements.get(id);
    if (!element || !snapshot) return;
    element.className = snapshot.className;
    if (snapshot.style == null) element.removeAttribute('style');
    else element.setAttribute('style', snapshot.style);
  }

  function showTargetForEditing() {
    previewElements.forEach((_, id) => restorePreviewElement(id));
    const element = targetElement();
    if (!element) return;
    element.classList.remove('hidden');
    element.classList.add('show');
    element.style.opacity = '1';
  }

  function selectProfileForContext() {
    const context = currentContext();
    showTargetForEditing();
    const profiles = targetProfiles();
    let exact = profiles.find((profile) => profile.aspect === context.aspect && profile.resolution === context.resolution);
    if (!exact) {
      const element = targetElement();
      const overlayRect = overlay.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const base = activeTarget === 'logo-bug'
        ? channels.pickLogoBugProfile(profiles, context) || channels.foldLogoBugCorner(null, null)[0]
        : profiles.find((profile) => (!profile.aspect || profile.aspect === context.aspect)
          && (!profile.resolution || profile.resolution === context.resolution)) || {
          x: Math.max(0, (elementRect.left - overlayRect.left) / overlayRect.width * 100),
          y: Math.max(0, (elementRect.top - overlayRect.top) / overlayRect.height * 100),
          scale: 1,
        };
      exact = {
        id: newLogoBugProfileId(),
        aspect: context.aspect,
        resolution: context.resolution,
        x: base.x,
        y: base.y,
        ...(activeTarget === 'logo-bug' ? (() => {
          const { width, height } = channels.logoBugProfileDimensions(base);
          const dim = { size: base.size };
          if (width !== base.size) dim.width = width;
          if (height !== base.size) dim.height = height;
          return dim;
        })() : { scale: base.scale || 1 }),
      };
      setTargetProfiles([...profiles, exact]);
    }
    activeId = exact.id;
    renderProfile();
  }

  function renderProfile() {
    const profile = activeProfile();
    const element = targetElement();
    if (!profile) return;
    selection.style.left = `${profile.x}%`;
    selection.style.top = `${profile.y}%`;
    if (activeTarget === 'logo-bug') {
      const { width, height } = channels.logoBugProfileDimensions(profile);
      selection.style.width = `${width}px`;
      selection.style.height = `${height}px`;
      logo.style.left = `${profile.x}%`;
      logo.style.top = `${profile.y}%`;
      logo.style.setProperty('--logo-bug-size', `${profile.size}px`);
      logo.style.setProperty('--logo-bug-width', `${width}px`);
      logo.style.setProperty('--logo-bug-height', `${height}px`);
    } else {
      const scale = profile.scale || 1;
      selection.style.width = `${element.offsetWidth * scale}px`;
      selection.style.height = `${element.offsetHeight * scale}px`;
      element.style.left = `${profile.x}%`;
      element.style.top = `${profile.y}%`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
      element.style.transformOrigin = 'top left';
      element.style.transform = `scale(${scale})`;
    }
    const mode = `${profile.aspect} + ${profile.resolution === 'native' ? 'NATIVE' : profile.resolution.toUpperCase()}`;
    const snap = snapIncrement();
    let sizeStr;
    if (activeTarget === 'logo-bug') {
      const { width, height } = channels.logoBugProfileDimensions(profile);
      sizeStr = width === height ? `${width}px` : `${width}×${height}px`;
    } else {
      sizeStr = `${Math.round((profile.scale || 1) * 100)}%`;
    }
    status.textContent = `${mode}  •  X ${profile.x.toFixed(1)}%  Y ${profile.y.toFixed(1)}%  •  ${sizeStr}  •  SNAP ${snap ? `${snap}%` : 'OFF'}`;
  }

  const DELETE = Symbol('DELETE');
  function updateProfile(patch) {
    setTargetProfiles(targetProfiles().map((profile) => {
      if (profile.id !== activeId) return profile;
      const next = { ...profile, ...patch };
      // Keys set to the DELETE sentinel are removed from the stored profile
      // (e.g. width/height when the logo bug is resized back to a square).
      Object.keys(next).forEach((k) => { if (next[k] === DELETE) delete next[k]; });
      return next;
    }));
    renderProfile();
  }

  function trackDrag(event, onMove) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const move = (nextEvent) => {
      if (nextEvent.pointerId === pointerId) onMove(nextEvent);
    };
    const finish = (nextEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  selection.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.logobug-live-anchor')) return;
    const rect = overlay.getBoundingClientRect();
    const selectionRect = selection.getBoundingClientRect();
    const offsetX = event.clientX - selectionRect.left;
    const offsetY = event.clientY - selectionRect.top;
    trackDrag(event, (nextEvent) => {
      const maxX = Math.max(0, 100 - selection.offsetWidth / overlay.clientWidth * 100);
      const maxY = Math.max(0, 100 - selection.offsetHeight / overlay.clientHeight * 100);
      const rawX = ((nextEvent.clientX - offsetX - rect.left) / rect.width) * 100;
      const rawY = ((nextEvent.clientY - offsetY - rect.top) / rect.height) * 100;
      const x = snapPercent(rawX, maxX, nextEvent.altKey);
      const y = snapPercent(rawY, maxY, nextEvent.altKey);
      updateProfile({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    });
  });

  handles.forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      const profile = activeProfile();
      const edge = handle.dataset.edge;
      const overlayRect = overlay.getBoundingClientRect();
      const scaleX = overlay.clientWidth / overlayRect.width;
      const scaleY = overlay.clientHeight / overlayRect.height;
      const startPointer = { x: event.clientX, y: event.clientY };
      const startLeft = profile.x / 100 * overlay.clientWidth;
      const startTop = profile.y / 100 * overlay.clientHeight;

      if (activeTarget === 'logo-bug') {
        // Width and height are tracked independently so E/W handles only
        // affect width, N/S handles only affect height, and corner handles
        // affect both. Hold Shift on a corner to lock the original aspect ratio.
        const { width: startW, height: startH } = channels.logoBugProfileDimensions(profile);
        const clampW = (v, bypass) => Math.min(400, overlay.clientWidth, Math.max(14, snapLogoSize(v, bypass)));
        const clampH = (v, bypass) => Math.min(400, overlay.clientHeight, Math.max(14, snapLogoSize(v, bypass)));
        trackDrag(event, (nextEvent) => {
          const dx = (nextEvent.clientX - startPointer.x) * scaleX;
          const dy = (nextEvent.clientY - startPointer.y) * scaleY;
          const affectsW = edge.includes('e') || edge.includes('w');
          const affectsH = edge.includes('n') || edge.includes('s');
          let rawW = startW + (edge.includes('e') ? dx : edge.includes('w') ? -dx : 0);
          let rawH = startH + (edge.includes('s') ? dy : edge.includes('n') ? -dy : 0);
          // Shift on a corner = lock aspect ratio
          if (nextEvent.shiftKey && affectsW && affectsH) {
            const ratio = Math.max(Math.abs(rawW / startW), Math.abs(rawH / startH));
            rawW = startW * ratio;
            rawH = startH * ratio;
          }
          const nextW = affectsW ? clampW(rawW, nextEvent.altKey) : startW;
          const nextH = affectsH ? clampH(rawH, nextEvent.altKey) : startH;
          let left = startLeft;
          let top = startTop;
          if (edge.includes('w')) left = startLeft + startW - nextW;
          if (edge.includes('n')) top = startTop + startH - nextH;
          left = Math.min(overlay.clientWidth - nextW, Math.max(0, left));
          top = Math.min(overlay.clientHeight - nextH, Math.max(0, top));
          // Only write width/height into the profile when they differ from
          // size (keeps old configs compact; square remains size-only).
          // Pass DELETE sentinel for keys that should be removed.
          const newSize = Math.round(Math.min(nextW, nextH));
          const patch = {
            size: newSize,
            x: Math.round(snapPercent(left / overlay.clientWidth * 100,
              Math.max(0, 100 - nextW / overlay.clientWidth * 100), nextEvent.altKey) * 10) / 10,
            y: Math.round(snapPercent(top / overlay.clientHeight * 100,
              Math.max(0, 100 - nextH / overlay.clientHeight * 100), nextEvent.altKey) * 10) / 10,
            width: Math.round(nextW) !== newSize ? Math.round(nextW) : DELETE,
            height: Math.round(nextH) !== newSize ? Math.round(nextH) : DELETE,
          };
          updateProfile(patch);
        });
      } else {
        const startSize = targetElement().offsetWidth * (profile.scale || 1);
        const startHeight2 = targetElement().offsetHeight * (profile.scale || 1);
        trackDrag(event, (nextEvent) => {
          const dx = (nextEvent.clientX - startPointer.x) * scaleX;
          const dy = (nextEvent.clientY - startPointer.y) * scaleY;
          const widthDeltas = [];
          if (edge.includes('e')) widthDeltas.push(dx / startSize);
          if (edge.includes('w')) widthDeltas.push(-dx / startSize);
          if (edge.includes('s')) widthDeltas.push(dy / startHeight2);
          if (edge.includes('n')) widthDeltas.push(-dy / startHeight2);
          const ratio = 1 + widthDeltas.reduce((sum, value) => sum + value, 0) / widthDeltas.length;
          const size = Math.min(3, Math.max(0.5, snapScale((profile.scale || 1) * ratio, nextEvent.altKey)));
          const nextWidth = targetElement().offsetWidth * size;
          const nextHeight = targetElement().offsetHeight * size;
          let left = startLeft;
          let top = startTop;
          if (edge.includes('w')) left = startLeft + startSize - nextWidth;
          if (edge.includes('n')) top = startTop + startHeight2 - nextHeight;
          left = Math.min(overlay.clientWidth - nextWidth, Math.max(0, left));
          top = Math.min(overlay.clientHeight - nextHeight, Math.max(0, top));
          updateProfile({
            scale: Math.round(size * 100) / 100,
            x: Math.round(snapPercent(left / overlay.clientWidth * 100,
              Math.max(0, 100 - nextWidth / overlay.clientWidth * 100), nextEvent.altKey) * 10) / 10,
            y: Math.round(snapPercent(top / overlay.clientHeight * 100,
              Math.max(0, 100 - nextHeight / overlay.clientHeight * 100), nextEvent.altKey) * 10) / 10,
          });
        });
      }
    });
  });

  autoAdjust.addEventListener('change', () => {
    S.config.display.logoBugAutoAdjust = autoAdjust.checked;
    selectProfileForContext();
  });

  snapSelect.addEventListener('change', syncSnapGrid);

  targetSelect.addEventListener('change', () => {
    activeTarget = targetSelect.value;
    activeId = null;
    selectProfileForContext();
  });

  let closing = false;
  async function closeEditor(keepChanges) {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    toolbar.remove();
    if (!keepChanges) {
      S.config.displayMode = displayModeSnapshot;
      S.config.display.logoBugAutoAdjust = autoAdjustSnapshot;
      S.config.display.overlaySnapIncrement = snapIncrementSnapshot;
      S.config.display.overlayLayouts = overlayLayoutsSnapshot;
      setProfiles(profileSnapshot.map((profile) => ({ ...profile })));
      displayMode.applyDisplayModeSettled();
    } else {
      S.config.display.logoBugAutoAdjust = autoAdjust.checked;
      saveConfigDebounced();
    }
    if (logoWasHidden) logo.classList.add('hidden');
    previewElements.forEach((_, id) => restorePreviewElement(id));
    displayMode.applyOverlayLayouts();
    if (onLiveChange) onLiveChange();
    await showSetupScreen();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEditor(false);
    }
  }
  document.addEventListener('keydown', onKeyDown);
  cancel.addEventListener('click', () => closeEditor(false));
  apply.addEventListener('click', () => closeEditor(true));

  crt.appendChild(overlay);
  app.appendChild(toolbar);
  syncSnapGrid();
  selectProfileForContext();
}

// The old detached miniature preview was removed: placement is edited only
// against the running channel, so the grid, display mode, logo and touch
// targets all use the same geometry the viewer will actually see.
export function buildLogoBugProfileEditor(getProfiles, setProfiles, onLiveChange) {
  const wrap = document.createElement('div');
  const explanation = document.createElement('p');
  explanation.className = 'panel-status logobug-live-description';
  explanation.textContent = 'Edit the logo over the running channel. Each aspect and resolution combination keeps its own placement.';
  const liveBtn = document.createElement('button');
  liveBtn.type = 'button';
  liveBtn.className = 'btn btn-primary logobug-live-open';
  liveBtn.textContent = 'EDIT ON CURRENT CHANNEL';
  liveBtn.disabled = !(S.config.channels && S.config.channels.length);
  liveBtn.title = liveBtn.disabled
    ? 'Add a channel before opening the live placement editor'
    : 'Overlay an alignment grid on the running channel and edit placement in real time';
  liveBtn.addEventListener('click', () => openLiveLogoBugEditor({
    getProfiles, setProfiles, onLiveChange,
  }));
  wrap.append(explanation, liveBtn);
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
