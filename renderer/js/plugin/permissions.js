// What a plugin can do, in plain words, for the approval prompt and the
// plugin's page in PLUGINS (setup/plugins.js). Pure: it reads only the
// plugin entry plugins:list returns (manifest fields, normalized
// capabilities, integrity status), so it can be tested without a DOM.
//
// Each section is { id, heading, tone, lines: [{ text, why }] }. `tone` is
// 'ok', 'warn' or 'danger', and decides how loudly the screen shows it. The
// raw manifest entries are kept separately in `technical`, for a Details
// fold, so nothing the plugin declares is hidden.

const SYSTEM_ACTIONS = {
  'shell.openExternal': 'Open web links in your browser',
  'desktopCapturer.getSources': 'See what is on your screens and windows (to capture them)',
};

function caps(p) {
  return p.capabilities || {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function describePermissions(p) {
  const c = caps(p);
  const sections = [];
  const hasBackground = !!p.main;

  // Where its background code runs.
  if (hasBackground && p.isolated) {
    sections.push({
      id: 'where', heading: 'Where it runs', tone: 'ok',
      lines: [{ text: 'In its own sandboxed process, held to the files and programs below.' }],
    });
  } else if (hasBackground) {
    sections.push({
      id: 'where', heading: 'Where it runs', tone: 'danger',
      lines: [{ text: 'Inside RerunTV, with full access to your computer: your files, programs and network. Nothing below limits it.' }],
    });
  }

  // Its on-screen part shares RerunTV's window.
  if (p.renderer || p.settings) {
    sections.push({
      id: 'screen', heading: 'On screen', tone: 'warn',
      lines: [{ text: 'Its on-screen part runs in RerunTV’s own window, so it can see and change everything there, like any add-on you install.' }],
    });
  }

  // The internet.
  const internet = list(c.internet);
  if (hasBackground && internet.length) {
    const anywhere = internet.find((e) => e.host === '*');
    const named = internet.filter((e) => e.host !== '*');
    const lines = [];
    if (anywhere) lines.push({ text: 'Any site on the internet or your network', why: anywhere.why });
    named.forEach((e) => lines.push({ text: e.host.startsWith('*.') ? `${e.host.slice(2)} and its subdomains` : e.host, why: e.why }));
    if (p.isolated && list(c.spawn).length) {
      lines.push({ text: 'Programs it runs (below) are separate and aren’t held to this list.' });
    }
    sections.push({
      id: 'internet', heading: anywhere ? 'Internet: any site' : 'Internet: only these sites', tone: anywhere ? 'warn' : 'ok', lines,
    });
  } else if (hasBackground && p.isolated) {
    sections.push({
      id: 'internet', heading: 'Internet', tone: 'warn',
      lines: [{ text: 'It didn’t say which sites it connects to, so it isn’t limited to any. You can still see where it connects on its page.' }],
    });
  }

  // Files (isolated plugins only; a full-access plugin has all of them).
  if (hasBackground && p.isolated) {
    const lines = [];
    lines.push({ text: p.dataDir ? `Read and save files in its own folder (userData\\${p.dataDir})` : 'Read its own files; it can’t save any' });
    if (p.userPaths) lines.push({ text: 'Read and save files in folders you choose for it in its settings' });
    sections.push({ id: 'files', heading: 'Files', tone: 'ok', lines });
  }

  // Everything else it declared, each with the author's reason.
  const spawn = list(c.spawn);
  if (spawn.length) {
    sections.push({
      id: 'programs', heading: 'Programs it runs', tone: 'warn',
      lines: spawn.map((e) => ({ text: String(e.bin), why: e.why })),
    });
  }
  const ports = list(c.net);
  if (ports.length) {
    sections.push({
      id: 'ports', heading: 'Network ports it opens', tone: 'ok',
      lines: ports.map((e) => ({ text: `Port ${e.port}`, why: e.why })),
    });
  }
  const system = list(c.system);
  if (system.length) {
    sections.push({
      id: 'system', heading: 'System actions', tone: 'warn',
      lines: system.map((e) => ({ text: SYSTEM_ACTIONS[e.action] || e.action, why: e.why })),
    });
  }
  const media = list(c.mediaSource);
  if (media.length) {
    sections.push({
      id: 'media', heading: 'Channel media', tone: 'ok',
      lines: media.map((e) => ({ text: `Supplies channel videos as “${e.displayName || e.providerId}”`, why: e.why })),
    });
  }

  // Where it came from.
  const fingerprint = typeof p.integrityHash === 'string' ? p.integrityHash.slice(0, 12) : '';
  let origin;
  if (p.integrityStatus === 'bundled') origin = { text: 'Built into RerunTV.', tone: 'ok' };
  else if (p.integrityStatus === 'verified') origin = { text: `Installed by you. Its files haven’t changed since you trusted them (fingerprint ${fingerprint}).`, tone: 'ok' };
  else if (p.integrityStatus === 'modified') origin = { text: `Its files changed after you trusted them (fingerprint now ${fingerprint}).`, tone: 'danger' };
  else origin = { text: `Copied in by hand and not yet trusted (fingerprint ${fingerprint}).`, tone: 'warn' };
  sections.push({ id: 'origin', heading: 'Where it came from', tone: origin.tone, lines: [{ text: origin.text }] });

  const technical = [
    ...list(c.ipc).map((e) => `Background channel "${e.channel}" — ${e.why}`),
    ...spawn.map((e) => `spawn ${e.bin}`),
    ...ports.map((e) => `net ${e.port}`),
    ...internet.map((e) => `internet ${e.host}`),
    ...system.map((e) => `system ${e.action}`),
    ...media.map((e) => `mediaSource ${e.providerId}`),
  ];
  return { sections, technical, fullAccess: hasBackground && !p.isolated };
}

// The activity record from plugins:activity (main/plugins/bridge.js), in the
// same plain shape. `p` decides what can be said: a full-access plugin's
// connections aren't watched at all.
export function describeActivity(p, activity) {
  const a = activity || {};
  const lines = [];
  if (!p.main) return [{ text: 'It has no background part, so there is nothing to show.', tone: 'ok' }];
  const calls = Number(a.calls) || 0;
  lines.push({ text: calls ? `Its on-screen part called its background part ${calls} ${calls === 1 ? 'time' : 'times'}.` : 'No calls from its on-screen part yet.', tone: 'ok' });
  if (a.refused) lines.push({ text: `${a.refused} ${a.refused === 1 ? 'call was' : 'calls were'} refused (not one of its approved channels).`, tone: 'warn' });
  if (!p.isolated) {
    lines.push({ text: 'Its connections aren’t watched: it runs inside RerunTV, not in a sandbox.', tone: 'warn' });
    return lines;
  }
  const hosts = Array.isArray(a.hosts) ? a.hosts : [];
  const blocked = Array.isArray(a.blocked) ? a.blocked : [];
  lines.push({
    text: hosts.length ? `Connected to: ${hosts.map((h) => `${h.host} (${h.count})`).join(', ')}` : 'Hasn’t connected anywhere yet.',
    tone: 'ok',
  });
  if (blocked.length) {
    lines.push({ text: `Blocked from: ${blocked.map((h) => `${h.host} (${h.count})`).join(', ')}`, tone: 'danger' });
  }
  return lines;
}
