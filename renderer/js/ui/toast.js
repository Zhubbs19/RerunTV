// Toast and StatusBar (docs/design/04 §3).
//
// Toast: a one-line transient readout in a fixed spot (the TV's centre-screen
// flash, a setup confirmation). Each caller names its own timer key, so two
// features flashing near each other don't cut each other off.
//
// StatusBar: the setup screen's pinned bar — save state and background tasks
// (folder scans, library sync, health checks) that keep reporting while you
// move to another section.
import { h } from './kit-core.js';

// ---------- Pure ----------
// The one line a status bar shows for the running tasks, newest first.
export function taskLine(labels) {
  if (!labels.length) return '';
  const latest = labels[labels.length - 1];
  return labels.length > 1 ? `${latest} (+${labels.length - 1} MORE)` : latest;
}

export function saveStateText(state) {
  return state === 'saving' ? 'SAVING…' : 'SAVED';
}

// ---------- DOM ----------
const timers = new Map();

// Toast(text, { element, key, duration, className }) shows text in element
// (adding className) and hides it after duration unless shown again first.
export function Toast(text, { element, key = 'default', duration = 1500, className = 'show' } = {}) {
  if (!element) return;
  element.textContent = text;
  element.classList.add(className);
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); element.classList.remove(className); }, duration));
}

// StatusBar({ saveEl, taskEl }) → { setSaveState(state), beginTask(label) }.
// Missing elements (the LAN viewer has no setup screen) make it a no-op.
export function StatusBar({ saveEl = null, taskEl = null } = {}) {
  const tasks = new Map();
  let nextTaskId = 1;
  let textEl = taskEl && taskEl.querySelector('.setup-task-text');
  if (taskEl && !textEl) {
    taskEl.append(h('span', { className: 'setup-task-spinner', attrs: { 'aria-hidden': 'true' } }), (textEl = h('span', { className: 'setup-task-text' })));
  }
  const renderTasks = () => {
    if (!taskEl) return;
    const labels = Array.from(tasks.values());
    taskEl.hidden = labels.length === 0;
    textEl.textContent = taskLine(labels);
  };
  return {
    setSaveState(state) {
      if (!saveEl) return;
      const wasSaving = saveEl.dataset.state === 'saving';
      saveEl.dataset.state = state;
      saveEl.textContent = saveStateText(state);
      if (wasSaving && state !== 'saving') {
        saveEl.classList.remove('save-pulse');
        void saveEl.offsetWidth; // restart the pulse animation
        saveEl.classList.add('save-pulse');
      }
    },
    // Starts a task line. update() changes its text; end() removes it.
    beginTask(label) {
      const id = nextTaskId++;
      tasks.set(id, label);
      renderTasks();
      return {
        update(text) { if (tasks.has(id)) { tasks.set(id, text); renderTasks(); } },
        end() { tasks.delete(id); renderTasks(); },
      };
    },
  };
}
