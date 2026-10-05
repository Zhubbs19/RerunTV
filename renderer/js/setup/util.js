// Small helpers shared across the setup-screen modules (setup-panels.js,
// setup-schedule.js, setup-channels.js, setup-interstitials.js,
// setup-settings.js) — split out of the old monolithic setup.js so none of
// those modules need to import from each other just to get these.
import {
  DYNAMIC_OVERLAY_CORNERS, DYNAMIC_OVERLAY_TRIGGERS, newDynamicOverlayId, normalizeDynamicOverlays,
  normalizeIconOverrides, sortedChannels,
} from '../core/channels.js';
import { S, commitInPlace } from '../core/state.js';
import { EmptyState } from '../ui/button.js';
import { basenameNoExt, randomId, toDatetimeLocalValue, deepClone } from '../core/util.js';
import { openDynamicOverlayPositionEditor } from './overlay-editor.js';
import { openLiveLogoBugEditor } from './overlay-layout-editor.js';

export { openDynamicOverlayPositionEditor } from './overlay-editor.js';

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
  // The label sits in its own child rather than as the thumb's textContent,
  // so a still-decoding video can render UNDER it and simply reveal itself
  // once it has a real frame. Before this, a <video> was appended straight
  // away and every tile that had not decoded yet - or never would, because
  // Electron can't decode that file's codec - showed as a black rectangle
  // with nothing to say it wasn't just an empty slot.
  const labelEl = document.createElement('span');
  labelEl.className = 'media-thumbnail-label';
  thumb.appendChild(labelEl);
  const fallback = (text = label) => {
    thumb.querySelectorAll('img, video').forEach((el) => el.remove());
    thumb.classList.add('placeholder');
    labelEl.textContent = String(text || 'MEDIA').slice(0, 5).toUpperCase();
  };
  fallback();
  if (!filePath) return thumb;
  if (AUDIO_MEDIA_RE.test(filePath)) {
    fallback('♪');
    return thumb;
  }

  const media = document.createElement(IMAGE_MEDIA_RE.test(filePath) ? 'img' : 'video');
  media.alt = '';
  // Not "loaded" — "actually has a frame to show". For video that is the
  // seek landing, not loadedmetadata, which is what used to swap a black
  // element in ahead of any decoded picture.
  const ready = () => { thumb.classList.remove('placeholder'); labelEl.textContent = ''; };
  if (media.tagName === 'VIDEO') {
    media.muted = true;
    media.playsInline = true;
    media.preload = 'metadata';
    media.addEventListener('loadedmetadata', () => {
      if (media.duration > 1) media.currentTime = Math.min(1, media.duration / 4);
    }, { once: true });
    media.addEventListener('seeked', ready, { once: true });
    media.addEventListener('loadeddata', ready, { once: true });
  } else {
    media.addEventListener('load', ready, { once: true });
  }
  media.addEventListener('error', () => fallback(), { once: true });
  thumb.insertBefore(media, labelEl);

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
  if (tx) { [...(tx.genres || []), ...(tx.eras || []), ...(tx.moods || [])].forEach((t) => tags.add(t)); }
  return Array.from(tags).sort();
}

// Tags that some real piece of CONTENT actually carries — per-file tags
// (TITLES tab) plus a channel's own contentTags (ADS tab — see
// interstitials.js's effectiveContentTags), which stand in for every file on
// that channel. Deliberately narrower than collectAllTags above: that one
// also includes pool-entry/preset contentTags themselves (so autocomplete
// can suggest a tag someone already typed elsewhere), which is exactly what
// makes a tag look "already in use" even when nothing actually airs with
// it — an ad/preset/flow whose contentTags don't overlap THIS set can never
// become eligible, full stop, regardless of channel/block affinity (see
// poolFor, interstitials.js). Used to warn about that at edit time (setup-
// interstitials.js, setup-interstitials-flowbuilder.js) and to flag it after
// the fact (the "dead" pool-entry/preset health check, setup-channels-
// diagnostics.js), so both stay in sync with the exact same definition of
// "will this tag ever match."
export function collectRealContentTags() {
  const tags = new Set();
  (S.config.channels || []).forEach((ch) => {
    (ch.files || []).forEach((f) => (f.tags || []).forEach((t) => tags.add(t)));
    (ch.blocks || []).forEach((b) => (b.files || []).forEach((f) => (f.tags || []).forEach((t) => tags.add(t))));
    (ch.contentTags || []).forEach((t) => tags.add(t));
  });
  return tags;
}

// A small live-updating warning for any "APPLIES TO CONTENT TAGGED"-style
// field (the pool entry editor, ad presets, flow contentTags, flow mid-show
// cadence — setup-interstitials.js/setup-interstitials-flowbuilder.js) that
// flags a tag no real content carries yet, at the moment it's typed, instead
// of only showing up later as a silently-dead ad/preset/flow (the health
// check catches the same condition after the fact — see collectRealContentTags
// above and setup-channels-diagnostics.js). getTags() should return the
// currently-entered tag array; call refresh() after every edit to that value
// (both on this field's own change and, since a warning here has to reflect
// content elsewhere in the config too, from anywhere content/channel tags
// might change — callers that skip that are just accepting a slightly stale
// warning until the next full re-render, not a wrong one).
const defaultDeadTagMessage = (dead) =>
  `⚠ NO FILE OR CHANNEL IS TAGGED "${dead.join('", "')}" YET — THIS WILL NEVER MATCH UNTIL SOME CONTENT IS. CHANNEL/BLOCK TARGETING ALONE DOESN'T SATISFY A CONTENT TAG.`;

export function buildDeadTagWarning(getTags, formatMessage = defaultDeadTagMessage) {
  const el = document.createElement('div');
  el.className = 'dead-tag-warning hidden';
  function refresh() {
    const tags = (getTags() || []).filter(Boolean);
    if (!tags.length) { el.classList.add('hidden'); return; }
    const real = collectRealContentTags();
    const dead = tags.filter((t) => !real.has(t));
    if (!dead.length) { el.classList.add('hidden'); return; }
    el.textContent = formatMessage(dead);
    el.classList.remove('hidden');
  }
  refresh();
  return { el, refresh };
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

  // Keyboard support: ArrowUp/Down move through the suggestions, Enter picks the
  // highlighted one (only while one is highlighted, so plain Enter still submits),
  // Escape closes the list.
  let activeIdx = -1;
  function setActive(i) {
    const items = Array.from(list.children);
    if (!items.length) return;
    activeIdx = (i + items.length) % items.length;
    items.forEach((el, n) => {
      el.classList.toggle('active', n === activeIdx);
      el.setAttribute('aria-selected', String(n === activeIdx));
    });
  }

  function hide() { list.classList.add('hidden'); list.innerHTML = ''; activeIdx = -1; }

  function show() {
    const seg = currentSegment();
    if (!seg) { hide(); return; }
    const already = inputEl.value.split(',').map((s) => s.trim().toLowerCase());
    const matches = collectAllTags().filter((t) => t.includes(seg) && !already.includes(t)).slice(0, 8);
    if (!matches.length) { hide(); return; }
    list.innerHTML = '';
    activeIdx = -1;
    matches.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'tag-ac-item';
      item.setAttribute('role', 'option');
      item.textContent = t;
      // mousedown (not click) fires before the input's blur, so the
      // dropdown's own hide-on-blur below doesn't swallow the selection.
      item.addEventListener('mousedown', (e) => { e.preventDefault(); commitSegment(t); });
      list.appendChild(item);
    });
    list.classList.remove('hidden');
  }

  inputEl.addEventListener('keydown', (e) => {
    const open = !list.classList.contains('hidden') && list.children.length > 0;
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx < 0 ? -1 : activeIdx - 1); }
    else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      e.stopPropagation();
      commitSegment(list.children[activeIdx].textContent);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  });
  inputEl.addEventListener('input', show);
  inputEl.addEventListener('focus', show);
  inputEl.addEventListener('blur', () => setTimeout(hide, 120));

  return wrap;
}

// Shared show/hide-and-build-once-revealed pattern for a panel toggled by a
// button (day-overrides, block ADS, channel EDIT) — avoids building content
// eagerly for every row up front.
// An empty collection (docs/design/03 §5.4): one plain sentence and one
// primary action. `action` is { label, run }; leave it out when there is
// nothing to do but wait.
// The setup screen's positional form of the kit's EmptyState.
export function emptyState(text, action = null) {
  return EmptyState({ message: text, action });
}

export function toggleLazyPanel(panelEl, buildFn) {
  const willShow = panelEl.classList.contains('hidden');
  panelEl.classList.toggle('hidden');
  if (willShow) buildFn();
}

// Parses a string as a positive integer, falling back when it isn't one —
// used by every box-wide interval field (commercials/standby/stationId/
// ticker/trivia/screensaver) plus the per-block ads interval.
// Records top-level fields of a channel or a schedule block as they now stand
// (after an in-place edit) as one command: channel.setFields for a channel,
// item.set on its channel's blocks for a block. Both are found in S.config by
// identity, the way the setup panels hold them. See state.js commitInPlace.
export function ownerFieldsCommand(owner, fields) {
  const values = Object.fromEntries(fields.map((field) => [field, owner[field]]));
  const channels = (S.config && S.config.channels) || [];
  if (channels.includes(owner)) return { type: 'channel.setFields', channel: owner.number, fields: values };
  const ch = channels.find((c) => (c.blocks || []).includes(owner));
  return { type: 'item.set', collection: 'blocks', channel: ch ? ch.number : null, id: owner.id, fields: values };
}

export function commitOwnerFields(owner, fields, opts = {}) {
  return commitInPlace(ownerFieldsCommand(owner, fields), opts);
}

// Renumbering or swapping channels must carry every number-keyed reference with
// it, or ads/flows/presets/PIN locks silently end up pointing at whichever channel
// now holds the old number. `map` is a Map (or plain object) of oldNumber ->
// newNumber; a swap is just both directions in one map. Arrays are rewritten in
// place so object identity survives. Pool channelAffinity may be 'any' (left alone).
// Favorites live in the personal-profile store, not config, and are not touched here.
export function remapChannelRefs(config, map) {
  if (!config) return;
  const lookup = map instanceof Map ? map : new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
  const get = (n) => (typeof n === 'number' && lookup.has(n) ? lookup.get(n) : n);
  const mapArray = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return;
    const next = arr.map(get);
    arr.splice(0, arr.length, ...next);
  };
  const inter = config.interstitials;
  if (inter) {
    (inter.pool || []).forEach((e) => { if (e && typeof e.channelAffinity === 'number') e.channelAffinity = get(e.channelAffinity); });
    (inter.presets || []).forEach((p) => p && mapArray(p.channels));
    (inter.flows || []).forEach((f) => f && mapArray(f.channels));
  }
  if (config.pinLock) mapArray(config.pinLock.channels);
  (Array.isArray(config.preemptionWindows) ? config.preemptionWindows : []).forEach((w) => {
    if (w && typeof w.channelNumber === 'number') w.channelNumber = get(w.channelNumber);
  });
}

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

// The live layout editor (O key / LIVE EDITOR buttons) lives in its own module.
export { openLiveLogoBugEditor };

// The old detached miniature preview was removed: placement is edited only
// against the running channel, so the grid, display mode, logo and touch
// targets all use the same geometry the viewer will actually see.
// ch (optional): the channel this profile array belongs to (buildLogoBugPanel,
// setup-panels.js, for a per-channel override) — when passed, the live
// editor tunes to ch.number specifically instead of whatever's already live,
// so you're always editing WYSIWYG against the actual channel being
// configured. Omitted by the box-wide default editor (setup-settings.js),
// which has no single channel of its own to prefer.
export function buildLogoBugProfileEditor(getProfiles, setProfiles, onLiveChange, ch) {
  const wrap = document.createElement('div');
  const explanation = document.createElement('p');
  explanation.className = 'panel-status logobug-live-description';
  explanation.textContent = ch
    ? `Edit the logo on channel ${ch.number}. Each aspect and resolution combination keeps its own placement.`
    : 'Edit the logo over the running channel. Each aspect and resolution combination keeps its own placement.';
  const liveBtn = document.createElement('button');
  liveBtn.type = 'button';
  liveBtn.className = 'btn btn-primary logobug-live-open';
  liveBtn.textContent = ch ? `TUNE TO CHANNEL ${ch.number} & EDIT` : 'EDIT ON CURRENT CHANNEL';
  liveBtn.disabled = !(S.config.channels && S.config.channels.length);
  liveBtn.title = liveBtn.disabled
    ? 'Add a channel before opening the live placement editor'
    : ch
      ? `Tune to channel ${ch.number} and overlay an alignment grid to edit placement in real time`
      : 'Overlay an alignment grid on the running channel and edit placement in real time';
  liveBtn.addEventListener('click', () => openLiveLogoBugEditor({
    getProfiles, setProfiles, onLiveChange, channelNumber: ch && ch.number,
  }));
  wrap.append(explanation, liveBtn);
  return wrap;
}

// Repeatable rule-row list for dynamicOverlays (channels.js) — box-wide
// (S.config.display.dynamicOverlays, setup-settings.js) and per-channel
// (ch.dynamicOverlays, setup-panels.js) both call this with their own
// get/set pair, same reuse pattern as buildLogoBugProfileEditor above. Each
// rule fires a user-picked image/video in one screen corner (or a custom
// dragged spot) when its trigger condition happens (channel tune-in,
// program start, or a specific break type), optionally scoped to content
// carrying a particular tag — see dynamic-overlays.js for the actual
// runtime side. ch (optional): the channel these rules belong to, so
// POSITION opens the live editor tuned to it, same reasoning as
// buildLogoBugProfileEditor's own ch param.
export function buildDynamicOverlaysEditor(getRules, setRules, ch) {
  const wrap = document.createElement('div');
  wrap.className = 'dynamic-overlays-editor';
  const list = document.createElement('div');
  list.className = 'dynamic-overlays-list';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.textContent = 'ADD OVERLAY RULE';

  function render() {
    list.innerHTML = '';
    const rules = normalizeDynamicOverlays(getRules());
    if (!rules.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-status';
      empty.textContent = 'No overlay rules yet — add one below.';
      list.appendChild(empty);
    }
    rules.forEach((rule) => {
      const row = document.createElement('div');
      row.className = 'dynamic-overlay-rule-row';

      const triggerSelect = document.createElement('select');
      DYNAMIC_OVERLAY_TRIGGERS.forEach(({ id, label }) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        triggerSelect.appendChild(opt);
      });
      triggerSelect.value = rule.trigger;
      triggerSelect.addEventListener('change', () => {
        rule.trigger = triggerSelect.value;
        setRules(rules);
      });

      const mediaField = document.createElement('div');
      mediaField.className = 'dynamic-overlay-rule-media';
      const thumb = buildMediaThumbnail(rule.mediaPath, { label: 'MEDIA' });
      const mediaBtnRow = document.createElement('div');
      mediaBtnRow.className = 'dynamic-overlay-rule-media-buttons';
      const imgBtn = document.createElement('button');
      imgBtn.type = 'button';
      imgBtn.className = 'btn';
      imgBtn.textContent = 'IMAGE…';
      imgBtn.addEventListener('click', async () => {
        const path = await window.api.selectImage();
        if (!path) return;
        rule.mediaPath = path;
        setRules(rules);
        render();
      });
      const vidBtn = document.createElement('button');
      vidBtn.type = 'button';
      vidBtn.className = 'btn';
      vidBtn.textContent = 'VIDEO…';
      vidBtn.addEventListener('click', async () => {
        const path = await window.api.selectVideo();
        if (!path) return;
        rule.mediaPath = path;
        setRules(rules);
        render();
      });
      mediaBtnRow.append(imgBtn, vidBtn);
      const mediaName = document.createElement('span');
      mediaName.className = 'dynamic-overlay-rule-media-name';
      mediaName.textContent = rule.mediaPath ? basenameNoExt(rule.mediaPath) : '(no file chosen)';
      mediaField.append(thumb, mediaBtnRow, mediaName);

      const cornerSelect = document.createElement('select');
      DYNAMIC_OVERLAY_CORNERS.forEach((corner) => {
        const opt = document.createElement('option');
        opt.value = corner;
        opt.textContent = corner.replace('-', ' ').toUpperCase();
        cornerSelect.appendChild(opt);
      });
      cornerSelect.value = rule.corner;
      cornerSelect.addEventListener('change', () => {
        rule.corner = cornerSelect.value;
        setRules(rules);
        render();
      });

      // Only meaningful (and only shown) once CORNER is set to 'custom' —
      // opens the same drag/resize-grid editor the logo bug and ticker use,
      // scoped to this one rule's own x/y (openDynamicOverlayPositionEditor
      // above), rather than a fixed corner preset.
      const positionBtn = document.createElement('button');
      positionBtn.type = 'button';
      positionBtn.className = 'btn';
      positionBtn.textContent = Number.isFinite(rule.x) ? 'REPOSITION…' : 'SET POSITION…';
      positionBtn.title = 'Drag this overlay to an exact spot on the running channel';
      positionBtn.addEventListener('click', () => openDynamicOverlayPositionEditor({
        rule,
        channelNumber: ch && ch.number,
        onApply: (x, y) => {
          rule.x = x;
          rule.y = y;
          setRules(rules);
          render();
        },
      }));

      const sizeInput = document.createElement('input');
      sizeInput.type = 'number';
      sizeInput.min = 40;
      sizeInput.max = 600;
      sizeInput.className = 'block-priority-input';
      sizeInput.title = 'Overlay size in pixels (longest side)';
      sizeInput.value = rule.size;
      sizeInput.addEventListener('change', () => {
        rule.size = parsePositiveInt(sizeInput.value, 160);
        setRules(rules);
      });

      const durationInput = document.createElement('input');
      durationInput.type = 'number';
      durationInput.min = 0;
      durationInput.className = 'block-priority-input';
      durationInput.title = 'How long the overlay stays up, in seconds. 0 = auto: the rest of the break for a break-type trigger, or a short default for tune-in/program-start.';
      durationInput.value = Math.round(rule.durationMs / 1000);
      durationInput.addEventListener('change', () => {
        rule.durationMs = Math.max(0, parsePositiveInt(durationInput.value, 0) * 1000);
        setRules(rules);
      });

      // Scopes the rule to content carrying at least one of these tags (see
      // the TITLES tab, setup-panels.js, for tagging files, or a channel's
      // own content tags), on top of the trigger moment already selected
      // above — blank (the default) means untargeted, same "any content"
      // convention as ad-pool entry tag targeting.
      const tagsInput = document.createElement('input');
      tagsInput.type = 'text';
      tagsInput.className = 'title-row-input';
      tagsInput.placeholder = 'e.g. holiday, halloween';
      tagsInput.value = (rule.contentTags || []).join(', ');
      tagsInput.addEventListener('change', () => {
        rule.contentTags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        setRules(rules);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn remove-btn';
      removeBtn.textContent = 'X';
      removeBtn.title = 'REMOVE';
      removeBtn.setAttribute('aria-label', 'Remove overlay rule');
      removeBtn.addEventListener('click', () => {
        setRules(getRules().filter((r) => r.id !== rule.id));
        render();
      });

      row.append(
        labeledMini('TRIGGER', triggerSelect),
        mediaField,
        labeledMini('CORNER', cornerSelect),
      );
      if (rule.corner === 'custom') row.appendChild(labeledMini('', positionBtn));
      row.append(
        labeledMini('SIZE (PX)', sizeInput),
        labeledMini('DURATION (S)', durationInput),
        labeledMini('CONTENT TAGS (BLANK = ANY)', attachTagAutocomplete(tagsInput)),
        removeBtn,
      );
      list.appendChild(row);
    });
  }

  function labeledMini(text, control) {
    const field = document.createElement('label');
    field.className = 'dynamic-overlay-rule-field';
    field.appendChild(document.createTextNode(text));
    field.appendChild(control);
    return field;
  }

  addBtn.addEventListener('click', () => {
    const rules = getRules() || [];
    setRules([...rules, {
      id: newDynamicOverlayId(), trigger: 'tuneIn', mediaPath: '', corner: 'bottom-right', size: 160, durationMs: 0,
    }]);
    render();
  });

  render();
  wrap.append(list, addBtn);
  return wrap;
}

// Editor for ch.iconOverrides — same getRules/setRules + rebuild-on-change
// shape as buildDynamicOverlaysEditor above. Month/day fields are plain
// 1-12/1-31 number inputs rather than a date picker since these are
// recurring-every-year calendar ranges, not specific dates.
export function buildIconOverridesEditor(getOverrides, setOverrides) {
  const wrap = document.createElement('div');
  wrap.className = 'dynamic-overlays-editor';
  const list = document.createElement('div');
  list.className = 'dynamic-overlays-list';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.textContent = 'ADD SEASONAL ICON';

  function render() {
    list.innerHTML = '';
    const overrides = normalizeIconOverrides(getOverrides());
    if (!overrides.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-status';
      empty.textContent = 'No seasonal icons yet — add one below to swap the logo bug during a date range (e.g. Dec 1-25).';
      list.appendChild(empty);
    }
    overrides.forEach((o) => {
      const row = document.createElement('div');
      row.className = 'dynamic-overlay-rule-row';

      function monthDayInput(value, onChange) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = 1;
        input.className = 'block-priority-input';
        input.value = value;
        input.addEventListener('change', () => {
          onChange(parsePositiveInt(input.value, 1));
          setOverrides(overrides);
        });
        return input;
      }

      const startMonthInput = monthDayInput(o.startMonth, (v) => { o.startMonth = Math.min(12, v); });
      const startDayInput = monthDayInput(o.startDay, (v) => { o.startDay = Math.min(31, v); });
      const endMonthInput = monthDayInput(o.endMonth, (v) => { o.endMonth = Math.min(12, v); });
      const endDayInput = monthDayInput(o.endDay, (v) => { o.endDay = Math.min(31, v); });

      const mediaField = document.createElement('div');
      mediaField.className = 'dynamic-overlay-rule-media';
      const thumb = buildMediaThumbnail(o.icon, { label: 'ICON' });
      const imgBtn = document.createElement('button');
      imgBtn.type = 'button';
      imgBtn.className = 'btn';
      imgBtn.textContent = 'IMAGE…';
      imgBtn.addEventListener('click', async () => {
        const path = await window.api.selectImage();
        if (!path) return;
        o.icon = path;
        setOverrides(overrides);
        render();
      });
      const mediaName = document.createElement('span');
      mediaName.className = 'dynamic-overlay-rule-media-name';
      mediaName.textContent = o.icon ? basenameNoExt(o.icon) : '(no icon chosen)';
      mediaField.append(thumb, imgBtn, mediaName);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn remove-btn';
      removeBtn.textContent = 'X';
      removeBtn.title = 'REMOVE';
      removeBtn.setAttribute('aria-label', 'Remove seasonal icon');
      removeBtn.addEventListener('click', () => {
        setOverrides((getOverrides() || []).filter((x) => x.id !== o.id));
        render();
      });

      row.append(
        labeledMiniIcon('FROM (MM)', startMonthInput),
        labeledMiniIcon('(DD)', startDayInput),
        labeledMiniIcon('TO (MM)', endMonthInput),
        labeledMiniIcon('(DD)', endDayInput),
        mediaField,
        removeBtn,
      );
      list.appendChild(row);
    });
  }

  function labeledMiniIcon(text, control) {
    const field = document.createElement('label');
    field.className = 'dynamic-overlay-rule-field';
    field.appendChild(document.createTextNode(text));
    field.appendChild(control);
    return field;
  }

  addBtn.addEventListener('click', () => {
    const overrides = getOverrides() || [];
    setOverrides([...overrides, {
      id: newDynamicOverlayId(), startMonth: 12, startDay: 1, endMonth: 12, endDay: 25, icon: '',
    }]);
    render();
  });

  render();
  wrap.append(list, addBtn);
  return wrap;
}

// Editor for S.config.preemptionWindows — absolute real-clock ranges
// (start/end, not a recurring cadence) that resolveBreakAt (interstitials.js)
// checks ahead of every other break type. Same getRules/setRules +
// rebuild-the-whole-list-on-any-change shape as buildDynamicOverlaysEditor
// above, since the underlying data is the same "array of small config
// objects with a remove button" shape.
export function buildPreemptionWindowsEditor(getWindows, setWindows) {
  const wrap = document.createElement('div');
  wrap.className = 'dynamic-overlays-editor';
  const list = document.createElement('div');
  list.className = 'dynamic-overlays-list';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.textContent = 'ADD PREEMPTION WINDOW';

  function render() {
    list.innerHTML = '';
    const windows = getWindows() || [];
    if (!windows.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-status';
      empty.textContent = 'No preemption windows scheduled — add one below.';
      list.appendChild(empty);
    }
    windows.forEach((w) => {
      const row = document.createElement('div');
      row.className = 'dynamic-overlay-rule-row';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'title-row-input';
      labelInput.placeholder = 'SPECIAL REPORT';
      labelInput.value = w.label || '';
      labelInput.addEventListener('change', () => {
        w.label = labelInput.value.trim();
        setWindows(windows);
      });

      const channelSelect = document.createElement('select');
      const anyOpt = document.createElement('option');
      anyOpt.value = '';
      anyOpt.textContent = 'ALL CHANNELS';
      channelSelect.appendChild(anyOpt);
      sortedChannels().forEach((ch) => {
        const opt = document.createElement('option');
        opt.value = String(ch.number);
        opt.textContent = `CH ${ch.number} — ${ch.name || 'UNNAMED'}`;
        channelSelect.appendChild(opt);
      });
      channelSelect.value = w.channelNumber != null ? String(w.channelNumber) : '';
      channelSelect.addEventListener('change', () => {
        w.channelNumber = channelSelect.value === '' ? null : Number(channelSelect.value);
        setWindows(windows);
      });

      // ONE-TIME (absolute start/end) vs WEEKLY (a standing weekday/time
      // slot, e.g. a Sunday local-access hour) — resolveBreakAt
      // (interstitials.js) branches on this same `kind` field. Switching it
      // re-renders the whole row so only the relevant fields show.
      const kindSelect = document.createElement('select');
      [['once', 'ONE-TIME'], ['weekly', 'WEEKLY']].forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        kindSelect.appendChild(opt);
      });
      kindSelect.value = w.kind === 'weekly' ? 'weekly' : 'once';
      kindSelect.addEventListener('change', () => {
        w.kind = kindSelect.value;
        setWindows(windows);
        render();
      });

      const fields = [labeledMiniPreemption('LABEL', labelInput), labeledMiniPreemption('CHANNEL', channelSelect), labeledMiniPreemption('KIND', kindSelect)];

      if (w.kind === 'weekly') {
        const weekdaySelect = document.createElement('select');
        ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].forEach((day, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = day;
          weekdaySelect.appendChild(opt);
        });
        weekdaySelect.value = String(w.weekday || 0);
        weekdaySelect.addEventListener('change', () => {
          w.weekday = Number(weekdaySelect.value);
          setWindows(windows);
        });

        const hourInput = document.createElement('input');
        hourInput.type = 'number';
        hourInput.min = 0;
        hourInput.max = 23;
        hourInput.className = 'block-priority-input';
        hourInput.value = w.startHour != null ? w.startHour : 13;
        hourInput.addEventListener('change', () => {
          { const h = parseInt(hourInput.value, 10); w.startHour = Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 13; hourInput.value = w.startHour; }
          setWindows(windows);
        });

        const minuteInput = document.createElement('input');
        minuteInput.type = 'number';
        minuteInput.min = 0;
        minuteInput.max = 59;
        minuteInput.className = 'block-priority-input';
        minuteInput.value = w.startMinute != null ? w.startMinute : 0;
        minuteInput.addEventListener('change', () => {
          w.startMinute = Math.min(59, Math.max(0, parsePositiveInt(minuteInput.value, 0)));
          setWindows(windows);
        });

        const durationInput = document.createElement('input');
        durationInput.type = 'number';
        durationInput.min = 1;
        durationInput.className = 'block-priority-input';
        durationInput.value = w.durationMin || 30;
        durationInput.addEventListener('change', () => {
          w.durationMin = Math.max(1, parsePositiveInt(durationInput.value, 30));
          setWindows(windows);
        });

        fields.push(
          labeledMiniPreemption('DAY', weekdaySelect),
          labeledMiniPreemption('HOUR', hourInput),
          labeledMiniPreemption('MIN', minuteInput),
          labeledMiniPreemption('DURATION (MIN)', durationInput),
        );
      } else {
        const startInput = document.createElement('input');
        startInput.type = 'datetime-local';
        startInput.value = w.startMs ? toDatetimeLocalValue(new Date(w.startMs)) : '';
        startInput.addEventListener('change', () => {
          const ms = new Date(startInput.value).getTime();
          if (!isNaN(ms)) w.startMs = ms;
          setWindows(windows);
        });

        const endInput = document.createElement('input');
        endInput.type = 'datetime-local';
        endInput.value = w.endMs ? toDatetimeLocalValue(new Date(w.endMs)) : '';
        endInput.addEventListener('change', () => {
          const ms = new Date(endInput.value).getTime();
          if (!isNaN(ms)) w.endMs = ms;
          setWindows(windows);
        });

        fields.push(labeledMiniPreemption('START', startInput), labeledMiniPreemption('END', endInput));
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn remove-btn';
      removeBtn.textContent = 'X';
      removeBtn.title = 'REMOVE';
      removeBtn.setAttribute('aria-label', 'Remove preemption window');
      removeBtn.addEventListener('click', () => {
        setWindows((getWindows() || []).filter((x) => x.id !== w.id));
        render();
      });

      row.append(...fields, removeBtn);
      list.appendChild(row);
    });
  }

  function labeledMiniPreemption(text, control) {
    const field = document.createElement('label');
    field.className = 'dynamic-overlay-rule-field';
    field.appendChild(document.createTextNode(text));
    field.appendChild(control);
    return field;
  }

  addBtn.addEventListener('click', () => {
    const windows = getWindows() || [];
    const now = Date.now();
    setWindows([...windows, {
      id: randomId('preempt'), label: '', channelNumber: null, kind: 'once', startMs: now, endMs: now + 15 * 60000,
      weekday: 0, startHour: 13, startMinute: 0, durationMin: 30,
    }]);
    render();
  });

  render();
  wrap.append(list, addBtn);
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
// `fallback` is what an unreadable file reports. Playlists use 180 s so a bad
// file still schedules; the media library passes null, because a guessed
// length stored in the catalogue would be copied into every smart channel.
export function probeDuration(filePath, { fallback = 180 } = {}) {
  return new Promise((resolve) => {
    Promise.resolve(window.api.toFileUrl(filePath)).then((url) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    const timer = setTimeout(() => resolve(fallback), 4000);
    v.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      const d = isFinite(v.duration) && v.duration > 0 ? v.duration : fallback;
      resolve(d);
      v.src = '';
    });
    v.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(fallback);
    });
    }).catch(() => resolve(fallback));
  });
}

// Source-aware sibling of probeDuration above — 'local' defers to the exact
// existing <video>-element probe (byte-identical to every call site before
// this existed), anything else asks that provider's own probe() service via
// the main-process dispatch layer (media:probeDuration, main.js/
// main-media-dispatch.js), since a plugin-sourced ref has no playback
// dispatch path a <video> element could load in the first place.
export async function probeDurationForEntry(source, ref, opts) {
  if (!source || source === 'local') return probeDuration(ref, opts);
  return window.api.probeDuration(source, ref);
}
