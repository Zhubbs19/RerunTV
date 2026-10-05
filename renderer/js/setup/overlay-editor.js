// Accessible live placement editor for one dynamic-overlay rule. Kept out
// of setup-util.js because it owns a complete temporary screen, focus
// lifecycle, pointer/keyboard interaction, and coordinate form.
import { isVideoMediaPath } from '../core/channels.js';
import { S } from '../core/state.js';
import { randomId } from '../core/util.js';

export async function openDynamicOverlayPositionEditor({ rule, onApply, channelNumber }) {
  const returnFocus = document.activeElement;
  const { showSetupScreen, showTvScreen } = await import('../app.js');
  await showTvScreen();
  if (channelNumber != null && S.currentNumber !== channelNumber && window.tuneToChannel) {
    await window.tuneToChannel(channelNumber, { silent: true });
  }

  const crt = document.querySelector('.crt');
  const app = document.getElementById('app');
  if (!crt || !app) { await showSetupScreen(); return; } // don't strand the user on the TV screen

  const overlay = document.createElement('div');
  overlay.className = 'logobug-live-overlay';
  overlay.setAttribute('role', 'application');
  overlay.setAttribute('aria-label', 'Custom overlay placement editor');

  const selection = document.createElement('div');
  selection.className = 'logobug-live-selection';
  selection.tabIndex = 0;
  selection.setAttribute('role', 'group');
  selection.setAttribute('aria-roledescription', 'movable overlay');
  selection.setAttribute('aria-label', 'Overlay position. Use arrow keys to move; hold Shift for larger steps.');
  selection.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight');
  overlay.appendChild(selection);

  if (rule.mediaPath) {
    const isVideo = isVideoMediaPath(rule.mediaPath);
    const media = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) { media.muted = true; media.loop = true; media.autoplay = true; media.playsInline = true; }
    window.api.toFileUrl(rule.mediaPath).then((url) => { media.src = url; if (isVideo) media.play().catch(() => {}); });
    Object.assign(media.style, { width: '100%', height: '100%', objectFit: 'contain', display: 'block' });
    selection.appendChild(media);
  }

  let x = Number.isFinite(rule.x) ? rule.x : 50;
  let y = Number.isFinite(rule.y) ? rule.y : 50;
  const size = rule.size || 160;
  const toolbar = document.createElement('div');
  toolbar.className = 'logobug-live-toolbar';
  const title = document.createElement('div');
  title.className = 'logobug-live-title';
  title.textContent = 'CUSTOM OVERLAY PLACEMENT';
  const status = document.createElement('div');
  status.className = 'logobug-live-status';
  status.id = `overlay-position-${randomId()}`;
  status.setAttribute('aria-live', 'polite');
  selection.setAttribute('aria-describedby', status.id);
  toolbar.append(title, status);

  const coordinates = document.createElement('div');
  coordinates.className = 'logobug-live-coordinates';
  function coordinateField(labelText) {
    const label = document.createElement('label');
    label.className = 'logobug-live-field logobug-live-coordinate';
    label.append(document.createTextNode(labelText));
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min: '0', max: '100', step: '0.1', inputMode: 'decimal' });
    label.appendChild(input);
    coordinates.appendChild(label);
    return input;
  }
  const xInput = coordinateField('X %');
  const yInput = coordinateField('Y %');
  toolbar.appendChild(coordinates);

  const actions = document.createElement('div');
  actions.className = 'logobug-live-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'CANCEL';
  const apply = document.createElement('button');
  apply.type = 'button'; apply.className = 'btn btn-primary'; apply.textContent = 'APPLY PLACEMENT';
  actions.append(cancel, apply);
  toolbar.appendChild(actions);

  function bounds() {
    if (!overlay.clientWidth || !overlay.clientHeight) return { maxX: 100, maxY: 100 };
    return { maxX: Math.max(0, 100 - size / overlay.clientWidth * 100), maxY: Math.max(0, 100 - size / overlay.clientHeight * 100) };
  }
  function render(echoAll = false) {
    const { maxX, maxY } = bounds();
    x = Math.round(Math.min(maxX, Math.max(0, x)) * 10) / 10;
    y = Math.round(Math.min(maxY, Math.max(0, y)) * 10) / 10;
    Object.assign(selection.style, { left: `${x}%`, top: `${y}%`, width: `${size}px`, height: `${size}px` });
    status.textContent = `X ${x.toFixed(1)}%  Y ${y.toFixed(1)}%`;
    if (echoAll || document.activeElement !== xInput) xInput.value = x.toFixed(1);
    if (echoAll || document.activeElement !== yInput) yInput.value = y.toFixed(1);
  }
  // A blank or unparseable value keeps the current coordinate instead of snapping it to 0.
  function setPosition(nextX, nextY) {
    const nx = Number(nextX); const ny = Number(nextY);
    if (Number.isFinite(nx)) x = nx;
    if (Number.isFinite(ny)) y = ny;
    render();
  }

  // Typing is applied live but the field being typed in is not rewritten under the
  // cursor; leaving it (change) echoes the clamped, rounded value.
  const typed = (input, apply) => {
    input.addEventListener('input', () => { if (input.value.trim() !== '') apply(input.value); });
    input.addEventListener('change', () => { if (input.value.trim() !== '') apply(input.value); render(true); });
  };
  typed(xInput, (value) => setPosition(value, y));
  typed(yInput, (value) => setPosition(x, value));
  selection.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 5 : 0.5;
    let nextX = x; let nextY = y;
    if (event.key === 'ArrowLeft') nextX -= step;
    else if (event.key === 'ArrowRight') nextX += step;
    else if (event.key === 'ArrowUp') nextY -= step;
    else if (event.key === 'ArrowDown') nextY += step;
    else return;
    event.preventDefault(); setPosition(nextX, nextY);
  });
  selection.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = overlay.getBoundingClientRect();
    const selectionRect = selection.getBoundingClientRect();
    const offsetX = event.clientX - selectionRect.left;
    const offsetY = event.clientY - selectionRect.top;
    const pointerId = event.pointerId;
    const move = (nextEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      setPosition(((nextEvent.clientX - offsetX - rect.left) / rect.width) * 100, ((nextEvent.clientY - offsetY - rect.top) / rect.height) * 100);
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
  });

  let closing = false;
  async function close(keepChanges) {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove(); toolbar.remove();
    if (keepChanges) onApply(x, y);
    await showSetupScreen();
    requestAnimationFrame(() => { if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus(); });
  }
  function onKeyDown(event) { if (event.key === 'Escape') { event.preventDefault(); close(false); } }
  document.addEventListener('keydown', onKeyDown);
  cancel.addEventListener('click', () => close(false));
  apply.addEventListener('click', () => close(true));
  crt.appendChild(overlay); app.appendChild(toolbar); render(); selection.focus({ preventScroll: true });
}
