// Provider-backed media recovery. Kept out of the tune pipeline so polling,
// cancellation, and transient RPC failures have one focused boundary.
import { parseMediaRef } from '../core/channels.js';

/**
 * Asks a media-source plugin how far it is with fetching a ref, swallowing RPC errors.
 * @param {string} source The media-source provider id.
 * @param {string} ref The provider's opaque ref.
 * @returns {Promise<object>} `{ ok, progress }`; `ok` is false when the call failed.
 */
async function tryGetFetchProgress(source, ref) {
  try {
    return { ok: true, progress: await window.api.callMediaSourceHook(source, 'getFetchProgress', ref) };
  } catch (error) {
    return { ok: false, progress: null };
  }
}

/**
 * Waits for a provider-backed file to finish fetching, showing a PREPARING status meanwhile.
 * Local files, and providers that report no progress or fail the first call, count as ready.
 * @param {object} ch The channel config being tuned.
 * @param {object} file The channel file entry (with `source` and `path`).
 * @param {object} callbacks Hooks into the tune pipeline.
 * @param {Function} callbacks.clearPlayer Empties the player before polling starts.
 * @param {Function} callbacks.isActive Returns false once this tune has been superseded.
 * @param {Function} callbacks.markVisualReady Marks the screen as showing something.
 * @param {Function} callbacks.showStatus Shows a status card `(title, detail, kind)`.
 * @param {Function} callbacks.clearStatus Hides the status card.
 * @returns {Promise<boolean>} True when the file is ready, false if the tune was cancelled.
 */
export async function waitForMediaSourceReady(ch, file, callbacks) {
  if (!file.source || file.source === 'local') return true;
  const rawRef = parseMediaRef(file.path).ref;
  const first = await tryGetFetchProgress(file.source, rawRef);
  if (!first.ok || !first.progress || first.progress.ready !== false) return true;
  let progress = first.progress;
  callbacks.clearPlayer();
  while (progress && progress.ready === false) {
    if (!callbacks.isActive()) return false;
    callbacks.markVisualReady();
    const pct = typeof progress.progress === 'number' ? ` — ${Math.round(progress.progress * 100)}%` : '';
    callbacks.showStatus(
      'PREPARING…',
      progress.label ? `CH ${ch.number} — ${progress.label.toUpperCase()}` : `CH ${ch.number} — FETCHING MEDIA${pct}`,
      'transcoding',
    );
    // eslint-disable-next-line no-await-in-loop -- sequential provider polling
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    if (!callbacks.isActive()) return false;
    // A transient RPC failure is not readiness; retain the last progress.
    // eslint-disable-next-line no-await-in-loop
    const next = await tryGetFetchProgress(file.source, rawRef);
    if (next.ok) progress = next.progress;
  }
  callbacks.clearStatus();
  return true;
}
