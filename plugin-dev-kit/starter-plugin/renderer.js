// Renderer half of the starter plugin. Demonstrates a channel
// (registerChannelType) and a settings panel (registerSettingsPanel) — use
// either, both, or neither depending on what your plugin actually needs.
// See PLUGIN_DEVELOPMENT.md for the full API this is built on.

let currentContainer = null;
let clockTimer = null;

function updateClock(ctx) {
  if (!currentContainer) return;
  const el = currentContainer.querySelector('[data-el="clock"]');
  if (el) el.textContent = new Date(ctx.viewNow()).toLocaleTimeString();
}

// --- A channel ---
// number 900 is a placeholder — pick a real, free channel number for your
// own plugin. Numbers already used by core/other plugins: 0 (AUX), 1
// (PREVUE), 2 (PUBLIC ACCESS), 3 (WEATHER), 51, 88, 94-99. A real user
// channel at the same number always wins over a plugin channel, so a
// collision just means your channel silently doesn't show up for anyone
// who happens to have a real channel there — pick something unlikely to be
// used, or make the number itself a settings-panel field.
window.RCBPlugins.registerChannelType('starter-plugin', {
  number: 900,
  label: 'STARTER CHANNEL',
  nowText: 'Hello from a plugin',
  badge: { bg: '#8b5cf6', label: 'NEW' },

  render(container, ctx) {
    currentContainer = container;
    const cfg = ctx.S.config.starterPlugin || {};
    const greeting = cfg.greeting || 'Hello, world!';

    container.innerHTML = `
      <div class="starter-plugin-channel">
        <div class="starter-plugin-greeting">${greeting}</div>
        <div class="starter-plugin-clock" data-el="clock">--:--:--</div>
        <button type="button" class="btn" data-el="ping">PING MAIN PROCESS</button>
        <div class="starter-plugin-status" data-el="status"></div>
      </div>
    `;

    updateClock(ctx);
    clockTimer = setInterval(() => updateClock(ctx), 1000);

    // Calling your own main.js's IPC handler from the renderer requires a
    // matching entry in main/preload.js (a core file) — contextBridge is
    // the only way renderer code reaches ipcMain, and it's a fixed list.
    // This is a real constraint for third-party plugins without a fork of
    // the app: you can call any IPC channel *core* already exposes on
    // window.api, but a channel your own main.js adds needs preload.js
    // support to be reachable. See PLUGIN_DEVELOPMENT.md's "window.api"
    // section. The button below assumes you've added
    // `starterPluginPing: (opts) => ipcRenderer.invoke('starter-plugin:ping', opts)`
    // to preload.js yourself; it'll just report an error otherwise, which
    // is expected out of the box.
    container.querySelector('[data-el="ping"]').addEventListener('click', async () => {
      const statusEl = container.querySelector('[data-el="status"]');
      if (!window.api.starterPluginPing) {
        statusEl.textContent = 'window.api.starterPluginPing isn\'t wired up in preload.js yet — see the comment above this button.';
        return;
      }
      const result = await window.api.starterPluginPing({ hello: 'from renderer' });
      statusEl.textContent = `Main process replied: ${JSON.stringify(result)}`;
    });
  },

  stop() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    currentContainer = null;
  },

  onOk(ctx) {
    // Called on Enter/Space (or a remote's OK button) while this channel is
    // tuned in. Return true if you handled it.
    if (currentContainer) {
      updateClock(ctx);
      return true;
    }
    return false;
  },
});

// --- A settings panel ---
window.RCBPlugins.registerSettingsPanel('starter-plugin', {
  render(container, ctx) {
    if (!ctx.S.config.starterPlugin) ctx.S.config.starterPlugin = {};
    const cfg = ctx.S.config.starterPlugin;

    container.innerHTML = `
      <label class="panel-toggle">STARTER PLUGIN</label>
      <div class="panel-body">
        <input type="text" data-el="greeting" class="title-row-input" placeholder="Hello, world!" maxlength="60">
      </div>
      <span class="panel-status">Whatever you type here shows on the STARTER CHANNEL (900).</span>
    `;

    const greetingEl = container.querySelector('[data-el="greeting"]');
    greetingEl.value = cfg.greeting || '';
    greetingEl.addEventListener('input', () => {
      cfg.greeting = greetingEl.value;
      ctx.saveConfigDebounced();
    });
  },
});
