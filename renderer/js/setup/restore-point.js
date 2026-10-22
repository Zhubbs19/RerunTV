// A named restore point taken just before a change that rewrites a lot at once
// (applying a preset, importing a config / settings / channel, relinking a
// folder). Undo covers the current setup session; this covers "I closed setup
// and only then noticed". Shows up in SETTINGS › Backups with its reason.
//
// The renderer's in-memory config is flushed first, so the snapshot is what is
// on screen and not whatever the debounced save last wrote. Never blocks the
// change: a failure here just means no restore point.
import { saveConfigNow } from '../core/state.js';

export async function takeRestorePoint(reason) {
  try {
    await saveConfigNow();
    if (window.api && typeof window.api.createBackupNow === 'function') await window.api.createBackupNow(reason);
  } catch (e) {
    console.warn('[restore point]', e && e.message);
  }
}
