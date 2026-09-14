// Background work in the setup status bar (docs/design/03 §4): folder scans,
// library sync and health checks keep reporting there while you move to
// another section, instead of only on the page that started them.
import { StatusBar } from './ui/toast.js';

const statusBar = StatusBar({ taskEl: document.getElementById('setup-task-status') });

// Starts a task line. update() changes its text; end() removes it.
export function beginTask(label) {
  return statusBar.beginTask(label);
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
