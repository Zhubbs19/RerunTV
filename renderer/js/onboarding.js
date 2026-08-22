// First-run welcome screen. Shown once, gated on main-config.js's loadConfig
// returning `_isFirstRun: true` (config file didn't exist yet — a genuinely
// fresh install, not just a user who deleted all their channels). Reuses the
// setup-dialogs.js "confirm-dialog" box/backdrop CSS for a consistent look
// rather than inventing a second modal style.

export function showOnboarding() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog';

    const box = document.createElement('div');
    box.className = 'confirm-dialog-box onboarding-box';

    const title = document.createElement('div');
    title.className = 'confirm-dialog-title';
    title.textContent = 'WELCOME TO RETRO CABLE BOX';
    box.appendChild(title);

    const message = document.createElement('div');
    message.className = 'confirm-dialog-message';
    message.textContent = 'This turns your own media library into a channel-surfable cable box, complete with schedules, bumpers, and commercial breaks. A few things to know before you dive in:';
    box.appendChild(message);

    const list = document.createElement('ul');
    list.className = 'onboarding-list';
    [
      'Add a CHANNEL in the setup screen and point it at a media folder — SCAN A FOLDER builds a lineup from your video files automatically.',
      'Optional add-ons (live weather, party mode, and more) live in the PLUGINS tab — everything starts off, install or enable only what you want.',
      'Everything autosaves as you go, with rotating backups — check the BACKUPS panel if you ever need to roll back a change.',
    ].forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    });
    box.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';
    const startBtn = document.createElement('button');
    startBtn.className = 'btn btn-primary';
    startBtn.textContent = 'GET STARTED';
    actions.appendChild(startBtn);
    box.appendChild(actions);

    overlay.appendChild(box);

    const close = () => {
      overlay.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve();
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); }
    };

    startBtn.addEventListener('click', close);
    overlay.addEventListener('keydown', onKeydown);

    document.body.appendChild(overlay);
    startBtn.focus();
  });
}
