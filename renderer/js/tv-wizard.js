// First run on a TV (docs/design/01 §6.5): Welcome → add channels (on a phone
// or computer, or from a folder on this device) → update policy → remote
// check → live TV. Everything is reachable with D-pad + OK; the remote check
// ("Press OK… Press BACK… Hold OK") is what seeds this device's remote profile.
import { tvScreen } from './dom.js';
import { REMOTE_CHECK, WIZARD_STEPS, advanceRemoteCheck, nextWizardStep } from './tv-setup-model.js';
import { remoteProfile, setRemoteInputSink } from './tv-input.js';
import { Button } from './ui/button.js';
import { ModalSurface } from './ui/dialog.js';

const UPDATE_CHOICES = [
  { value: 'startup-auto', label: 'INSTALL AUTOMATICALLY', help: 'Check before RerunTV opens and install straight away.' },
  { value: 'background-notify', label: 'ASK WHEN READY', help: 'Check in the background and ask before installing.' },
  { value: 'manual', label: 'ONLY WHEN I ASK', help: 'Never check on its own.' },
];

const REMOTE_CHECK_TIMEOUT_MS = 30000;
const KEYBOARD_HOLD_MS = 500;

let overlay = null;
let surface = null;
let goBack = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, onPress, { isDefault = false } = {}) {
  return Button({ label, onPress, isDefault, bare: true, className: 'tv-wizard-btn' });
}

// options: { updateStrategy, addFolderChannel(): Promise<number|null> | null }
// Resolves { updateStrategy, channelsAdded }.
export function showTvWizard({ updateStrategy = 'startup-auto', addFolderChannel = null } = {}) {
  return new Promise((resolve) => {
    let step = WIZARD_STEPS[0];
    let strategy = updateStrategy;
    let channelsAdded = 0;
    let checkTimer = null;

    surface = ModalSurface({ className: 'tv-wizard', label: 'Set up RerunTV', host: () => tvScreen.querySelector('.crt') || tvScreen, onCancel: () => { if (goBack) goBack(); } });
    overlay = surface.el;
    const panel = el('div', 'tv-wizard-panel');
    overlay.appendChild(panel);

    const finish = () => {
      clearTimeout(checkTimer);
      setRemoteInputSink(null);
      surface.close();
      surface = null;
      overlay = null;
      goBack = null;
      resolve({ updateStrategy: strategy, channelsAdded });
    };

    const go = (next) => {
      step = next;
      render();
    };

    goBack = () => {
      const i = WIZARD_STEPS.indexOf(step);
      if (step === 'remote') return; // the check owns every button
      if (i > 0) go(WIZARD_STEPS[i - 1]);
    };

    function frame(kicker, title, message) {
      panel.innerHTML = '';
      const i = WIZARD_STEPS.indexOf(step);
      panel.append(
        el('div', 'tv-wizard-kicker', `${kicker}  ·  ${Math.min(i + 1, WIZARD_STEPS.length - 1)} OF ${WIZARD_STEPS.length - 1}`),
        el('div', 'tv-wizard-title', title),
        el('div', 'tv-wizard-message', message),
      );
      const actions = el('div', 'tv-wizard-actions');
      panel.appendChild(actions);
      return actions;
    }

    function render() {
      if (step === 'welcome') {
        const actions = frame('WELCOME', 'WELCOME TO RERUNTV', 'Your own videos, playing like a cable box that has always been on. Everything here works with your remote: the arrows move, OK picks, BACK goes back.');
        actions.appendChild(button('GET STARTED', () => go(nextWizardStep(step)), { isDefault: true }));
      } else if (step === 'channels') {
        const actions = frame('CHANNELS', 'ADD YOUR CHANNELS', 'Channels are folders of videos. Adding folders is easiest on a phone or computer; you can also pick one on this device.');
        const qrArea = el('div', 'tv-wizard-qr');
        actions.appendChild(button('ON MY PHONE OR COMPUTER', async () => {
          qrArea.textContent = 'Looking for this box\'s address…';
          let info = null;
          try { info = window.api && window.api.getHandoffInfo ? await window.api.getHandoffInfo() : null; } catch (e) { info = null; }
          qrArea.innerHTML = '';
          if (info && info.qrDataUrl) {
            const img = document.createElement('img');
            img.src = info.qrDataUrl;
            img.alt = `QR code for ${info.url}`;
            qrArea.appendChild(img);
          }
          qrArea.appendChild(el('div', 'tv-wizard-url', (info && info.url) || 'Turn on the Companion app in Settings to add channels from another device.'));
        }, { isDefault: true }));
        if (addFolderChannel) {
          actions.appendChild(button('USE A FOLDER ON THIS DEVICE', async () => {
            const number = await addFolderChannel();
            if (number != null) {
              channelsAdded += 1;
              qrArea.textContent = `Added CH ${number}. Add another, or continue.`;
            }
          }));
        }
        actions.appendChild(button('CONTINUE', () => go(nextWizardStep(step))));
        panel.appendChild(qrArea);
      } else if (step === 'updates') {
        const actions = frame('UPDATES', 'HOW SHOULD RERUNTV UPDATE?', 'You can change this later in Setup.');
        UPDATE_CHOICES.forEach((choice) => {
          const b = button(`${choice.value === strategy ? '● ' : ''}${choice.label}`, () => { strategy = choice.value; go(nextWizardStep(step)); }, { isDefault: choice.value === strategy });
          b.title = choice.help;
          actions.appendChild(b);
        });
      } else if (step === 'remote') {
        frame('REMOTE', 'LET\'S CHECK YOUR REMOTE', 'Follow the prompt. This teaches RerunTV which buttons your remote has.');
        const promptEl = el('div', 'tv-wizard-prompt', REMOTE_CHECK[0].prompt);
        panel.appendChild(promptEl);
        let index = 0;
        let okDownAt = null;
        const complete = (skipped) => {
          clearTimeout(checkTimer);
          setRemoteInputSink(null);
          promptEl.textContent = skipped ? 'Skipped — you can run REMOTE TEST from the TV menu later.' : 'All set!';
          setTimeout(() => go(nextWizardStep('remote')), 900);
        };
        checkTimer = setTimeout(() => complete(true), REMOTE_CHECK_TIMEOUT_MS);
        setRemoteInputSink((info) => {
          if (info.remoteKey) remoteProfile().note(info.remoteKey);
          // A keyboard has no long-press flag: a held key repeats instead.
          let longPress = !!info.longPress;
          if (info.source === 'keyboard' && info.remoteKey === 'ok') {
            if (!info.repeat) okDownAt = info.at;
            else if (okDownAt != null && info.at - okDownAt >= KEYBOARD_HOLD_MS) longPress = true;
            else return;
          }
          if (info.action === 'up') return;
          const next = advanceRemoteCheck(index, { remoteKey: info.remoteKey, longPress });
          if (next === index) return;
          index = next;
          okDownAt = null;
          if (index >= REMOTE_CHECK.length) complete(false);
          else promptEl.textContent = REMOTE_CHECK[index].prompt;
        });
        return;
      } else {
        const actions = frame('DONE', 'YOU\'RE ALL SET', channelsAdded
          ? 'Your channels are on the air. Hold OK or press Play/Pause any time for the TV menu.'
          : 'Add channels from your phone or computer whenever you\'re ready. Hold OK or press Play/Pause any time for the TV menu.');
        actions.appendChild(button('WATCH TV', finish, { isDefault: true }));
      }
      if (surface.isOpen()) surface.refocus(); else surface.open();
    }

    render();
  });
}

