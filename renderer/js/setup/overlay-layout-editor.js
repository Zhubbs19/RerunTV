// The live on-screen layout editor (the O key, and the LIVE EDITOR buttons in
// DISPLAY and in a channel's OVERLAYS): drag, resize and fine-tune the channel
// logo and every other card or bar, against the channel that is actually
// playing. Split out of setup/util.js; the stored data is unchanged
// (display.logoBugProfiles / ch.logoBugProfiles / display.overlayLayouts /
// ch.tickerLayout, one profile per picture shape + resolution).
//
// What the screen shows while it is open:
//   * the stage (.logobug-live-overlay) over the running picture, with a grid,
//     optional TV safe-area frames, and the selected element's box + handles;
//   * a control panel that docks to whichever edge the selection is NOT near,
//     so the thing being placed is never hidden behind its own controls.
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
  const previewElements = new Map(['logo-bug', ...displayMode.OVERLAY_LAYOUT_TARGETS.map(({ id }) => id)].map((id) => {
    const element = document.getElementById(id);
    return [id, element && { className: element.className, style: element.getAttribute('style') }];
  }));

  // ---------- Stage ----------

  const overlay = el('div', { className: 'logobug-live-overlay', attrs: { role: 'application', 'aria-label': 'On-screen layout editor' } });
  overlay.dataset.guides = 'grid';
  const safeAction = el('div', { className: 'logobug-live-safe logobug-live-safe-action' }, el('span', { text: 'ACTION SAFE' }));
  const safeTitle = el('div', { className: 'logobug-live-safe logobug-live-safe-title' }, el('span', { text: 'TITLE SAFE' }));
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
  overlay.append(safeAction, safeTitle, selection);

  // ---------- Panel ----------

  const status = el('div', { className: 'logobug-live-status', attrs: { 'aria-live': 'polite' } });
  const context = el('div', { className: 'logobug-live-context' });
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

  const targetSelect = select([['logo-bug', 'CHANNEL LOGO'], ...displayMode.OVERLAY_LAYOUT_TARGETS.map(({ id, label }) => [id, label])]);
  if (perChannelOverlay) targetSelect.value = perChannelOverlay.targetId;
  const targetField = field('EDITING', targetSelect, 'logobug-live-target');
  const head = el('div', { className: 'logobug-live-head' },
    el('div', { className: 'logobug-live-title', text: 'LIVE OVERLAY LAYOUT' }), context, status, targetField,
    el('div', { className: 'logobug-live-head-buttons' }, dockButton, hideButton));

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
  const lockLabel = el('label', { className: 'logobug-live-auto', title: 'Changing the width also changes the height to match' }, lockInput, document.createTextNode(' KEEP PROPORTIONS'));
  const opacitySlider = el('input', { type: 'range', min: '10', max: '100' });
  const opacityValue = el('output', { className: 'logobug-live-value' });
  const opacityField = el('label', { className: 'logobug-live-field logobug-live-opacity' },
    el('span', { className: 'logobug-live-label', text: 'OPACITY' }),
    el('span', { className: 'logobug-live-slider' }, opacitySlider, opacityValue));
  const resetButton = el('button', { type: 'button', className: 'btn logobug-live-small logobug-live-reset', text: 'UNDO CHANGES HERE', title: 'Put this placement back to how it was when you opened the editor' });

  const snapSelect = select([[0, 'OFF'], [1, '1%'], [2.5, '2.5%'], [5, '5%'], [10, '10%']]);
  snapSelect.value = String(snapIncrementSnapshot);
  const guidesSelect = select([['grid', 'GRID'], ['safe', 'TV SAFE AREAS'], ['both', 'GRID + SAFE AREAS'], ['off', 'OFF']]);

  const actions = el('div', { className: 'logobug-live-actions' });
  const cancel = el('button', { type: 'button', className: 'btn', text: 'CANCEL' });
  const apply = el('button', { type: 'button', className: 'btn btn-primary', text: 'APPLY PLACEMENT' });
  actions.append(cancel, apply);

  const confirmKeep = el('button', { type: 'button', className: 'btn', text: 'KEEP EDITING' });
  const confirmDiscard = el('button', { type: 'button', className: 'btn btn-danger', text: 'DISCARD CHANGES' });
  const confirmBox = el('div', { className: 'logobug-live-confirm hidden', attrs: { role: 'alertdialog', 'aria-label': 'Discard changes?' } },
    el('span', { text: 'Leave without saving? Your moves in this editor will be lost.' }), confirmKeep, confirmDiscard);

  const body = el('div', { className: 'logobug-live-body' },
    group('PICTURE IT IS SAVED FOR',
      null, field('ASPECT', aspectSelect), field('WINDOW', windowSelect), field('RESOLUTION', resolutionSelect), autoLabel),
    group('AIDS', null, field('SNAP GRID', snapSelect, 'logobug-live-snap'), field('GUIDES', guidesSelect)),
    actions,
    group('POSITION & SIZE', null,
      field('X %', inputs.x, 'logobug-live-coordinate'), field('Y %', inputs.y, 'logobug-live-coordinate'),
      fieldA, fieldB, lockLabel, opacityField, resetButton));
  body.lastElementChild.classList.add('logobug-live-group-wide');
  const hint = el('p', { className: 'logobug-live-hint',
    text: 'Drag to move · drag a handle to resize (Shift keeps proportions) · hold Alt to ignore the grid · arrow keys nudge, Shift for bigger steps · + / − resize · Esc cancels' });
  const toolbar = el('div', { className: 'logobug-live-toolbar' }, head, body, hint, confirmBox);
  toolbar.dataset.dock = 'bottom';
  body.children[0].appendChild(previewHelp);

  const logoWasHidden = logo.classList.contains('hidden');
  logo.classList.remove('hidden');
  let activeId = null;
  let activeTarget = perChannelOverlay ? perChannelOverlay.targetId : 'logo-bug';
  let dragging = false;
  let dockPinned = false;
  let dirty = false;
  const originalByTarget = new Map();

  // ---------- Snap + context ----------

  const snapIncrement = () => Number(snapSelect.value) || 0;

  function snapPercent(value, max, bypass = false) {
    const increment = bypass ? 0 : snapIncrement();
    const snapped = increment ? Math.round(value / increment) * increment : value;
    return clamp(snapped, 0, max);
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

  function syncGuides() {
    const increment = snapIncrement();
    const mode = guidesSelect.value;
    overlay.classList.toggle('snap-enabled', increment > 0);
    overlay.dataset.guides = mode;
    overlay.style.setProperty('--overlay-grid-step', increment ? `${increment}%` : '5%');
    S.config.display.overlaySnapIncrement = increment;
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
    previewHelp.textContent = pinned
      ? 'The logo uses one placement for all content (DISPLAY › Logo bug), so these are off.'
      : autoAdjust.checked
        ? 'Following what is playing, so these three are off.'
        : 'Saved separately for each picture shape and resolution.';
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
  }

  function showTargetForEditing() {
    previewElements.forEach((_, id) => restorePreviewElement(id));
    // Only the element being placed (and the logo, as a reference) stay on
    // screen: a channel banner or card sitting on the spot would hide it.
    previewElements.forEach((_, id) => {
      if (id === activeTarget || id === 'logo-bug') return;
      const other = document.getElementById(id);
      if (!other) return;
      other.classList.remove('show');
      other.style.visibility = 'hidden';
    });
    const element = targetElement();
    if (!element) return;
    element.classList.remove('hidden');
    element.classList.add('show');
    // The logo bug's opacity is previewed live by renderProfile; the other
    // elements are normally hidden or fleeting, so they are shown solid.
    if (activeTarget !== 'logo-bug') element.style.opacity = '1';
  }

  // Bounds-check a profile's x/y against the CURRENT overlay size (whichever
  // shape/resolution frame is active). Null when it is already fully on screen.
  function overflowFix(profile) {
    const element = targetElement();
    const dims = activeTarget === 'logo-bug' ? logoDims(profile)
      : isBarTarget() ? { width: (profile.width || 0) / 100 * overlay.clientWidth, height: (profile.height || 0) / 100 * overlay.clientHeight }
        : { width: element.offsetWidth * (profile.scale || 1), height: element.offsetHeight * (profile.scale || 1) };
    const maxX = Math.max(0, 100 - dims.width / overlay.clientWidth * 100);
    const maxY = Math.max(0, 100 - dims.height / overlay.clientHeight * 100);
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
      const overlayRect = overlay.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const fromElement = () => ({
        x: Math.max(0, (elementRect.left - overlayRect.left) / overlayRect.width * 100),
        y: Math.max(0, (elementRect.top - overlayRect.top) / overlayRect.height * 100),
      });
      const base = activeTarget === 'logo-bug'
        ? channels.pickLogoBugProfile(profiles, context) || channels.foldLogoBugCorner(null, null)[0]
        : profiles.find((profile) => (!profile.aspect || profile.aspect === context.aspect)
          && (!profile.resolution || profile.resolution === context.resolution)) || (isBarTarget()
          ? { ...fromElement(), width: elementRect.width / overlayRect.width * 100, height: elementRect.height / overlayRect.height * 100 }
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
      Object.assign(inputs.a, { min: '14', max: String(Math.min(400, overlay.clientWidth)), step: '1' });
      Object.assign(inputs.b, { min: '14', max: String(Math.min(400, overlay.clientHeight)), step: '1' });
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
    context.textContent = logoIsPinned() ? `SAVING FOR ${shape} · ALL CONTENT`
      : autoAdjust.checked ? `SAVING FOR ${shape} · NOW PLAYING` : `SAVING FOR ${shape}`;
    const snap = snapIncrement();
    status.textContent = `X ${profile.x.toFixed(1)}% Y ${profile.y.toFixed(1)}% · ${sizeSummary(profile)} · SNAP ${snap ? `${snap}%` : 'OFF'}`;
    setInput(inputs.x, profile.x.toFixed(1));
    setInput(inputs.y, profile.y.toFixed(1));
    configureSizeFields(profile);
    // Handles sit inside the box when it touches the screen edge, where
    // handles centred on the border would be cut off.
    const near = 10;
    selection.classList.toggle('at-left', selection.offsetLeft < near);
    selection.classList.toggle('at-top', selection.offsetTop < near);
    selection.classList.toggle('at-right', overlay.clientWidth - (selection.offsetLeft + selection.offsetWidth) < near);
    selection.classList.toggle('at-bottom', overlay.clientHeight - (selection.offsetTop + selection.offsetHeight) < near);
  }

  // The panel goes to the edge the selection is not near, unless the person
  // moved it themselves. Not while dragging: a panel that jumps mid-drag is
  // worse than one in the way.
  function updateDock() {
    if (dockPinned || dragging) return;
    const middle = selection.offsetTop + selection.offsetHeight / 2;
    toolbar.dataset.dock = middle > overlay.clientHeight / 2 ? 'top' : 'bottom';
  }

  const DELETE = Symbol('DELETE');
  function updateProfile(patch) {
    dirty = true;
    setTargetProfiles(targetProfiles().map((profile) => {
      if (profile.id !== activeId) return profile;
      const next = { ...profile, ...patch };
      // A logo bug size is in screen pixels; remember which screen it was set on.
      if (activeTarget === 'logo-bug' && patch.size != null) next.refH = Math.round(overlay.clientHeight);
      // Keys set to DELETE are removed (width/height when resized back to a square).
      Object.keys(next).forEach((key) => { if (next[key] === DELETE) delete next[key]; });
      return next;
    }));
    renderProfile();
  }

  // The logo's size patch from a new width/height and the box's top-left, in
  // overlay pixels. Shared by the handles and the numeric fields.
  function logoSizePatch(nextW, nextH, left, top, bypass) {
    const clampedLeft = clamp(left, 0, overlay.clientWidth - nextW);
    const clampedTop = clamp(top, 0, overlay.clientHeight - nextH);
    const newSize = Math.round(Math.min(nextW, nextH));
    return {
      size: newSize,
      x: round1(snapPercent(clampedLeft / overlay.clientWidth * 100, Math.max(0, 100 - nextW / overlay.clientWidth * 100), bypass)),
      y: round1(snapPercent(clampedTop / overlay.clientHeight * 100, Math.max(0, 100 - nextH / overlay.clientHeight * 100), bypass)),
      width: Math.round(nextW) !== newSize ? Math.round(nextW) : DELETE,
      height: Math.round(nextH) !== newSize ? Math.round(nextH) : DELETE,
    };
  }

  function keepOnScreen() {
    const profile = activeProfile();
    const fix = profile && overflowFix(profile);
    if (fix) updateProfile(fix);
  }

  // ---------- Pointer ----------

  function trackDrag(event, onMove) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    dragging = true;
    const move = (nextEvent) => { if (nextEvent.pointerId === pointerId) onMove(nextEvent); };
    const finish = (nextEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      dragging = false;
      updateDock();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }

  selection.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.logobug-live-anchor')) return;
    selection.focus({ preventScroll: true });
    const rect = overlay.getBoundingClientRect();
    const selectionRect = selection.getBoundingClientRect();
    const offsetX = event.clientX - selectionRect.left;
    const offsetY = event.clientY - selectionRect.top;
    trackDrag(event, (nextEvent) => {
      const maxX = Math.max(0, 100 - selection.offsetWidth / overlay.clientWidth * 100);
      const maxY = Math.max(0, 100 - selection.offsetHeight / overlay.clientHeight * 100);
      const rawX = ((nextEvent.clientX - offsetX - rect.left) / rect.width) * 100;
      const rawY = ((nextEvent.clientY - offsetY - rect.top) / rect.height) * 100;
      updateProfile({ x: round1(snapPercent(rawX, maxX, nextEvent.altKey)), y: round1(snapPercent(rawY, maxY, nextEvent.altKey)) });
    });
  });

  handles.forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      const profile = activeProfile();
      if (!profile) return;
      const edge = handle.dataset.edge;
      const overlayRect = overlay.getBoundingClientRect();
      const scaleX = overlay.clientWidth / overlayRect.width;
      const scaleY = overlay.clientHeight / overlayRect.height;
      const startPointer = { x: event.clientX, y: event.clientY };
      const startLeft = profile.x / 100 * overlay.clientWidth;
      const startTop = profile.y / 100 * overlay.clientHeight;
      const affectsW = edge.includes('e') || edge.includes('w');
      const affectsH = edge.includes('n') || edge.includes('s');
      const deltas = (nextEvent) => ({ dx: (nextEvent.clientX - startPointer.x) * scaleX, dy: (nextEvent.clientY - startPointer.y) * scaleY });
      const edgeSize = (start, d, plus, minus) => start + (edge.includes(plus) ? d : edge.includes(minus) ? -d : 0);

      if (activeTarget === 'logo-bug') {
        // Width and height are independent: E/W handles change width, N/S
        // height, corners both (Shift on a corner locks the proportions).
        const { width: startW, height: startH } = logoDims(profile);
        const clampW = (v, bypass) => Math.min(400, overlay.clientWidth, Math.max(14, snapLogoSize(v, bypass)));
        const clampH = (v, bypass) => Math.min(400, overlay.clientHeight, Math.max(14, snapLogoSize(v, bypass)));
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
        const startW = (profile.width != null ? profile.width : 100) / 100 * overlay.clientWidth;
        const startH = (profile.height != null ? profile.height : 12) / 100 * overlay.clientHeight;
        const clampW = (v, bypass) => Math.min(overlay.clientWidth, Math.max(20, snapLogoSize(v, bypass)));
        const clampH = (v, bypass) => Math.min(overlay.clientHeight, Math.max(10, snapLogoSize(v, bypass)));
        trackDrag(event, (nextEvent) => {
          const { dx, dy } = deltas(nextEvent);
          const nextW = affectsW ? clampW(edgeSize(startW, dx, 'e', 'w'), nextEvent.altKey) : startW;
          const nextH = affectsH ? clampH(edgeSize(startH, dy, 's', 'n'), nextEvent.altKey) : startH;
          const left = clamp(edge.includes('w') ? startLeft + startW - nextW : startLeft, 0, overlay.clientWidth - nextW);
          const top = clamp(edge.includes('n') ? startTop + startH - nextH : startTop, 0, overlay.clientHeight - nextH);
          updateProfile({
            width: Math.round(nextW / overlay.clientWidth * 1000) / 10,
            height: Math.round(nextH / overlay.clientHeight * 1000) / 10,
            x: round1(snapPercent(left / overlay.clientWidth * 100, Math.max(0, 100 - nextW / overlay.clientWidth * 100), nextEvent.altKey)),
            y: round1(snapPercent(top / overlay.clientHeight * 100, Math.max(0, 100 - nextH / overlay.clientHeight * 100), nextEvent.altKey)),
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
          const left = clamp(edge.includes('w') ? startLeft + startSize - nextWidth : startLeft, 0, overlay.clientWidth - nextWidth);
          const top = clamp(edge.includes('n') ? startTop + startHeight - nextHeight : startTop, 0, overlay.clientHeight - nextHeight);
          updateProfile({
            scale: Math.round(size * 100) / 100,
            x: round1(snapPercent(left / overlay.clientWidth * 100, Math.max(0, 100 - nextWidth / overlay.clientWidth * 100), nextEvent.altKey)),
            y: round1(snapPercent(top / overlay.clientHeight * 100, Math.max(0, 100 - nextHeight / overlay.clientHeight * 100), nextEvent.altKey)),
          });
        });
      }
    });
  });

  // ---------- Keyboard + numeric entry ----------

  function maxPosition() {
    return {
      x: Math.max(0, 100 - selection.offsetWidth / overlay.clientWidth * 100),
      y: Math.max(0, 100 - selection.offsetHeight / overlay.clientHeight * 100),
    };
  }

  function resizeBy(direction, big) {
    const profile = activeProfile();
    if (!profile) return;
    if (activeTarget === 'logo-bug') {
      const { width, height } = logoDims(profile);
      const step = (big ? 10 : 2) * direction;
      const nextW = clamp(Math.round(width + step), 14, Math.min(400, overlay.clientWidth));
      const nextH = clamp(Math.round(height * nextW / width), 14, Math.min(400, overlay.clientHeight));
      updateProfile(logoSizePatch(nextW, nextH, profile.x / 100 * overlay.clientWidth, profile.y / 100 * overlay.clientHeight, true));
    } else if (isBarTarget()) {
      updateProfile({ height: round1(clamp((profile.height != null ? profile.height : 12) + (big ? 2 : 0.5) * direction, 1, 100)) });
    } else {
      updateProfile({ scale: Math.round(clamp((profile.scale || 1) + (big ? 0.1 : 0.05) * direction, 0.5, 3) * 100) / 100 });
    }
    keepOnScreen();
    updateDock();
  }

  selection.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 5 : (snapIncrement() || 0.5);
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
    updateProfile({ x: round1(clamp(x, 0, max.x)), y: round1(clamp(y, 0, max.y)) });
    updateDock();
  });

  inputs.x.addEventListener('input', () => { if (inputs.x.value !== '') updateProfile({ x: round1(clamp(Number(inputs.x.value) || 0, 0, maxPosition().x)) }); });
  inputs.y.addEventListener('input', () => { if (inputs.y.value !== '') updateProfile({ y: round1(clamp(Number(inputs.y.value) || 0, 0, maxPosition().y)) }); });
  [inputs.x, inputs.y, inputs.a, inputs.b].forEach((input) => input.addEventListener('change', () => { renderProfile(); updateDock(); }));

  function sizeFromInput(which) {
    const profile = activeProfile();
    const raw = Number(which === 'a' ? inputs.a.value : inputs.b.value);
    if (!profile || !Number.isFinite(raw) || (which === 'a' ? inputs.a.value : inputs.b.value) === '') return;
    if (activeTarget === 'logo-bug') {
      const { width, height } = logoDims(profile);
      const maxW = Math.min(400, overlay.clientWidth);
      const maxH = Math.min(400, overlay.clientHeight);
      let nextW = width;
      let nextH = height;
      if (which === 'a') {
        nextW = clamp(Math.round(raw), 14, maxW);
        if (lockInput.checked) nextH = clamp(Math.round(nextW * height / width), 14, maxH);
      } else {
        nextH = clamp(Math.round(raw), 14, maxH);
        if (lockInput.checked) nextW = clamp(Math.round(nextH * width / height), 14, maxW);
      }
      updateProfile(logoSizePatch(nextW, nextH, profile.x / 100 * overlay.clientWidth, profile.y / 100 * overlay.clientHeight, true));
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

  autoAdjust.addEventListener('change', () => {
    dirty = true;
    S.config.display.logoBugAutoAdjust = autoAdjust.checked;
    syncAutoState();
    selectProfileForContext();
  });
  snapSelect.addEventListener('change', syncGuides);
  guidesSelect.addEventListener('change', syncGuides);
  opacitySlider.addEventListener('input', () => updateProfile({ opacity: Number(opacitySlider.value) }));
  targetSelect.addEventListener('change', () => {
    activeTarget = targetSelect.value;
    activeId = null;
    syncAutoState();
    selectProfileForContext();
  });
  dockButton.addEventListener('click', () => {
    dockPinned = true;
    toolbar.dataset.dock = toolbar.dataset.dock === 'top' ? 'bottom' : 'top';
  });
  hideButton.addEventListener('click', () => {
    const hidden = toolbar.classList.toggle('is-collapsed');
    hideButton.textContent = hidden ? 'SHOW CONTROLS' : 'HIDE';
    hideButton.setAttribute('aria-pressed', String(hidden));
  });
  resetButton.addEventListener('click', () => {
    const original = (originalByTarget.get(activeTarget) || []).find((profile) => profile.id === activeId);
    const profiles = targetProfiles();
    // A placement created in this session has nothing to go back to: drop it
    // and let the context seed a fresh one from the nearest existing profile.
    setTargetProfiles(original ? profiles.map((profile) => (profile.id === activeId ? { ...original } : profile)) : profiles.filter((profile) => profile.id !== activeId));
    activeId = null;
    selectProfileForContext();
    selection.focus({ preventScroll: true });
  });

  // ---------- Close ----------

  let closing = false;
  async function closeEditor(keepChanges) {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKeyDown, true);
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
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (!confirmBox.classList.contains('hidden')) { confirmBox.classList.add('hidden'); selection.focus({ preventScroll: true }); return; }
    askToDiscard();
  }
  // Capture phase: Esc must reach this before the app's own key handling.
  document.addEventListener('keydown', onKeyDown, true);
  cancel.addEventListener('click', () => closeEditor(false));
  confirmKeep.addEventListener('click', () => { confirmBox.classList.add('hidden'); selection.focus({ preventScroll: true }); });
  confirmDiscard.addEventListener('click', () => closeEditor(false));
  apply.addEventListener('click', () => closeEditor(true));

  crt.appendChild(overlay);
  app.appendChild(toolbar);
  syncAutoState();
  syncGuides();
  selectProfileForContext();
  selection.focus({ preventScroll: true });
}
