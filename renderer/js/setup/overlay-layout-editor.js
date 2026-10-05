// The live on-screen layout editor (the O key, and the LIVE EDITOR buttons in
// DISPLAY and in a channel's OVERLAYS): drag, resize and fine-tune the channel
// logo and every other card or bar, against the channel that is actually
// playing. Split out of setup/util.js; the stored data is unchanged
// (display.logoBugProfiles / ch.logoBugProfiles / display.overlayLayouts /
// ch.tickerLayout, one profile per picture shape + resolution).
//
// What the screen shows while it is open:
//   * the stage (.logobug-live-overlay) over the running picture: a grid,
//     optional TV safe-area frames, the selected element's box + handles, a
//     readout tag, the gaps to the screen edges while moving, and alignment
//     guides when it snaps to something;
//   * the PICTURE PREVIEW: the box the picture will occupy (the real one, or a
//     4:3 / 2.35:1 stand-in) and a dashed GHOST where the element will actually
//     land on that picture, since the logo and the corner badges are placed on
//     the picture, not the screen;
//   * a control panel that docks to whichever edge the selection is NOT near.
//
// perChannelOverlay (optional): { targetId, getProfiles, setProfiles } —
// redirects the active target's profiles to a per-channel store (e.g.
// ch.tickerLayout, channels.js) instead of display.overlayLayouts[id]. The
// session opens with that target already selected (panels.js uses it for the
// ticker bar).
import { S, commitInPlace } from '../core/state.js';
import { deepClone } from '../core/util.js';

let profileIdCounter = 0;
function newProfileId() { return `p${Date.now().toString(36)}${(profileIdCounter++).toString(36)}`; }

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { className, text, attrs, ...rest } = props;
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (attrs) Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  Object.assign(node, rest);
  children.forEach((child) => { if (child) node.append(child); });
  return node;
}

const round1 = (value) => Math.round(value * 10) / 10;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// What an element shows when it is empty (most badges only exist while
// something is airing), so it can be placed without waiting for that.
const SAMPLE_TEXT = {
  'rating-bug': 'TV-PG',
  'episode-status-bug': 'NEW EPISODE',
  'capability-badge': 'CC · SAP · STEREO',
  'timeshift-badge': '● TIME SHIFT −0:15',
  'volume-indicator': 'VOLUME ▮▮▮▮▮▯▯▯',
  'channel-entry': '24',
  'vcr-osd': '▶ PLAY',
};

// The shapes a placement can be saved for, and the ones "same for all" fills.
const ALL_SHAPES = [
  ['16:9', 'native'], ['16:9', 'sd480'], ['16:9', 'sd240'],
  ['4:3', 'native'], ['4:3', 'sd480'], ['4:3', 'sd240'],
];

const UI_KEY = 'reruntv.layoutEditor.v1';
function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; }
}
function saveUi(patch) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUi(), ...patch })); } catch (e) { /* storage can be blocked; the panel just forgets */ }
}

export async function openLiveLogoBugEditor({ getProfiles, setProfiles, onLiveChange, perChannelOverlay, channelNumber }) {
  const profileSnapshot = (getProfiles() || []).map((profile) => ({ ...profile }));
  const displayModeSnapshot = { ...(S.config.displayMode || {}) };
  const autoAdjustSnapshot = Boolean(S.config.display && S.config.display.logoBugAutoAdjust);
  const snapIncrementSnapshot = Number(S.config.display && S.config.display.overlaySnapIncrement) || 0;
  const overlayLayoutsSnapshot = deepClone((S.config.display && S.config.display.overlayLayouts) || {});
  const [{ showSetupScreen, showTvScreen }, displayMode, channels, fx] = await Promise.all([
    import('../app.js'), import('../display/mode.js'), import('../core/channels.js'), import('../playback/broadcast-fx.js'),
  ]);

  await showTvScreen();
  // channelNumber (per-channel overrides) always wins: you are editing THAT
  // channel's placement, so the preview has to be tuned to it, or a channel
  // whose content tags pick a different shape/resolution would show the wrong
  // context the whole time. The box-wide editor has no channel of its own and
  // only makes sure something real is tuned.
  if (channelNumber != null && S.currentNumber !== channelNumber && window.tuneToChannel) {
    await window.tuneToChannel(channelNumber, { silent: true });
  } else {
    const currentIsReal = (S.config.channels || []).some((channel) => channel.number === S.currentNumber);
    if (!currentIsReal && S.config.channels && S.config.channels.length && window.tuneToChannel) {
      await window.tuneToChannel(S.config.channels[0].number, { silent: true });
    }
  }

  const crt = document.querySelector('.crt');
  const app = document.getElementById('app');
  const logo = document.getElementById('logo-bug');
  if (!crt || !app || !logo) return;
  const targetLabels = new Map([['logo-bug', 'CHANNEL LOGO'], ...displayMode.OVERLAY_LAYOUT_TARGETS.map(({ id, label }) => [id, label])]);
  const previewElements = new Map([...targetLabels.keys()].map((id) => {
    const element = document.getElementById(id);
    return [id, element && { className: element.className, style: element.getAttribute('style') }];
  }));
  // Elements whose empty content was replaced by sample text: id -> original HTML.
  const injected = new Map();
  const saved = loadUi();

  // ---------- Stage ----------

  const overlay = el('div', { className: 'logobug-live-overlay', attrs: { role: 'application', 'aria-label': 'On-screen layout editor' } });
  overlay.dataset.guides = 'grid';
  const safeAction = el('div', { className: 'logobug-live-safe logobug-live-safe-action' }, el('span', { text: 'ACTION SAFE' }));
  const safeTitle = el('div', { className: 'logobug-live-safe logobug-live-safe-title' }, el('span', { text: 'TITLE SAFE' }));
  const pictureFrame = el('div', { className: 'logobug-live-picture hidden' }, el('span', { text: 'PICTURE' }));
  const othersLayer = el('div', { className: 'logobug-live-others' });
  const ghost = el('div', { className: 'logobug-live-ghost hidden' }, el('span', { text: 'LANDS HERE ON THE PICTURE' }));
  const guideV = el('div', { className: 'logobug-live-guide logobug-live-guide-v hidden' });
  const guideH = el('div', { className: 'logobug-live-guide logobug-live-guide-h hidden' });
  const gaps = ['left', 'right', 'top', 'bottom'].map((side) => el('div', { className: `logobug-live-gap logobug-live-gap-${side} hidden` }, el('span')));
  const tag = el('div', { className: 'logobug-live-tag' });
  const selection = el('div', {
    className: 'logobug-live-selection',
    tabIndex: 0,
    attrs: {
      role: 'group',
      'aria-roledescription': 'movable overlay',
      'aria-label': 'Selected element. Arrow keys move it, Shift for bigger steps, plus and minus resize.',
    },
  });
  const resizeEdges = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const handles = resizeEdges.map((edge) => {
    const handle = el('div', { className: `logobug-live-anchor logobug-live-anchor-${edge}`, attrs: { 'aria-hidden': 'true' } });
    handle.dataset.edge = edge;
    selection.appendChild(handle);
    return handle;
  });
  overlay.append(safeAction, safeTitle, pictureFrame, othersLayer, ghost, ...gaps, guideV, guideH, selection, tag);

  // ---------- Panel ----------

  const status = el('div', { className: 'logobug-live-status', attrs: { 'aria-live': 'polite' } });
  const context = el('div', { className: 'logobug-live-context' });
  const scopePill = el('div', { className: 'logobug-live-context logobug-live-scope' });
  const undoButton = el('button', { type: 'button', className: 'btn logobug-live-small', text: '↶ UNDO', title: 'Undo the last move (Ctrl+Z)' });
  const redoButton = el('button', { type: 'button', className: 'btn logobug-live-small', text: '↷ REDO', title: 'Redo (Ctrl+Y)' });
  const dockButton = el('button', { type: 'button', className: 'btn logobug-live-small', text: 'MOVE PANEL', title: 'Put the controls on the other edge of the screen' });
  const hideButton = el('button', { type: 'button', className: 'btn logobug-live-small', text: 'HIDE', title: 'Hide the controls to see the whole picture (click again to bring them back)', attrs: { 'aria-pressed': 'false' } });
  function field(labelText, control, extraClass = '') {
    return el('label', { className: `logobug-live-field ${extraClass}`.trim() }, el('span', { className: 'logobug-live-label', text: labelText }), control);
  }
  function select(options) {
    const node = el('select');
    options.forEach(([value, text]) => node.appendChild(el('option', { value: String(value), text })));
    return node;
  }
  function group(legend, help, ...fields) {
    return el('fieldset', { className: 'logobug-live-group' },
      el('legend', { text: legend }),
      el('div', { className: 'logobug-live-group-fields' }, ...fields),
      help ? el('p', { className: 'logobug-live-help', text: help }) : null);
  }

  const targetSelect = select([...targetLabels.entries()]);
  if (perChannelOverlay) targetSelect.value = perChannelOverlay.targetId;
  const targetField = field('EDITING', targetSelect, 'logobug-live-target');
  const head = el('div', { className: 'logobug-live-head' },
    el('div', { className: 'logobug-live-title', text: 'LIVE OVERLAY LAYOUT' }), context, scopePill, status, targetField,
    el('div', { className: 'logobug-live-head-buttons' }, undoButton, redoButton, dockButton, hideButton));

  const aspectSelect = select([['16:9', '16:9'], ['4:3', '4:3'], ['auto', 'AUTO']]);
  const windowSelect = select([['letterbox', 'LETTERBOX'], ['lockWindow', 'LOCK WINDOW']]);
  const resolutionSelect = select([['native', 'NATIVE'], ['sd480', 'SD 480'], ['sd240', 'SD 240'], ['auto', 'AUTO']]);
  const previewSelects = [[aspectSelect, 'aspect'], [windowSelect, 'windowMode'], [resolutionSelect, 'resolution']];
  previewSelects.forEach(([node, key]) => {
    node.value = (S.config.displayMode && S.config.displayMode[key]) || node.options[0].value;
    node.addEventListener('change', async () => {
      S.config.displayMode = { ...(S.config.displayMode || {}), [key]: node.value };
      await displayMode.applyDisplayModeSettled();
      selectProfileForContext();
    });
  });
  const autoAdjust = el('input', { type: 'checkbox', checked: autoAdjustSnapshot });
  const autoLabel = el('label', { className: 'logobug-live-auto' }, autoAdjust, document.createTextNode(' FOLLOW WHAT IS PLAYING'));
  const previewHelp = el('p', { className: 'logobug-live-help' });

  const inputs = {
    x: el('input', { type: 'number', min: '0', max: '100', step: '0.1', inputMode: 'decimal' }),
    y: el('input', { type: 'number', min: '0', max: '100', step: '0.1', inputMode: 'decimal' }),
    a: el('input', { type: 'number', step: '1', inputMode: 'decimal' }),
    b: el('input', { type: 'number', step: '1', inputMode: 'decimal' }),
  };
  const aLabel = el('span', { className: 'logobug-live-label' });
  const bLabel = el('span', { className: 'logobug-live-label' });
  const fieldA = el('label', { className: 'logobug-live-field logobug-live-coordinate' }, aLabel, inputs.a);
  const fieldB = el('label', { className: 'logobug-live-field logobug-live-coordinate' }, bLabel, inputs.b);
  const lockInput = el('input', { type: 'checkbox', checked: true });
  const lockLabel = el('label', { className: 'logobug-live-auto', title: 'Changing the width also changes the height to match' }, lockInput, document.createTextNode(' KEEP SHAPE'));
  const opacitySlider = el('input', { type: 'range', min: '10', max: '100' });
  const opacityValue = el('output', { className: 'logobug-live-value' });
  const opacityField = el('label', { className: 'logobug-live-field logobug-live-opacity' },
    el('span', { className: 'logobug-live-label', text: 'OPACITY' }),
    el('span', { className: 'logobug-live-slider' }, opacitySlider, opacityValue));
  const resetButton = el('button', { type: 'button', className: 'btn logobug-live-small logobug-live-reset', text: 'REVERT THIS ONE', title: 'Put this placement back to how it was when you opened the editor' });
  const allShapesButton = el('button', { type: 'button', className: 'btn logobug-live-small', text: 'SAME FOR ALL SHAPES', title: 'Copy this placement to every picture shape and resolution (16:9 and 4:3, native, SD 480, SD 240)' });
  // A 3x3 pad: put the element in a corner, an edge or the middle, with the
  // usual gap from the edge.
  const nine = el('div', { className: 'logobug-live-nine', attrs: { role: 'group', 'aria-label': 'Move to a spot on the screen' } });
  const spots = [['TOP LEFT', 0, 0], ['TOP', 1, 0], ['TOP RIGHT', 2, 0], ['LEFT', 0, 1], ['CENTER', 1, 1], ['RIGHT', 2, 1], ['BOTTOM LEFT', 0, 2], ['BOTTOM', 1, 2], ['BOTTOM RIGHT', 2, 2]];
  spots.forEach(([name, column, row]) => {
    const spot = el('button', { type: 'button', className: 'logobug-live-spot', title: `Move to ${name.toLowerCase()}`, attrs: { 'aria-label': `Move to ${name.toLowerCase()}` } });
    spot.addEventListener('click', () => placeAt(column, row));
    nine.appendChild(spot);
  });

  const snapSelect = select([[0, 'OFF'], [1, '1%'], [2.5, '2.5%'], [5, '5%'], [10, '10%']]);
  snapSelect.value = String(snapIncrementSnapshot);
  const stepSelect = select([['auto', 'AUTO'], [0.1, '0.1%'], [0.5, '0.5%'], [1, '1%'], [2, '2%'], [5, '5%']]);
  stepSelect.value = saved.step != null ? String(saved.step) : 'auto';
  const guidesSelect = select([['grid', 'GRID'], ['safe', 'TV SAFE AREAS'], ['both', 'GRID + SAFE AREAS'], ['off', 'OFF']]);
  guidesSelect.value = ['grid', 'safe', 'both', 'off'].includes(saved.guides) ? saved.guides : 'grid';
  const pictureSelect = select([['current', 'THE REAL PICTURE'], ['full', 'FULL SCREEN'], ['4:3', '4:3 PICTURE'], ['2.35', '2.35:1 FILM'], ['1.85', '1.85:1 FILM']]);
  pictureSelect.value = ['current', 'full', '4:3', '2.35', '1.85'].includes(saved.preview) ? saved.preview : 'current';
  const othersInput = el('input', { type: 'checkbox', checked: Boolean(saved.others) });
  const othersLabel = el('label', { className: 'logobug-live-auto', title: 'Show the other cards and badges, dimmed, so you can see what they would collide with. Click one to edit it.' }, othersInput, document.createTextNode(' SHOW OTHER ELEMENTS'));
  const compareButton = el('button', { type: 'button', className: 'btn logobug-live-small logobug-live-compare', text: 'HOLD TO SEE ORIGINAL', title: 'Hold (or hold the B key) to see how it was when you opened the editor' });

  const actions = el('div', { className: 'logobug-live-actions' });
  const cancel = el('button', { type: 'button', className: 'btn', text: 'CANCEL' });
  const apply = el('button', { type: 'button', className: 'btn btn-primary', text: 'APPLY PLACEMENT' });
  actions.append(cancel, apply);

  const confirmKeep = el('button', { type: 'button', className: 'btn', text: 'KEEP EDITING' });
  const confirmDiscard = el('button', { type: 'button', className: 'btn btn-danger', text: 'DISCARD CHANGES' });
  const confirmBox = el('div', { className: 'logobug-live-confirm hidden', attrs: { role: 'alertdialog', 'aria-label': 'Discard changes?' } },
    el('span', { text: 'Leave without saving? Your moves in this editor will be lost.' }), confirmKeep, confirmDiscard);

  const toolsGroup = group('TOOLS', null, resetButton, allShapesButton, othersLabel, compareButton);
  toolsGroup.classList.add('logobug-live-tools');
  const body = el('div', { className: 'logobug-live-body' },
    group('PICTURE IT IS SAVED FOR',
      null, field('ASPECT', aspectSelect), field('WINDOW', windowSelect), field('RESOLUTION', resolutionSelect), autoLabel),
    group('VIEW & AIDS', null,
      field('SNAP GRID', snapSelect, 'logobug-live-snap'), field('NUDGE STEP', stepSelect), field('GUIDES', guidesSelect, 'logobug-live-guides'),
      field('PREVIEW ON', pictureSelect, 'logobug-live-preview')),
    actions,
    group('POSITION & SIZE', null,
      field('X %', inputs.x, 'logobug-live-coordinate'), field('Y %', inputs.y, 'logobug-live-coordinate'),
      fieldA, fieldB, lockLabel, opacityField, field('PLACE', nine, 'logobug-live-place')),
    toolsGroup);
  const hint = el('p', { className: 'logobug-live-hint',
    text: 'Drag to move (it snaps to edges, centres and other elements; hold Alt to turn that off) · handles resize, Shift keeps proportions · arrow keys nudge · + / − resize · [ ] switch element · hold B for the original · Ctrl+Z undo · Esc cancels' });
  const toolbar = el('div', { className: 'logobug-live-toolbar' }, head, body, hint, confirmBox);
  toolbar.dataset.dock = saved.dock === 'top' ? 'top' : 'bottom';
  body.children[0].appendChild(previewHelp);

  const logoWasHidden = logo.classList.contains('hidden');
  logo.classList.remove('hidden');
  let activeId = null;
  let activeTarget = perChannelOverlay ? perChannelOverlay.targetId : 'logo-bug';
  let dragging = false;
  let dockPinned = saved.dock === 'top' || saved.dock === 'bottom';
  let dirty = false;
  let comparing = false;
  let otherBoxes = [];
  const originalByTarget = new Map();
  // Placements the editor made up for a picture shape that had none. They
  // aren't saved unless the person edits them: opening the editor on SD 480
  // content shouldn't pin an SD 480 profile.
  const seededByTarget = new Map();

  // ---------- Geometry helpers ----------

  const W = () => overlay.clientWidth;
  const H = () => overlay.clientHeight;
  const toPx = (rect) => {
    const bounds = overlay.getBoundingClientRect();
    const sx = W() / (bounds.width || 1);
    const sy = H() / (bounds.height || 1);
    return { left: (rect.left - bounds.left) * sx, top: (rect.top - bounds.top) * sy, width: rect.width * sx, height: rect.height * sy };
  };
  const boxOf = (node) => toPx(node.getBoundingClientRect());
  const followsPicture = () => !(S.config.display && S.config.display.logoBugFollowPicture === false);

  // The box the picture will fill: the real one, or a stand-in shape.
  function pictureBox() {
    const full = { left: 0, top: 0, width: W(), height: H() };
    const mode = pictureSelect.value;
    if (mode === 'current') {
      const p = S.pictureRect;
      return p ? { left: p.left, top: p.top, width: p.width, height: p.height } : full;
    }
    const ratio = { '4:3': 4 / 3, '2.35': 2.35, '1.85': 1.85 }[mode];
    if (!ratio) return full;
    const width = W() / H() > ratio ? H() * ratio : W();
    const height = width / ratio;
    return { left: (W() - width) / 2, top: (H() - height) / 2, width, height };
  }

  // Where the selected element ends up once it is placed on the picture, or
  // null when it is placed on the screen (cards, bars) or the setting is off.
  function landingBox(profile) {
    if (!followsPicture()) return null;
    const pic = pictureBox();
    const width = selection.offsetWidth;
    const height = selection.offsetHeight;
    if (activeTarget === 'logo-bug') {
      return {
        left: fx.logoBugPosition(profile.x, width, pic.left, pic.width, W(), pic),
        top: fx.logoBugPosition(profile.y, height, pic.top, pic.height, H(), pic),
        width,
        height,
      };
    }
    if (displayMode.PICTURE_FOLLOWING_OVERLAYS.has(activeTarget)) {
      const dx = profile.x < 50 ? pic.left : -(W() - (pic.left + pic.width));
      const dy = profile.y < 50 ? pic.top : -(H() - (pic.top + pic.height));
      return { left: profile.x / 100 * W() + dx, top: profile.y / 100 * H() + dy, width, height };
    }
    return null;
  }

  // ---------- Snap + context ----------

  const snapIncrement = () => Number(snapSelect.value) || 0;
  const nudgeStep = () => (stepSelect.value === 'auto' ? (snapIncrement() || 0.5) : Number(stepSelect.value));

  function snapPercent(value, max, bypass = false) {
    const increment = bypass ? 0 : snapIncrement();
    const snapped = increment ? Math.round(value / increment) * increment : value;
    return clamp(snapped, 0, max);
  }

  function snapLogoSize(value, bypass = false) {
    const increment = bypass ? 0 : snapIncrement();
    if (!increment) return Math.round(value);
    const cellSize = Math.min(W(), H()) * increment / 100;
    return Math.round(value / cellSize) * cellSize;
  }

  function snapScale(value, bypass = false) {
    const increment = bypass ? 0 : snapIncrement() / 100;
    return increment ? Math.round(value / increment) * increment : value;
  }

  function syncGuides() {
    const increment = snapIncrement();
    overlay.classList.toggle('snap-enabled', increment > 0);
    overlay.dataset.guides = guidesSelect.value;
    overlay.style.setProperty('--overlay-grid-step', increment ? `${increment}%` : '5%');
    S.config.display.overlaySnapIncrement = increment;
    saveUi({ guides: guidesSelect.value, step: stepSelect.value });
    renderProfile();
  }

  // The logo is placed by the same rule the screen uses: one profile for all
  // content unless DISPLAY › Logo bug says it varies. Editing any other
  // profile would change something that is not the logo on screen.
  const logoIsPinned = () => activeTarget === 'logo-bug' && !(S.config.display && S.config.display.logoBugVaryWithContent);

  function currentContext() {
    if (activeTarget === 'logo-bug') return fx.activeLogoBugContext();
    return autoAdjust.checked ? displayMode.resolveContentDisplayMode() : displayMode.resolveEffectiveDisplayMode();
  }

  // The logo's size on screen: its stored size scaled to this screen's height
  // the way the running logo is, so the box drawn here is the logo itself. A
  // resize stamps the profile with this screen's height (updateProfile), after
  // which stored and drawn sizes are the same.
  function logoDims(profile) {
    const stored = channels.logoBugProfileDimensions(profile);
    const scale = fx.logoBugScale(profile);
    return { width: stored.width * scale, height: stored.height * scale };
  }

  function syncAutoState() {
    const pinned = logoIsPinned();
    previewSelects.forEach(([node]) => { node.disabled = autoAdjust.checked || pinned; });
    autoAdjust.disabled = pinned;
    allShapesButton.classList.toggle('hidden', pinned);
    previewHelp.textContent = pinned
      ? 'The logo uses one placement for all content (DISPLAY › Logo bug), so these are off.'
      : autoAdjust.checked
        ? 'Following what is playing, so these three are off.'
        : 'Saved separately for each picture shape and resolution.';
  }

  // Who else sees this placement: the one channel, or every channel.
  function scopeLabel() {
    if (activeTarget === 'logo-bug') {
      const channel = channelNumber != null ? channels.getChannel(channelNumber) : null;
      const own = channel && channel.logoBugProfiles && getProfiles() === channel.logoBugProfiles;
      return own ? `CHANNEL ${channelNumber} ONLY` : 'ALL CHANNELS WITHOUT THEIR OWN';
    }
    if (perChannelOverlay && activeTarget === perChannelOverlay.targetId) return `CHANNEL ${channelNumber} ONLY`;
    return 'ALL CHANNELS';
  }

  // ---------- Profiles ----------

  const activeProfile = () => targetProfiles().find((profile) => profile.id === activeId);
  const targetElement = () => document.getElementById(activeTarget);
  const isBarTarget = () => activeTarget === 'ticker-bar';

  function targetProfiles() {
    if (activeTarget === 'logo-bug') return channels.normalizeLogoBugProfiles(getProfiles());
    if (perChannelOverlay && activeTarget === perChannelOverlay.targetId) {
      return (perChannelOverlay.getProfiles() || []).map((profile) => ({ ...profile }));
    }
    return (((S.config.display || {}).overlayLayouts || {})[activeTarget] || []).map((profile) => ({ ...profile }));
  }

  function setTargetProfiles(profiles) {
    if (activeTarget === 'logo-bug') { setProfiles(profiles); return; }
    if (perChannelOverlay && activeTarget === perChannelOverlay.targetId) { perChannelOverlay.setProfiles(profiles); return; }
    S.config.display.overlayLayouts = { ...(S.config.display.overlayLayouts || {}), [activeTarget]: profiles };
  }

  function restorePreviewElement(id) {
    const element = document.getElementById(id);
    const snapshot = previewElements.get(id);
    if (!element || !snapshot) return;
    element.className = snapshot.className;
    if (snapshot.style == null) element.removeAttribute('style');
    else element.setAttribute('style', snapshot.style);
    if (injected.has(id)) { element.innerHTML = injected.get(id); injected.delete(id); }
  }

  function showSample(id, element) {
    if (id === 'logo-bug' || injected.has(id)) return;
    if (element.textContent.trim() || element.querySelector('img, canvas, svg, video')) return;
    injected.set(id, element.innerHTML);
    element.textContent = SAMPLE_TEXT[id] || targetLabels.get(id) || id;
  }

  function showTargetForEditing() {
    previewElements.forEach((_, id) => restorePreviewElement(id));
    // The element being placed stays on screen, and the logo as a reference.
    // The rest are hidden so a banner or card sitting on the spot can't cover
    // it, unless SHOW OTHER ELEMENTS asks to see them (dimmed).
    previewElements.forEach((_, id) => {
      if (id === activeTarget || id === 'logo-bug') return;
      const other = document.getElementById(id);
      if (!other) return;
      if (othersInput.checked) {
        other.classList.remove('hidden');
        other.classList.add('show');
        other.style.visibility = 'visible';
        other.style.opacity = '0.5';
        showSample(id, other);
      } else {
        other.classList.remove('show');
        other.style.visibility = 'hidden';
      }
    });
    // Nothing on the picture should take a click meant for the editor.
    previewElements.forEach((_, id) => { const node = document.getElementById(id); if (node) node.style.pointerEvents = 'none'; });
    const element = targetElement();
    if (!element) return;
    element.classList.remove('hidden');
    element.classList.add('show');
    // The logo bug's opacity is previewed live by renderProfile; the other
    // elements are normally hidden or fleeting, so they are shown solid.
    if (activeTarget !== 'logo-bug') { element.style.opacity = '1'; showSample(activeTarget, element); }
  }

  // Bounds-check a profile's x/y against the CURRENT overlay size (whichever
  // shape/resolution frame is active). Null when it is already fully on screen.
  function overflowFix(profile) {
    const element = targetElement();
    const dims = activeTarget === 'logo-bug' ? logoDims(profile)
      : isBarTarget() ? { width: (profile.width || 0) / 100 * W(), height: (profile.height || 0) / 100 * H() }
        : { width: element.offsetWidth * (profile.scale || 1), height: element.offsetHeight * (profile.scale || 1) };
    const maxX = Math.max(0, 100 - dims.width / W() * 100);
    const maxY = Math.max(0, 100 - dims.height / H() * 100);
    if (profile.x <= maxX && profile.y <= maxY) return null;
    return { x: round1(Math.min(profile.x, maxX)), y: round1(Math.min(profile.y, maxY)) };
  }

  function selectProfileForContext() {
    const context = currentContext();
    showTargetForEditing();
    const profiles = targetProfiles();
    if (!originalByTarget.has(activeTarget)) originalByTarget.set(activeTarget, deepClone(profiles));
    let exact = profiles.find((profile) => profile.aspect === context.aspect && profile.resolution === context.resolution);
    if (!exact) {
      const element = targetElement();
      const elementBox = toPx(element.getBoundingClientRect());
      const fromElement = () => ({ x: Math.max(0, elementBox.left / W() * 100), y: Math.max(0, elementBox.top / H() * 100) });
      const base = activeTarget === 'logo-bug'
        ? channels.pickLogoBugProfile(profiles, context) || channels.foldLogoBugCorner(null, null)[0]
        : profiles.find((profile) => (!profile.aspect || profile.aspect === context.aspect)
          && (!profile.resolution || profile.resolution === context.resolution)) || (isBarTarget()
          ? { ...fromElement(), width: elementBox.width / W() * 100, height: elementBox.height / H() * 100 }
          : { ...fromElement(), scale: 1 });
      exact = {
        id: newProfileId(),
        aspect: context.aspect,
        resolution: context.resolution,
        x: base.x,
        y: base.y,
        ...(activeTarget === 'logo-bug' ? (() => {
          const { width, height } = channels.logoBugProfileDimensions(base);
          const dim = { size: base.size };
          if (base.refH) dim.refH = base.refH;
          if (width !== base.size) dim.width = width;
          if (height !== base.size) dim.height = height;
          return dim;
        })() : isBarTarget() ? { width: base.width, height: base.height } : { scale: base.scale || 1 }),
      };
      // base was tuned against whatever frame was current when it was
      // authored (often a bigger one), so a fresh entry seeded from it can
      // start past the edge of this frame: bounds-check it once on creation.
      const fix = overflowFix(exact);
      if (fix) Object.assign(exact, fix);
      setTargetProfiles([...profiles, exact]);
      if (!seededByTarget.has(activeTarget)) seededByTarget.set(activeTarget, new Set());
      seededByTarget.get(activeTarget).add(exact.id);
    } else {
      // Self-heal an entry saved out of bounds by an older build.
      const fix = overflowFix(exact);
      if (fix) {
        exact = { ...exact, ...fix };
        setTargetProfiles(profiles.map((profile) => (profile.id === exact.id ? exact : profile)));
      }
    }
    activeId = exact.id;
    renderProfile();
    updateDock();
  }

  // ---------- History: undo, redo, compare ----------

  const undoStack = [];
  const redoStack = [];
  let lastCheckpoint = { key: null, at: 0 };

  function snapshotState() {
    return {
      logo: deepClone(getProfiles() || []),
      layouts: deepClone((S.config.display && S.config.display.overlayLayouts) || {}),
      per: perChannelOverlay ? deepClone(perChannelOverlay.getProfiles() || []) : null,
    };
  }

  function restoreState(state) {
    setProfiles(deepClone(state.logo));
    S.config.display.overlayLayouts = deepClone(state.layouts);
    if (perChannelOverlay && state.per) perChannelOverlay.setProfiles(deepClone(state.per));
    selectProfileForContext();
  }

  // Called before something changes, so Ctrl+Z can come back to now. A burst
  // of the same kind of edit (typing, a held arrow key) is one step.
  function checkpoint(key) {
    if (comparing) return;
    const now = Date.now();
    if (key && key === lastCheckpoint.key && now - lastCheckpoint.at < 700) { lastCheckpoint.at = now; return; }
    lastCheckpoint = { key, at: now };
    undoStack.push(snapshotState());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    syncHistoryButtons();
  }

  function syncHistoryButtons() {
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotState());
    restoreState(undoStack.pop());
    lastCheckpoint = { key: null, at: 0 };
    dirty = true;
    syncHistoryButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotState());
    restoreState(redoStack.pop());
    lastCheckpoint = { key: null, at: 0 };
    syncHistoryButtons();
  }

  const openingState = snapshotState();
  let beforeCompare = null;
  function setComparing(on) {
    if (on === comparing) return;
    if (on) {
      beforeCompare = snapshotState();
      comparing = true;
      restoreState(openingState);
    } else {
      comparing = false;
      if (beforeCompare) restoreState(beforeCompare);
      beforeCompare = null;
    }
    selection.classList.toggle('is-original', comparing);
    compareButton.classList.toggle('is-held', comparing);
    renderProfile();
  }

  // ---------- Rendering ----------

  function setInput(input, value) {
    if (document.activeElement === input) return;
    input.value = String(value);
  }

  function configureSizeFields(profile) {
    lockLabel.classList.toggle('hidden', activeTarget !== 'logo-bug');
    fieldB.classList.toggle('hidden', !(activeTarget === 'logo-bug' || isBarTarget()));
    if (activeTarget === 'logo-bug') {
      const { width, height } = logoDims(profile);
      aLabel.textContent = 'WIDTH PX'; bLabel.textContent = 'HEIGHT PX';
      Object.assign(inputs.a, { min: '14', max: String(Math.min(400, W())), step: '1' });
      Object.assign(inputs.b, { min: '14', max: String(Math.min(400, H())), step: '1' });
      setInput(inputs.a, Math.round(width)); setInput(inputs.b, Math.round(height));
    } else if (isBarTarget()) {
      aLabel.textContent = 'WIDTH %'; bLabel.textContent = 'HEIGHT %';
      Object.assign(inputs.a, { min: '2', max: '100', step: '0.5' });
      Object.assign(inputs.b, { min: '1', max: '100', step: '0.5' });
      setInput(inputs.a, (profile.width != null ? profile.width : 100).toFixed(1));
      setInput(inputs.b, (profile.height != null ? profile.height : 12).toFixed(1));
    } else {
      aLabel.textContent = 'SIZE %';
      Object.assign(inputs.a, { min: '50', max: '300', step: '5' });
      setInput(inputs.a, Math.round((profile.scale || 1) * 100));
    }
  }

  function sizeSummary(profile) {
    if (activeTarget === 'logo-bug') {
      const { width, height } = logoDims(profile);
      return width === height ? `${Math.round(width)}px` : `${Math.round(width)}×${Math.round(height)}px`;
    }
    if (isBarTarget()) return `${(profile.width != null ? profile.width : 100).toFixed(1)}% × ${(profile.height != null ? profile.height : 12).toFixed(1)}%`;
    return `${Math.round((profile.scale || 1) * 100)}%`;
  }

  function place(node, box) {
    Object.assign(node.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  }

  // The picture box, the ghost where the element lands on it, the readout tag.
  function renderPreview(profile) {
    const pic = pictureBox();
    const isFull = pic.left < 1 && pic.top < 1 && pic.width > W() - 2 && pic.height > H() - 2;
    pictureFrame.classList.toggle('hidden', isFull);
    if (!isFull) place(pictureFrame, pic);
    const landing = landingBox(profile);
    const own = { left: selection.offsetLeft, top: selection.offsetTop, width: selection.offsetWidth, height: selection.offsetHeight };
    const moved = landing && (Math.abs(landing.left - own.left) > 2 || Math.abs(landing.top - own.top) > 2);
    ghost.classList.toggle('hidden', !moved);
    if (moved) place(ghost, landing);
    // The readout rides above the box, or below it when there is no room.
    tag.textContent = `${profile.x.toFixed(1)}%, ${profile.y.toFixed(1)}% · ${sizeSummary(profile)}${selection.title ? ` · ${selection.title.toUpperCase()}` : ''}`;
    const above = own.top > 30;
    tag.style.left = `${clamp(own.left, 0, Math.max(0, W() - tag.offsetWidth - 4))}px`;
    tag.style.top = `${above ? own.top - tag.offsetHeight - 6 : own.top + own.height + 6}px`;
  }

  // Distances from the box to each edge of the screen, drawn while it moves.
  function renderGaps(show) {
    const left = selection.offsetLeft;
    const top = selection.offsetTop;
    const width = selection.offsetWidth;
    const height = selection.offsetHeight;
    const right = W() - left - width;
    const bottom = H() - top - height;
    const lines = [
      { gap: left, style: { left: '0px', top: `${top + height / 2}px`, width: `${left}px`, height: '0px' } },
      { gap: right, style: { left: `${left + width}px`, top: `${top + height / 2}px`, width: `${right}px`, height: '0px' } },
      { gap: top, style: { left: `${left + width / 2}px`, top: '0px', width: '0px', height: `${top}px` } },
      { gap: bottom, style: { left: `${left + width / 2}px`, top: `${top + height}px`, width: '0px', height: `${bottom}px` } },
    ];
    gaps.forEach((node, index) => {
      const { gap, style } = lines[index];
      node.classList.toggle('hidden', !show || gap < 14);
      if (show && gap >= 14) {
        Object.assign(node.style, style);
        node.firstChild.textContent = `${Math.round(gap)}px`;
      }
    });
  }
  let gapTimer = null;
  function flashGaps() {
    renderGaps(true);
    clearTimeout(gapTimer);
    gapTimer = setTimeout(() => { if (!dragging) renderGaps(false); }, 1400);
  }

  // The other elements, outlined and clickable, and whether this one collides.
  function renderOthers() {
    othersLayer.replaceChildren();
    otherBoxes = [];
    let overlapping = null;
    if (othersInput.checked) {
      const mine = { left: selection.offsetLeft, top: selection.offsetTop, width: selection.offsetWidth, height: selection.offsetHeight };
      previewElements.forEach((_, id) => {
        if (id === activeTarget) return;
        const node = document.getElementById(id);
        if (!node) return;
        const box = boxOf(node);
        if (box.width < 4 || box.height < 4 || getComputedStyle(node).visibility === 'hidden') return;
        otherBoxes.push(box);
        const button = el('button', { type: 'button', className: 'logobug-live-other', title: `Edit ${targetLabels.get(id)}` }, el('span', { text: targetLabels.get(id) }));
        place(button, box);
        button.addEventListener('click', () => { targetSelect.value = id; targetSelect.dispatchEvent(new Event('change')); });
        othersLayer.appendChild(button);
        const hit = mine.left < box.left + box.width && mine.left + mine.width > box.left && mine.top < box.top + box.height && mine.top + mine.height > box.top;
        if (hit && !overlapping) overlapping = targetLabels.get(id);
      });
    }
    selection.classList.toggle('is-overlapping', Boolean(overlapping));
    selection.title = overlapping ? `Overlaps ${overlapping}` : '';
    return overlapping;
  }

  function renderProfile() {
    const profile = activeProfile();
    const element = targetElement();
    if (!profile || !element) return;
    selection.style.left = `${profile.x}%`;
    selection.style.top = `${profile.y}%`;
    opacityField.classList.toggle('hidden', activeTarget !== 'logo-bug');
    if (activeTarget === 'logo-bug') {
      const { width, height } = logoDims(profile);
      selection.style.width = `${width}px`;
      selection.style.height = `${height}px`;
      logo.style.left = `${profile.x}%`;
      logo.style.top = `${profile.y}%`;
      logo.style.setProperty('--logo-bug-size', `${Math.min(width, height)}px`);
      logo.style.setProperty('--logo-bug-width', `${width}px`);
      logo.style.setProperty('--logo-bug-height', `${height}px`);
      const opacity = Number.isFinite(profile.opacity) ? profile.opacity : 55;
      opacitySlider.value = String(opacity);
      opacityValue.textContent = `${opacity}%`;
      logo.style.setProperty('--logo-bug-opacity', opacity / 100);
    } else if (isBarTarget()) {
      const width = profile.width != null ? profile.width : 100;
      const height = profile.height != null ? profile.height : 12;
      selection.style.width = `${width}%`;
      selection.style.height = `${height}%`;
      Object.assign(element.style, { left: `${profile.x}%`, top: `${profile.y}%`, right: 'auto', bottom: 'auto', transform: 'none', width: `${width}%`, height: `${height}%` });
    } else {
      const scale = profile.scale || 1;
      selection.style.width = `${element.offsetWidth * scale}px`;
      selection.style.height = `${element.offsetHeight * scale}px`;
      Object.assign(element.style, { left: `${profile.x}%`, top: `${profile.y}%`, right: 'auto', bottom: 'auto', transformOrigin: 'top left', transform: `scale(${scale})` });
    }
    const shape = `${profile.aspect} · ${profile.resolution === 'native' ? 'NATIVE' : String(profile.resolution).toUpperCase()}`;
    context.textContent = comparing ? 'SHOWING THE ORIGINAL'
      : logoIsPinned() ? `SAVING FOR ${shape} · ALL CONTENT`
        : autoAdjust.checked ? `SAVING FOR ${shape} · NOW PLAYING` : `SAVING FOR ${shape}`;
    scopePill.textContent = `APPLIES TO ${scopeLabel()}`;
    const overlapping = renderOthers();
    const snap = snapIncrement();
    status.textContent = `X ${profile.x.toFixed(1)}% Y ${profile.y.toFixed(1)}% · ${sizeSummary(profile)} · SNAP ${snap ? `${snap}%` : 'OFF'}${overlapping ? ` · OVERLAPS ${overlapping}` : ''}`;
    setInput(inputs.x, profile.x.toFixed(1));
    setInput(inputs.y, profile.y.toFixed(1));
    configureSizeFields(profile);
    renderPreview(profile);
    // Handles sit inside the box when it touches the screen edge, where
    // handles centred on the border would be cut off.
    const near = 10;
    selection.classList.toggle('at-left', selection.offsetLeft < near);
    selection.classList.toggle('at-top', selection.offsetTop < near);
    selection.classList.toggle('at-right', W() - (selection.offsetLeft + selection.offsetWidth) < near);
    selection.classList.toggle('at-bottom', H() - (selection.offsetTop + selection.offsetHeight) < near);
  }

  // The panel goes to the edge the selection is not near, unless the person
  // moved it themselves. Not while dragging: a panel that jumps mid-drag is
  // worse than one in the way.
  function updateDock() {
    if (dockPinned || dragging) return;
    const middle = selection.offsetTop + selection.offsetHeight / 2;
    toolbar.dataset.dock = middle > H() / 2 ? 'top' : 'bottom';
  }

  const DELETE = Symbol('DELETE');
  function updateProfile(patch) {
    if (comparing) return;
    dirty = true;
    const seeded = seededByTarget.get(activeTarget);
    if (seeded) seeded.delete(activeId);
    setTargetProfiles(targetProfiles().map((profile) => {
      if (profile.id !== activeId) return profile;
      const next = { ...profile, ...patch };
      // A logo bug size is in screen pixels; remember which screen it was set on.
      if (activeTarget === 'logo-bug' && patch.size != null) next.refH = Math.round(H());
      // Keys set to DELETE are removed (width/height when resized back to a square).
      Object.keys(next).forEach((key) => { if (next[key] === DELETE) delete next[key]; });
      return next;
    }));
    renderProfile();
  }

  // The logo's size patch from a new width/height and the box's top-left, in
  // overlay pixels. Shared by the handles and the numeric fields.
  function logoSizePatch(nextW, nextH, left, top, bypass) {
    const clampedLeft = clamp(left, 0, W() - nextW);
    const clampedTop = clamp(top, 0, H() - nextH);
    const newSize = Math.round(Math.min(nextW, nextH));
    return {
      size: newSize,
      x: round1(snapPercent(clampedLeft / W() * 100, Math.max(0, 100 - nextW / W() * 100), bypass)),
      y: round1(snapPercent(clampedTop / H() * 100, Math.max(0, 100 - nextH / H() * 100), bypass)),
      width: Math.round(nextW) !== newSize ? Math.round(nextW) : DELETE,
      height: Math.round(nextH) !== newSize ? Math.round(nextH) : DELETE,
    };
  }

  function keepOnScreen() {
    const profile = activeProfile();
    const fix = profile && overflowFix(profile);
    if (fix) updateProfile(fix);
  }

  // ---------- Smart snapping ----------

  // While moving, the box snaps its left/centre/right and top/middle/bottom to
  // the screen's edges and centre, the TV safe margins, and the other elements
  // on screen. Returns the adjusted position and the lines it snapped to.
  function smartSnap(left, top, width, height) {
    const bounds = overlay.getBoundingClientRect();
    const reach = 7 * (W() / (bounds.width || 1));
    const xs = [0, W() / 2, W(), W() * 0.035, W() * 0.965, W() * 0.05, W() * 0.95];
    const ys = [0, H() / 2, H(), H() * 0.035, H() * 0.965, H() * 0.05, H() * 0.95];
    otherBoxes.forEach((box) => {
      xs.push(box.left, box.left + box.width, box.left + box.width / 2);
      ys.push(box.top, box.top + box.height, box.top + box.height / 2);
    });
    const best = (edges, lines) => {
      let found = null;
      edges.forEach((edge) => lines.forEach((line) => {
        const delta = line - edge;
        if (Math.abs(delta) <= reach && (!found || Math.abs(delta) < Math.abs(found.delta))) found = { delta, line };
      }));
      return found;
    };
    return {
      x: best([left, left + width / 2, left + width], xs),
      y: best([top, top + height / 2, top + height], ys),
    };
  }

  function showGuides(snapped) {
    guideV.classList.toggle('hidden', !(snapped && snapped.x));
    guideH.classList.toggle('hidden', !(snapped && snapped.y));
    if (snapped && snapped.x) guideV.style.left = `${snapped.x.line}px`;
    if (snapped && snapped.y) guideH.style.top = `${snapped.y.line}px`;
  }

  // ---------- Pointer ----------

  function trackDrag(event, onMove) {
    if (event.button !== 0 || comparing) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    dragging = true;
    const move = (nextEvent) => { if (nextEvent.pointerId === pointerId) { onMove(nextEvent); renderGaps(true); } };
    const finish = (nextEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      dragging = false;
      showGuides(null);
      renderGaps(false);
      renderProfile();
      updateDock();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  selection.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.logobug-live-anchor')) return;
    selection.focus({ preventScroll: true });
    checkpoint(`drag${Date.now()}`);
    const rect = overlay.getBoundingClientRect();
    const selectionRect = selection.getBoundingClientRect();
    const offsetX = event.clientX - selectionRect.left;
    const offsetY = event.clientY - selectionRect.top;
    trackDrag(event, (nextEvent) => {
      const width = selection.offsetWidth;
      const height = selection.offsetHeight;
      const maxX = Math.max(0, 100 - width / W() * 100);
      const maxY = Math.max(0, 100 - height / H() * 100);
      const rawX = ((nextEvent.clientX - offsetX - rect.left) / rect.width) * 100;
      const rawY = ((nextEvent.clientY - offsetY - rect.top) / rect.height) * 100;
      let x = snapPercent(rawX, maxX, nextEvent.altKey);
      let y = snapPercent(rawY, maxY, nextEvent.altKey);
      let snapped = null;
      if (!nextEvent.altKey) {
        // The pointer's own position, not the grid's, decides what it is near.
        snapped = smartSnap(clamp(rawX, 0, maxX) / 100 * W(), clamp(rawY, 0, maxY) / 100 * H(), width, height);
        if (snapped.x) x = clamp((clamp(rawX, 0, maxX) / 100 * W() + snapped.x.delta) / W() * 100, 0, maxX);
        if (snapped.y) y = clamp((clamp(rawY, 0, maxY) / 100 * H() + snapped.y.delta) / H() * 100, 0, maxY);
      }
      showGuides(snapped);
      updateProfile({ x: round1(x), y: round1(y) });
    });
  });

  handles.forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      const profile = activeProfile();
      if (!profile) return;
      checkpoint(`resize${Date.now()}`);
      const edge = handle.dataset.edge;
      const overlayRect = overlay.getBoundingClientRect();
      const scaleX = W() / overlayRect.width;
      const scaleY = H() / overlayRect.height;
      const startPointer = { x: event.clientX, y: event.clientY };
      const startLeft = profile.x / 100 * W();
      const startTop = profile.y / 100 * H();
      const affectsW = edge.includes('e') || edge.includes('w');
      const affectsH = edge.includes('n') || edge.includes('s');
      const deltas = (nextEvent) => ({ dx: (nextEvent.clientX - startPointer.x) * scaleX, dy: (nextEvent.clientY - startPointer.y) * scaleY });
      const edgeSize = (start, d, plus, minus) => start + (edge.includes(plus) ? d : edge.includes(minus) ? -d : 0);

      if (activeTarget === 'logo-bug') {
        // Width and height are independent: E/W handles change width, N/S
        // height, corners both (Shift on a corner locks the proportions).
        const { width: startW, height: startH } = logoDims(profile);
        const clampW = (v, bypass) => Math.min(400, W(), Math.max(14, snapLogoSize(v, bypass)));
        const clampH = (v, bypass) => Math.min(400, H(), Math.max(14, snapLogoSize(v, bypass)));
        trackDrag(event, (nextEvent) => {
          const { dx, dy } = deltas(nextEvent);
          let rawW = edgeSize(startW, dx, 'e', 'w');
          let rawH = edgeSize(startH, dy, 's', 'n');
          if (nextEvent.shiftKey && affectsW && affectsH) {
            const ratio = Math.max(Math.abs(rawW / startW), Math.abs(rawH / startH));
            rawW = startW * ratio;
            rawH = startH * ratio;
          }
          const nextW = affectsW ? clampW(rawW, nextEvent.altKey) : startW;
          const nextH = affectsH ? clampH(rawH, nextEvent.altKey) : startH;
          const left = edge.includes('w') ? startLeft + startW - nextW : startLeft;
          const top = edge.includes('n') ? startTop + startH - nextH : startTop;
          updateProfile(logoSizePatch(nextW, nextH, left, top, nextEvent.altKey));
        });
      } else if (isBarTarget()) {
        const startW = (profile.width != null ? profile.width : 100) / 100 * W();
        const startH = (profile.height != null ? profile.height : 12) / 100 * H();
        const clampW = (v, bypass) => Math.min(W(), Math.max(20, snapLogoSize(v, bypass)));
        const clampH = (v, bypass) => Math.min(H(), Math.max(10, snapLogoSize(v, bypass)));
        trackDrag(event, (nextEvent) => {
          const { dx, dy } = deltas(nextEvent);
          const nextW = affectsW ? clampW(edgeSize(startW, dx, 'e', 'w'), nextEvent.altKey) : startW;
          const nextH = affectsH ? clampH(edgeSize(startH, dy, 's', 'n'), nextEvent.altKey) : startH;
          const left = clamp(edge.includes('w') ? startLeft + startW - nextW : startLeft, 0, W() - nextW);
          const top = clamp(edge.includes('n') ? startTop + startH - nextH : startTop, 0, H() - nextH);
          updateProfile({
            width: Math.round(nextW / W() * 1000) / 10,
            height: Math.round(nextH / H() * 1000) / 10,
            x: round1(snapPercent(left / W() * 100, Math.max(0, 100 - nextW / W() * 100), nextEvent.altKey)),
            y: round1(snapPercent(top / H() * 100, Math.max(0, 100 - nextH / H() * 100), nextEvent.altKey)),
          });
        });
      } else {
        const startSize = targetElement().offsetWidth * (profile.scale || 1);
        const startHeight = targetElement().offsetHeight * (profile.scale || 1);
        trackDrag(event, (nextEvent) => {
          const { dx, dy } = deltas(nextEvent);
          const parts = [];
          if (edge.includes('e')) parts.push(dx / startSize);
          if (edge.includes('w')) parts.push(-dx / startSize);
          if (edge.includes('s')) parts.push(dy / startHeight);
          if (edge.includes('n')) parts.push(-dy / startHeight);
          const ratio = 1 + parts.reduce((sum, value) => sum + value, 0) / parts.length;
          const size = clamp(snapScale((profile.scale || 1) * ratio, nextEvent.altKey), 0.5, 3);
          const nextWidth = targetElement().offsetWidth * size;
          const nextHeight = targetElement().offsetHeight * size;
          const left = clamp(edge.includes('w') ? startLeft + startSize - nextWidth : startLeft, 0, W() - nextWidth);
          const top = clamp(edge.includes('n') ? startTop + startHeight - nextHeight : startTop, 0, H() - nextHeight);
          updateProfile({
            scale: Math.round(size * 100) / 100,
            x: round1(snapPercent(left / W() * 100, Math.max(0, 100 - nextWidth / W() * 100), nextEvent.altKey)),
            y: round1(snapPercent(top / H() * 100, Math.max(0, 100 - nextHeight / H() * 100), nextEvent.altKey)),
          });
        });
      }
    });
  });

  // ---------- Keyboard + numeric entry ----------

  function maxPosition() {
    return {
      x: Math.max(0, 100 - selection.offsetWidth / W() * 100),
      y: Math.max(0, 100 - selection.offsetHeight / H() * 100),
    };
  }

  // Moves to one of the nine spots with the usual gap from the edge.
  function placeAt(column, row) {
    const profile = activeProfile();
    if (!profile || comparing) return;
    checkpoint(`spot${Date.now()}`);
    const gap = Math.round(28 * H() / 1080);
    const width = selection.offsetWidth;
    const height = selection.offsetHeight;
    const left = column === 0 ? gap : column === 1 ? (W() - width) / 2 : W() - width - gap;
    const top = row === 0 ? gap : row === 1 ? (H() - height) / 2 : H() - height - gap;
    const max = maxPosition();
    updateProfile({ x: round1(clamp(left / W() * 100, 0, max.x)), y: round1(clamp(top / H() * 100, 0, max.y)) });
    flashGaps();
    updateDock();
  }

  function resizeBy(direction, big) {
    const profile = activeProfile();
    if (!profile) return;
    checkpoint('resize-key');
    if (activeTarget === 'logo-bug') {
      const { width, height } = logoDims(profile);
      const step = (big ? 10 : 2) * direction;
      const nextW = clamp(Math.round(width + step), 14, Math.min(400, W()));
      const nextH = clamp(Math.round(height * nextW / width), 14, Math.min(400, H()));
      updateProfile(logoSizePatch(nextW, nextH, profile.x / 100 * W(), profile.y / 100 * H(), true));
    } else if (isBarTarget()) {
      updateProfile({ height: round1(clamp((profile.height != null ? profile.height : 12) + (big ? 2 : 0.5) * direction, 1, 100)) });
    } else {
      updateProfile({ scale: Math.round(clamp((profile.scale || 1) + (big ? 0.1 : 0.05) * direction, 0.5, 3) * 100) / 100 });
    }
    keepOnScreen();
    updateDock();
  }

  selection.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 5 : nudgeStep();
    const max = maxPosition();
    const profile = activeProfile();
    if (!profile) return;
    let { x, y } = profile;
    if (event.key === 'ArrowLeft') x -= step;
    else if (event.key === 'ArrowRight') x += step;
    else if (event.key === 'ArrowUp') y -= step;
    else if (event.key === 'ArrowDown') y += step;
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); resizeBy(1, event.shiftKey); return; }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); resizeBy(-1, event.shiftKey); return; }
    else return;
    event.preventDefault();
    checkpoint('nudge');
    updateProfile({ x: round1(clamp(x, 0, max.x)), y: round1(clamp(y, 0, max.y)) });
    flashGaps();
    updateDock();
  });

  inputs.x.addEventListener('input', () => {
    if (inputs.x.value === '') return;
    checkpoint('type-x');
    updateProfile({ x: round1(clamp(Number(inputs.x.value) || 0, 0, maxPosition().x)) });
  });
  inputs.y.addEventListener('input', () => {
    if (inputs.y.value === '') return;
    checkpoint('type-y');
    updateProfile({ y: round1(clamp(Number(inputs.y.value) || 0, 0, maxPosition().y)) });
  });
  [inputs.x, inputs.y, inputs.a, inputs.b].forEach((input) => input.addEventListener('change', () => { renderProfile(); updateDock(); }));

  function sizeFromInput(which) {
    const profile = activeProfile();
    const raw = Number(which === 'a' ? inputs.a.value : inputs.b.value);
    if (!profile || !Number.isFinite(raw) || (which === 'a' ? inputs.a.value : inputs.b.value) === '') return;
    checkpoint(`type-size-${which}`);
    if (activeTarget === 'logo-bug') {
      const { width, height } = logoDims(profile);
      const maxW = Math.min(400, W());
      const maxH = Math.min(400, H());
      let nextW = width;
      let nextH = height;
      if (which === 'a') {
        nextW = clamp(Math.round(raw), 14, maxW);
        if (lockInput.checked) nextH = clamp(Math.round(nextW * height / width), 14, maxH);
      } else {
        nextH = clamp(Math.round(raw), 14, maxH);
        if (lockInput.checked) nextW = clamp(Math.round(nextH * width / height), 14, maxW);
      }
      updateProfile(logoSizePatch(nextW, nextH, profile.x / 100 * W(), profile.y / 100 * H(), true));
    } else if (isBarTarget()) {
      updateProfile(which === 'a' ? { width: round1(clamp(raw, 2, 100)) } : { height: round1(clamp(raw, 1, 100)) });
    } else {
      updateProfile({ scale: Math.round(clamp(raw / 100, 0.5, 3) * 100) / 100 });
    }
    keepOnScreen();
  }
  inputs.a.addEventListener('input', () => sizeFromInput('a'));
  inputs.b.addEventListener('input', () => sizeFromInput('b'));

  // ---------- Controls ----------

  function chooseTarget(id) {
    if (!targetLabels.has(id)) return;
    activeTarget = id;
    targetSelect.value = id;
    activeId = null;
    syncAutoState();
    selectProfileForContext();
  }

  autoAdjust.addEventListener('change', () => {
    checkpoint('auto');
    dirty = true;
    S.config.display.logoBugAutoAdjust = autoAdjust.checked;
    syncAutoState();
    selectProfileForContext();
  });
  snapSelect.addEventListener('change', syncGuides);
  stepSelect.addEventListener('change', syncGuides);
  guidesSelect.addEventListener('change', syncGuides);
  pictureSelect.addEventListener('change', () => { saveUi({ preview: pictureSelect.value }); renderProfile(); });
  othersInput.addEventListener('change', () => { saveUi({ others: othersInput.checked }); selectProfileForContext(); });
  opacitySlider.addEventListener('input', () => { checkpoint('opacity'); updateProfile({ opacity: Number(opacitySlider.value) }); });
  targetSelect.addEventListener('change', () => chooseTarget(targetSelect.value));
  dockButton.addEventListener('click', () => {
    dockPinned = true;
    toolbar.dataset.dock = toolbar.dataset.dock === 'top' ? 'bottom' : 'top';
    saveUi({ dock: toolbar.dataset.dock });
  });
  hideButton.addEventListener('click', () => {
    const hidden = toolbar.classList.toggle('is-collapsed');
    hideButton.textContent = hidden ? 'SHOW CONTROLS' : 'HIDE';
    hideButton.setAttribute('aria-pressed', String(hidden));
  });
  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  resetButton.addEventListener('click', () => {
    checkpoint(`reset${Date.now()}`);
    const original = (originalByTarget.get(activeTarget) || []).find((profile) => profile.id === activeId);
    const profiles = targetProfiles();
    // A placement created in this session has nothing to go back to: drop it
    // and let the context seed a fresh one from the nearest existing profile.
    setTargetProfiles(original ? profiles.map((profile) => (profile.id === activeId ? { ...original } : profile)) : profiles.filter((profile) => profile.id !== activeId));
    activeId = null;
    selectProfileForContext();
    selection.focus({ preventScroll: true });
  });
  // Copies the placement to every picture shape and resolution, replacing what
  // each had: position, size and opacity, nothing that identifies the shape.
  allShapesButton.addEventListener('click', () => {
    const source = activeProfile();
    if (!source || comparing) return;
    checkpoint(`all${Date.now()}`);
    const carried = ['x', 'y', 'scale', 'width', 'height', 'size', 'refH', 'opacity'].filter((key) => source[key] !== undefined);
    const copy = () => Object.fromEntries(carried.map((key) => [key, source[key]]));
    const profiles = targetProfiles();
    const next = profiles.map((profile) => (profile.id === source.id || !(profile.aspect && profile.resolution)
      ? profile : { id: profile.id, aspect: profile.aspect, resolution: profile.resolution, ...copy() }));
    ALL_SHAPES.forEach(([aspect, resolution]) => {
      if (!next.some((profile) => profile.aspect === aspect && profile.resolution === resolution)) {
        next.push({ id: newProfileId(), aspect, resolution, ...copy() });
      }
    });
    dirty = true;
    const seeded = seededByTarget.get(activeTarget);
    if (seeded) next.forEach((profile) => seeded.delete(profile.id));
    setTargetProfiles(next);
    renderProfile();
    allShapesButton.textContent = 'COPIED TO ALL SHAPES';
    setTimeout(() => { allShapesButton.textContent = 'SAME FOR ALL SHAPES'; }, 1600);
  });
  compareButton.addEventListener('pointerdown', (event) => { event.preventDefault(); setComparing(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((name) => compareButton.addEventListener(name, () => setComparing(false)));

  // Keys that work wherever focus is (but not while typing in a field).
  function typingTarget(event) {
    const tagName = event.target && event.target.tagName;
    return tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA';
  }
  function onKeyUp(event) { if (event.key === 'b' || event.key === 'B') setComparing(false); }

  // ---------- Close ----------

  // Placements the editor invented and nobody touched are not worth saving.
  function pruneSeeded() {
    const was = activeTarget;
    seededByTarget.forEach((ids, target) => {
      if (!ids.size) return;
      activeTarget = target;
      const kept = targetProfiles().filter((profile) => !ids.has(profile.id));
      if (kept.length || target !== 'logo-bug') setTargetProfiles(kept);
    });
    activeTarget = was;
  }

  let closing = false;
  async function closeEditor(keepChanges) {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    clearTimeout(gapTimer);
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
      if (comparing) setComparing(false);
      pruneSeeded();
      S.config.display.logoBugAutoAdjust = autoAdjust.checked;
      // Everything the editor moved, as one undo step. It worked on the live
      // objects, so they are recorded in place (commitInPlace).
      commitInPlace([
        { type: 'settings.set', path: ['display', 'logoBugAutoAdjust'], value: S.config.display.logoBugAutoAdjust },
        { type: 'settings.set', path: ['display', 'overlaySnapIncrement'], value: S.config.display.overlaySnapIncrement },
        { type: 'settings.set', path: ['display', 'overlayLayouts'], value: S.config.display.overlayLayouts },
        { type: 'settings.set', path: ['displayMode'], value: S.config.displayMode },
      ], { label: 'Adjust on-screen layout' });
    }
    if (logoWasHidden) logo.classList.add('hidden');
    previewElements.forEach((_, id) => restorePreviewElement(id));
    displayMode.applyOverlayLayouts();
    if (onLiveChange) onLiveChange();
    await showSetupScreen();
  }

  function askToDiscard() {
    if (!dirty) { closeEditor(false); return; }
    confirmBox.classList.remove('hidden');
    confirmKeep.focus();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!confirmBox.classList.contains('hidden')) { confirmBox.classList.add('hidden'); selection.focus({ preventScroll: true }); return; }
      askToDiscard();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !typingTarget(event)) {
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); return; }
      if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); return; }
    }
    if (typingTarget(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'b' || event.key === 'B') { if (!event.repeat) setComparing(true); event.preventDefault(); return; }
    if (event.key === '[' || event.key === ']') {
      const ids = [...targetLabels.keys()];
      const next = ids[(ids.indexOf(activeTarget) + (event.key === ']' ? 1 : ids.length - 1)) % ids.length];
      event.preventDefault();
      chooseTarget(next);
    }
  }
  // Capture phase: these must reach this before the app's own key handling.
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  cancel.addEventListener('click', () => closeEditor(false));
  confirmKeep.addEventListener('click', () => { confirmBox.classList.add('hidden'); selection.focus({ preventScroll: true }); });
  confirmDiscard.addEventListener('click', () => closeEditor(false));
  apply.addEventListener('click', () => closeEditor(true));

  crt.appendChild(overlay);
  app.appendChild(toolbar);
  syncAutoState();
  syncHistoryButtons();
  syncGuides();
  selectProfileForContext();
  selection.focus({ preventScroll: true });
}
