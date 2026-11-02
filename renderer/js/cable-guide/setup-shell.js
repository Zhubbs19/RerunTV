// Channel Setup on the cable-guide layout. The setup screen keeps its own
// markup and behaviour; this adds what the layout's header rule needs:
//
// - The page header reads like a guide header: the section on line 1, the
//   focused or pointed-at setting (highlight colour) on line 2, and that
//   setting's one-line help on line 3. Each row's own help paragraph is
//   hidden by cable-guide.css but stays in the DOM, where settings search
//   reads it.
// - The messages envelope and the clock sit at the top right.
// - Section, page and channel-tab labels, buttons and choices read in title
//   case ("PICTURE & SOUND" → "Picture & Sound"). The legacy text is kept and
//   put back when a legacy theme is chosen.
import { S, viewNow } from '../core/state.js';
import { registerCoreHook } from '../plugin/host.js';
import { CABLE_GUIDE_UI, guideClock, menuLabel } from './model.js';
import { currentUiMode } from './mode.js';
import { currentMessageCount } from './page.js';

const ENVELOPE = '<svg viewBox="0 0 26 20" aria-hidden="true"><path d="M1 2h24v16H1zM3 4v.6l10 7 10-7V4zm0 3.1V16h20V7.1l-10 7z"/></svg>';
const LABELLED = '.setup-tab-btn, .setup-subtab-btn, .edit-tab-btn, .setup-title, .btn, option, .setup-sidebar-watch-label, .setup-view-btn';
// Buttons and choices are relabelled only while their text is all caps (the
// legacy house style): a file name or anything the viewer typed is left as is.
const ALWAYS = '.setup-tab-btn, .setup-subtab-btn, .edit-tab-btn, .setup-title';

const on = () => currentUiMode() === CABLE_GUIDE_UI;

// Only the element's own text nodes change, so badges and counts appended as
// child elements are left alone. Text the app writes later (the page title
// on every section switch) is new legacy text, told apart from ours by the
// title-cased copy kept beside it.
function relabel(el) {
  const node = Array.from(el.childNodes).find((n) => n.nodeType === 3 && /[A-Za-z]/.test(n.data));
  if (!node) return;
  if (on()) {
    const fresh = el.dataset.legacyLabel === undefined || node.data !== el.dataset.cgLabel;
    if (fresh && /[a-z]/.test(node.data) && !el.matches(ALWAYS)) return;
    if (fresh) el.dataset.legacyLabel = node.data;
    // Keep the spaces around the words (" WATCH TV" follows its ▶ icon).
    const legacy = el.dataset.legacyLabel;
    const next = legacy.match(/^\s*/)[0] + menuLabel(legacy) + legacy.match(/\s*$/)[0];
    el.dataset.cgLabel = next;
    if (node.data !== next) node.data = next;
  } else if (el.dataset.legacyLabel !== undefined) {
    if (node.data === el.dataset.cgLabel) node.data = el.dataset.legacyLabel;
    delete el.dataset.legacyLabel;
    delete el.dataset.cgLabel;
  }
}

function rowText(row) {
  const label = row.querySelector('.setting-row-label');
  const help = row.querySelector('.setting-row-help');
  return {
    name: label ? label.textContent.trim() : '',
    help: (help && help.textContent.trim()) || row.title || '',
  };
}

export function installSetupShell() {
  const screen = document.getElementById('setup-screen');
  const header = screen && screen.querySelector('.setup-header');
  const nav = screen && screen.querySelector('.setup-nav');
  if (!header || !nav) return;

  const focus = document.createElement('div');
  focus.className = 'cg-setup-focus';
  focus.innerHTML = '<div class="cg-setup-name"></div><div class="cg-setup-help"></div>';
  header.appendChild(focus);
  const nameEl = focus.querySelector('.cg-setup-name');
  const helpEl = focus.querySelector('.cg-setup-help');
  const pageHelp = document.getElementById('setup-page-description');

  const status = document.createElement('div');
  status.className = 'cg-setup-status';
  status.innerHTML = `<span class="cg-messages hidden" title="Messages">${ENVELOPE}</span><span class="cg-clock"></span>`;
  nav.insertBefore(status, nav.querySelector('.setup-search-wrap'));
  const clockEl = status.querySelector('.cg-clock');
  const mailEl = status.querySelector('.cg-messages');

  // Nothing focused: the page's own description stands in as line 3.
  const showPage = () => {
    nameEl.textContent = '';
    helpEl.textContent = pageHelp ? pageHelp.textContent : '';
  };
  const showRow = (row) => {
    const { name, help } = rowText(row);
    nameEl.textContent = name;
    helpEl.textContent = help;
  };
  const showButton = (btn) => {
    const name = btn.textContent.trim();
    if (!name) return;
    nameEl.textContent = name;
    helpEl.textContent = btn.title || btn.getAttribute('aria-label') || '';
  };
  const follow = (target) => {
    if (!on() || !target || !target.closest) return;
    const row = target.closest('.setting-row');
    if (row) { showRow(row); return; }
    const btn = target.closest('button, a[href]');
    if (btn && screen.contains(btn)) showButton(btn);
  };
  screen.addEventListener('focusin', (e) => follow(e.target));
  screen.addEventListener('pointerover', (e) => follow(e.target));
  screen.addEventListener('focusout', (e) => { if (!screen.contains(e.relatedTarget)) showPage(); });

  // A new page or section resets the header to that page.
  if (pageHelp) new MutationObserver(showPage).observe(pageHelp, { childList: true, characterData: true, subtree: true });

  const tick = () => {
    if (!on() || screen.classList.contains('hidden')) return;
    clockEl.textContent = guideClock(new Date(viewNow()), !!S.config?.display?.clock24);
    const count = currentMessageCount();
    mailEl.classList.toggle('hidden', !(count > 0));
    mailEl.title = count > 0 ? `${count} message${count === 1 ? '' : 's'}` : 'Messages';
  };
  setInterval(tick, 15000);

  const relabelAll = (root) => root.querySelectorAll(LABELLED).forEach(relabel);
  // Channel tabs and badges are rebuilt as pages change, and the page title
  // is rewritten on every section switch.
  new MutationObserver((records) => {
    if (!on()) return;
    for (const r of records) {
      if (r.target.nodeType === 1 && r.target.matches(LABELLED)) relabel(r.target);
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(LABELLED)) relabel(n);
        else relabelAll(n);
      }
    }
  }).observe(screen, { childList: true, subtree: true });

  const refresh = () => {
    relabelAll(screen);
    showPage();
    tick();
  };
  registerCoreHook('ui-mode-change', refresh);
  // Opening setup is a click away from any state; read the time then.
  new MutationObserver(() => { if (!screen.classList.contains('hidden')) tick(); })
    .observe(screen, { attributes: true, attributeFilter: ['class'] });
  refresh();
}
