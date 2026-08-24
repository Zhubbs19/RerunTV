// Provider-backed media recovery. Kept out of the tune pipeline so polling,
// cancellation, and transient RPC failures have one focused boundary.
import { parseMediaRef } from './channels.js';

async function tryGetFetchProgress(source, ref) {
  try {
    return { ok: true, progress: await window.api.callMediaSourceHook(source, 'getFetchProgress', ref) };
  } catch (error) {
    return { ok: false, progress: null };
  }
}

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
