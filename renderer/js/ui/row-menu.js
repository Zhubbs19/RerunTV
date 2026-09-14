// RowMenu — a row's ⋯ actions menu (docs/design/03 §5.3). Collection rows keep
// one line; their actions live here. Groups are separated by a rule, and the
// last group is where destructive actions go (styled danger).
//
//   const menu = RowMenu({
//     label: 'Actions for CH 7',
//     groups: [
//       [{ label: 'Move up', run: () => …, disabled: false, title: 'Already first' }],
//       [{ label: 'Remove', run: () => …, danger: true }],
//     ],
//   });
//   row.appendChild(menu.button);
//   row.addEventListener('contextmenu', menu.openAt);   // right-click
//
// ▲▼ Home End move between items, Enter/Space runs one, Esc or a click
// outside closes and returns focus to the ⋯ button. Shift+F10 or the
// ContextMenu key on a row opens its menu (openRowMenuFor).

let openMenu = null;

function closeOpenMenu({ restoreFocus = false } = {}) {
  if (!openMenu) return;
  const { popup, button } = openMenu;
  popup.remove();
  button.setAttribute('aria-expanded', 'false');
  openMenu = null;
  if (restoreFocus) button.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.popup.contains(event.target) && !openMenu.button.contains(event.target)) closeOpenMenu();
}, true);
window.addEventListener('blur', () => closeOpenMenu());
document.addEventListener('scroll', () => closeOpenMenu(), true);

export function RowMenu({ label, groups }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn row-menu-btn';
  button.textContent = '⋯';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  function open(point = null) {
    const wasThis = openMenu && openMenu.button === button;
    closeOpenMenu();
    if (wasThis && !point) return;
    const popup = document.createElement('div');
    popup.className = 'row-menu';
    popup.setAttribute('role', 'menu');
    popup.setAttribute('aria-label', label);
    groups.filter((group) => group.length).forEach((group, index) => {
      if (index > 0) {
        const rule = document.createElement('div');
        rule.className = 'row-menu-rule';
        rule.setAttribute('role', 'separator');
        popup.appendChild(rule);
      }
      group.forEach((item) => {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = `row-menu-item${item.danger ? ' is-danger' : ''}`;
        entry.setAttribute('role', 'menuitem');
        entry.textContent = item.label;
        entry.tabIndex = -1;
        if (item.title) entry.title = item.title; // e.g. why a disabled item can't run
        if (item.disabled) entry.disabled = true;
        entry.addEventListener('click', (event) => {
          event.stopPropagation();
          closeOpenMenu();
          item.run();
        });
        popup.appendChild(entry);
      });
    });
    popup.addEventListener('keydown', (event) => {
      const items = Array.from(popup.querySelectorAll('.row-menu-item:not(:disabled)'));
      const at = items.indexOf(document.activeElement);
      let target = null;
      if (event.key === 'ArrowDown') target = items[(at + 1) % items.length];
      else if (event.key === 'ArrowUp') target = items[(at - 1 + items.length) % items.length];
      else if (event.key === 'Home') target = items[0];
      else if (event.key === 'End') target = items[items.length - 1];
      else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        closeOpenMenu({ restoreFocus: true });
        return;
      }
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      target.focus();
    });
    document.body.appendChild(popup);
    // Fixed position beside the button (or at the pointer), kept on screen.
    const anchor = point || (() => { const r = button.getBoundingClientRect(); return { x: r.right, y: r.bottom + 4, alignRight: true }; })();
    const size = popup.getBoundingClientRect();
    let left = anchor.alignRight ? anchor.x - size.width : anchor.x;
    let top = anchor.y;
    left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
    if (top + size.height > window.innerHeight - 8) top = Math.max(8, (point ? anchor.y : button.getBoundingClientRect().top - 4) - size.height);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    button.setAttribute('aria-expanded', 'true');
    openMenu = { popup, button };
    popup.querySelector('.row-menu-item:not(:disabled)')?.focus({ preventScroll: true });
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    open();
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); open(); }
  });

  return {
    button,
    open: () => open(),
    openAt: (event) => {
      event.preventDefault();
      open({ x: event.clientX, y: event.clientY });
    },
  };
}

// Shift+F10 / the ContextMenu key on a focused row opens that row's ⋯ menu.
document.addEventListener('keydown', (event) => {
  if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
  const row = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-row-menu]');
  const button = row && row.querySelector('.row-menu-btn');
  if (!button) return;
  event.preventDefault();
  button.click();
});
