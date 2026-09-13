// Background work in the setup status bar (docs/design/03 §4): folder scans,
// library sync and health checks keep reporting there while you move to
// another section, instead of only on the page that started them.
const statusEl = document.getElementById('setup-task-status');
const textEl = statusEl && statusEl.querySelector('.setup-task-text');
const tasks = new Map();
let nextId = 1;

function render() {
  if (!statusEl) return;
  const labels = Array.from(tasks.values());
  statusEl.hidden = labels.length === 0;
  if (!labels.length) { textEl.textContent = ''; return; }
  const latest = labels[labels.length - 1];
  textEl.textContent = labels.length > 1 ? `${latest} (+${labels.length - 1} MORE)` : latest;
}

// Starts a task line. update() changes its text; end() removes it.
export function beginTask(label) {
  const id = nextId++;
  tasks.set(id, label);
  render();
  return {
    update(text) { if (tasks.has(id)) { tasks.set(id, text); render(); } },
    end() { tasks.delete(id); render(); },
  };
}

// The channel page's own progress line (#scan-progress) is written from many
// places (add folder, rescan all, batch fixes, relink). Mirror it rather than
// touching each of them: while it is showing, so is the status bar.
const scanProgressEl = document.getElementById('scan-progress');
if (scanProgressEl) {
  let scanTask = null;
  const mirror = () => {
    const text = scanProgressEl.classList.contains('hidden') ? '' : scanProgressEl.textContent.trim();
    if (text && !scanTask) scanTask = beginTask(text);
    else if (text) scanTask.update(text);
    else if (scanTask) { scanTask.end(); scanTask = null; }
  };
  new MutationObserver(mirror).observe(scanProgressEl, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
}
