// First-run setup. A genuinely new install gets one short orientation page
// and one explicit updater-policy page before reaching Channel Setup. The
// main process deliberately skips its pre-launch update gate on this first
// run so the default is explained before it is enforced.

const UPDATE_CHOICES = [
  {
    value: 'startup-auto', title: 'UPDATE BEFORE RERUNTV OPENS', badge: 'RECOMMENDED',
    detail: 'Check, download, and install first. The full app opens only after it is current. Network errors continue to RerunTV normally.',
  },
  {
    value: 'background-auto', title: 'DOWNLOAD WHILE I WATCH',
    detail: 'Open immediately, download quietly, and install the next time you close RerunTV.',
  },
  {
    value: 'background-notify', title: 'DOWNLOAD, THEN ASK ME',
    detail: 'Open immediately and show a compact notice when the update is ready.',
  },
  {
    value: 'manual', title: 'ONLY WHEN I CHECK',
    detail: 'Never check automatically. Use Help → Software Updates → Check Now.',
  },
  {
    value: 'off', title: 'NEVER CHECK',
    detail: 'Make no update requests. You can change this later from Help.',
  },
];

function makeButton(label, className = 'btn') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

export function showOnboarding({ updateStrategy = 'startup-auto' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog onboarding-screen';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'onboarding-title');

    const box = document.createElement('div');
    box.className = 'confirm-dialog-box onboarding-box';
    overlay.appendChild(box);

    let step = 0;
    let selectedStrategy = updateStrategy;

    function renderWelcome() {
      box.innerHTML = '';
      const kicker = document.createElement('div');
      kicker.className = 'onboarding-kicker';
      kicker.textContent = 'FIRST-TIME SETUP  ·  1 OF 2';
      const title = document.createElement('div');
      title.id = 'onboarding-title';
      title.className = 'confirm-dialog-title onboarding-title';
      title.textContent = 'WELCOME TO RERUNTV';
      const message = document.createElement('div');
      message.className = 'confirm-dialog-message';
      message.textContent = 'Turn your own media library into a channel-surfable cable box. Before building the lineup, here is what RerunTV changes—and what it does not.';
      const list = document.createElement('ul');
      list.className = 'onboarding-list';
      [
        'Your media stays where it is. RerunTV stores paths, schedules, titles, and settings; it does not upload your library.',
        'Channel Setup autosaves and keeps rotating backups. Undo, export, and restore are available from the setup screen.',
        'LAN viewing, phone controls, external metadata, and other integrations are optional plugins or opt-in services.',
      ].forEach((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        list.appendChild(item);
      });
      const actions = document.createElement('div');
      actions.className = 'confirm-dialog-actions';
      const next = makeButton('CONTINUE', 'btn btn-primary');
      next.addEventListener('click', () => { step = 1; renderUpdates(); });
      actions.appendChild(next);
      box.append(kicker, title, message, list, actions);
      next.focus();
    }

    function renderUpdates() {
      box.innerHTML = '';
      const kicker = document.createElement('div');
      kicker.className = 'onboarding-kicker';
      kicker.textContent = 'FIRST-TIME SETUP  ·  2 OF 2';
      const title = document.createElement('div');
      title.id = 'onboarding-title';
      title.className = 'confirm-dialog-title onboarding-title';
      title.textContent = 'CHOOSE HOW RERUNTV UPDATES';
      const message = document.createElement('div');
      message.className = 'confirm-dialog-message';
      message.textContent = 'The recommended default updates before the full app launches, so you never start a viewing session only to restart moments later. You remain in control and can change this from Help at any time.';
      const choices = document.createElement('div');
      choices.className = 'onboarding-update-choices';
      UPDATE_CHOICES.forEach((choice) => {
        const label = document.createElement('label');
        label.className = 'onboarding-update-choice';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'onboarding-update-strategy';
        radio.value = choice.value;
        radio.checked = choice.value === selectedStrategy;
        radio.addEventListener('change', () => { selectedStrategy = choice.value; });
        const copy = document.createElement('span');
        copy.className = 'onboarding-update-copy';
        const heading = document.createElement('strong');
        heading.textContent = choice.title;
        if (choice.badge) {
          const badge = document.createElement('em');
          badge.textContent = choice.badge;
          heading.append(' ', badge);
        }
        const detail = document.createElement('span');
        detail.textContent = choice.detail;
        copy.append(heading, detail);
        label.append(radio, copy);
        choices.appendChild(label);
      });
      const actions = document.createElement('div');
      actions.className = 'confirm-dialog-actions onboarding-actions';
      const back = makeButton('BACK');
      const finish = makeButton('SAVE & OPEN CHANNEL SETUP', 'btn btn-primary');
      back.addEventListener('click', () => { step = 0; renderWelcome(); });
      finish.addEventListener('click', () => {
        overlay.removeEventListener('keydown', onKeydown);
        overlay.remove();
        resolve({ updateStrategy: selectedStrategy || 'startup-auto' });
      });
      actions.append(back, finish);
      box.append(kicker, title, message, choices, actions);
      choices.querySelector('input:checked')?.focus();
    }

    function onKeydown(event) {
      if (event.key !== 'Enter' || event.target?.matches('button')) return;
      event.preventDefault();
      box.querySelector('.btn-primary')?.click();
    }

    overlay.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    renderWelcome();
  });
}
